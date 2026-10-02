// 审批服务：挂起 Promise + 事件桥；「帮我审批」模式下先交 AI 预审，拒绝/失败则退回用户审批。

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "@/shared/contracts/approval";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
import type { ModelRef, PermissionMode } from "@/shared/contracts/common";
import type { Settings } from "@/shared/contracts/settings";
import type { AiApprover, AiApproverResult } from "./ai-approver";

export interface ApprovalServiceDeps {
  getSettings: () => Promise<Settings>;
  /** 发往渲染进程的事件；带会话 id（审批也要能落到后台会话上） */
  emit: (payload: ChatEventEnvelope) => void;
  /** AI 审批器（「帮我审批」模式用）；未注入时该模式退化为用户审批卡 */
  aiApprover?: AiApprover;
}

export interface ApprovalService {
  /** 发起审批并等待决定（挂起 Promise，由 respond() 唤醒） */
  request(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsText: string;
    risk: "low" | "high";
    /** 会话工作目录：AI 预审据此判断操作是否越出项目范围 */
    workingDir?: string;
    /** 命令黑名单命中的警示文案；只用于卡片展示，不参与任何判定 */
    warning?: string;
    /** 会话实际使用的模型：AI 预审用它，缺省时审批器回落默认模型 */
    modelRef?: ModelRef;
    /**
     * 这条请求是不是来自**子智能体子会话**（`kind === "subagent"` 的隐藏会话）。
     *
     * 只用来算生效档位（见 effectivePermissionMode），其余判定一律不看它。
     * 缺省 false：老调用点与测试不传就是主会话语义。
     */
    isSubagent?: boolean;
    /** Native tool invocation cancellation, including the settings-loading admission window. */
    signal?: AbortSignal;
  }): Promise<ApprovalDecision>;
  /** 渲染进程回传决定 */
  respond(id: string, decision: ApprovalDecision, note?: string): void;
  /** 待审批列表（会话切换时恢复 UI） */
  pending(sessionId?: string): ApprovalRequest[];
  /** 停止运行时清理该会话挂起的审批（按 deny 处理） */
  cancelSession(sessionId: string): void;
  /** 审批历史（最近 N 条，内存即可） */
  history(): ApprovalRecord[];
}

/** 内存审批历史条数上限 */
const HISTORY_LIMIT = 50;

interface PendingApproval {
  request: ApprovalRequest;
  toolCallId: string;
  promise: Promise<ApprovalDecision>;
  resolve: (decision: ApprovalDecision) => void;
  workingDir?: string;
  cleanupAbort?: () => void;
}

/**
 * 全局权限档 → 本会话**实际生效**的档位。**权限档映射规则只有这一处。**
 *
 * | 全局档位（用户设置） | 主会话 | 子智能体子会话 |
 * | --- | --- | --- |
 * | `default`（默认权限） | default | **ai_review（先交 AI 预审）** |
 * | `ai_review`（帮我审批） | ai_review | ai_review（跟随） |
 * | `full`（完全访问） | full | full（跟随） |
 *
 * 为什么子智能体在「默认权限」下要抬高到 AI 预审：子会话是**侧栏看不见的隐藏会话**
 *（`kind === "subagent"`，被 ipc/sessions.ts 从列表里滤掉），而审批卡只在**当前选中的会话**上渲染
 *（renderer 的 ChatView 按 `item.sessionId === activeSessionId` 过滤）。于是「默认权限」下子智能体
 * 一旦调一个高风险工具，卡片就挂在一个用户打不开的会话里：用户既看不到也没法点，而子智能体
 * 会一直等下去（父会话的 TaskWait 也跟着一起等）。抬高到 AI 预审后，绝大多数只读/常规操作被
 * AI 直接放行；AI 拒绝或调用失败仍照常把卡片交回用户（handBack），行为与「帮我审批」完全一致。
 *
 * 另外两档原样跟随：`ai_review` 本来就是这套流程；`full` 下若映射成别的档反而是**收紧**权限
 *（用户明确选了「完全访问」，主会话不审批而子会话审批是自相矛盾的）。
 *
 * **主会话（isSubagent = false）必须一个字都不变**：无论哪一档都原样返回。
 */
export function effectivePermissionMode(mode: PermissionMode, isSubagent: boolean): PermissionMode {
  if (!isSubagent) return mode;
  return mode === "default" ? "ai_review" : mode;
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const pendingById = new Map<string, PendingApproval>();
  // toolCallId → 未决请求 id，保证同一次工具调用不重复弹卡
  const pendingByToolCall = new Map<string, string>();
  const records: ApprovalRecord[] = [];
  const admissions = new Map<string, Set<{ cancelled: boolean }>>();

  function emitSafe(sessionId: string, event: ChatEvent): void {
    try {
      deps.emit({ sessionId, event });
    } catch (error) {
      console.warn(`发送审批事件失败：${String(error)}`);
    }
  }

  function findPending(toolCallId: string): PendingApproval | undefined {
    const id = pendingByToolCall.get(toolCallId);
    if (id === undefined) return undefined;
    return pendingById.get(id);
  }

  function record(
    entry: PendingApproval,
    decision: ApprovalDecision,
    decidedBy: "user" | "ai",
    note?: string,
  ): void {
    records.unshift({
      request: entry.request,
      decision,
      decidedAt: Date.now(),
      decidedBy,
      ...(note === undefined ? {} : { note }),
    });
    if (records.length > HISTORY_LIMIT) records.length = HISTORY_LIMIT;
  }

  /** 结算一条挂起审批：记录历史、通知渲染层、唤醒 Promise */
  function settle(
    id: string,
    decision: ApprovalDecision,
    decidedBy: "user" | "ai",
    note?: string,
  ): boolean {
    const entry = pendingById.get(id);
    if (!entry) return false;
    pendingById.delete(id);
    entry.cleanupAbort?.();
    if (pendingByToolCall.get(entry.toolCallId) === id) pendingByToolCall.delete(entry.toolCallId);
    record(entry, decision, decidedBy, note);
    emitSafe(entry.request.sessionId, { type: "approval-resolved", id, decision });
    entry.resolve(decision);
    return true;
  }

  /**
   * AI 预审：放行则直接结算；拒绝或调用失败则把结论交回渲染层，
   * 请求继续挂起等用户覆盖（卡片必须离开「审批中」，否则用户无从操作）。
   */
  async function runAiApproval(entry: PendingApproval, aiApprover: AiApprover): Promise<void> {
    let result: AiApproverResult;
    try {
      result = await aiApprover({
        toolName: entry.request.toolName,
        argsText: entry.request.argsText,
        ...(entry.workingDir === undefined ? {} : { workingDir: entry.workingDir }),
        ...(entry.request.modelRef === undefined ? {} : { modelRef: entry.request.modelRef }),
      });
    } catch (error) {
      handBack(entry, `AI 审批失败：${String(error)}`);
      return;
    }
    // 用户可能已在 AI 返回前处理；已结算则忽略本次结果
    if (!pendingById.has(entry.request.id)) return;
    if (result.allow) {
      settle(entry.request.id, "allow_once", "ai", `AI: ${result.reason}`);
      return;
    }
    handBack(entry, result.reason);
  }

  /** 把 AI 的结论（拒绝/失败）落到请求上并通知渲染层，请求保持挂起等用户决定 */
  function handBack(entry: PendingApproval, reason: string): void {
    if (!pendingById.has(entry.request.id)) return;
    entry.request.aiReviewed = true;
    entry.request.reason = reason;
    emitSafe(entry.request.sessionId, { type: "approval-reviewed", id: entry.request.id, reason });
  }

  async function request(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsText: string;
    risk: "low" | "high";
    workingDir?: string;
    /** 命令黑名单命中的警示文案；只用于卡片展示，不参与任何判定 */
    warning?: string;
    /** 会话实际使用的模型；AI 预审据此选模型，缺省时审批器回落默认模型 */
    modelRef?: ModelRef;
    isSubagent?: boolean;
    signal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    if (input.signal?.aborted) return "deny";
    const duplicate = findPending(input.toolCallId);
    if (duplicate) return duplicate.promise;
    const admission = { cancelled: false };
    const sessionAdmissions = admissions.get(input.sessionId) ?? new Set();
    sessionAdmissions.add(admission);
    admissions.set(input.sessionId, sessionAdmissions);

    // 只有「帮我审批」（含子智能体在「默认权限」下映射来的那一档）启用 AI 预审，
    // 其余模式一律等用户确认；读取设置失败时退回用户审批（审批卡照常弹出，不打断链路）。
    let aiApprover: AiApprover | undefined;
    let removeSetupAbort = () => {};
    try {
      const settings = await (input.signal === undefined
        ? deps.getSettings()
        : Promise.race([
            deps.getSettings(),
            new Promise<undefined>((resolve) => {
              const cancel = () => resolve(undefined);
              input.signal?.addEventListener("abort", cancel, { once: true });
              removeSetupAbort = () => input.signal?.removeEventListener("abort", cancel);
              if (input.signal?.aborted) cancel();
            }),
          ]));
      if (settings === undefined) return "deny";
      if (
        effectivePermissionMode(settings.permissionMode, input.isSubagent === true) ===
          "ai_review" &&
        deps.aiApprover
      ) {
        aiApprover = deps.aiApprover;
      }
    } catch (error) {
      console.warn(`读取审批设置失败，退回用户审批：${String(error)}`);
    } finally {
      removeSetupAbort();
      sessionAdmissions.delete(admission);
      if (sessionAdmissions.size === 0) admissions.delete(input.sessionId);
    }
    if (input.signal?.aborted || admission.cancelled) return "deny";

    // settings 读取期间可能已有同 toolCallId 的请求完成登记
    const raced = findPending(input.toolCallId);
    if (raced) return raced.promise;

    let resolvePromise: (decision: ApprovalDecision) => void = () => undefined;
    const promise = new Promise<ApprovalDecision>((resolve) => {
      resolvePromise = resolve;
    });
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      argsText: input.argsText,
      risk: input.risk,
      source: aiApprover ? "ai" : "user",
      ...(input.warning === undefined ? {} : { warning: input.warning }),
    };
    const entry: PendingApproval = {
      request,
      toolCallId: input.toolCallId,
      promise,
      resolve: resolvePromise,
      ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }),
      ...(input.modelRef === undefined ? {} : { modelRef: input.modelRef }),
    };
    pendingById.set(request.id, entry);
    pendingByToolCall.set(input.toolCallId, request.id);
    if (input.signal !== undefined) {
      const abort = () => {
        request.reason = "运行已停止";
        settle(request.id, "deny", "user", "运行已停止");
      };
      input.signal.addEventListener("abort", abort, { once: true });
      entry.cleanupAbort = () => input.signal?.removeEventListener("abort", abort);
    }
    emitSafe(request.sessionId, { type: "approval-requested", request });
    if (aiApprover) void runAiApproval(entry, aiApprover);
    return promise;
  }

  function respond(id: string, decision: ApprovalDecision, note?: string): void {
    // 重复点击或已取消视为已处理，避免 IPC 层抛错打断渲染进程
    if (!pendingById.has(id)) {
      console.warn(`审批请求不存在或已处理：${id}`);
      return;
    }
    settle(id, decision, "user", note);
  }

  function pending(sessionId?: string): ApprovalRequest[] {
    const all = [...pendingById.values()].map((entry) => entry.request);
    if (sessionId === undefined) return all;
    return all.filter((item) => item.sessionId === sessionId);
  }

  function cancelSession(sessionId: string): void {
    for (const admission of admissions.get(sessionId) ?? []) admission.cancelled = true;
    for (const entry of [...pendingById.values()]) {
      if (entry.request.sessionId !== sessionId) continue;
      entry.request.reason = "运行已停止";
      settle(entry.request.id, "deny", "user", "运行已停止");
    }
  }

  function history(): ApprovalRecord[] {
    return [...records];
  }

  return { request, respond, pending, cancelSession, history };
}
