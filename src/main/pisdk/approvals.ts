// 审批服务：挂起 Promise + 事件桥；「帮我审批」模式下先交 AI 预审，拒绝/失败则退回用户审批。

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "@/shared/contracts/approval";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
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
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const pendingById = new Map<string, PendingApproval>();
  // toolCallId → 未决请求 id，保证同一次工具调用不重复弹卡
  const pendingByToolCall = new Map<string, string>();
  const records: ApprovalRecord[] = [];

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
  }): Promise<ApprovalDecision> {
    const duplicate = findPending(input.toolCallId);
    if (duplicate) return duplicate.promise;

    // 只有「帮我审批」模式启用 AI 预审，其余模式一律等用户确认；
    // 读取设置失败时退回用户审批（审批卡照常弹出，不打断链路）。
    let aiApprover: AiApprover | undefined;
    try {
      const settings = await deps.getSettings();
      if (settings.permissionMode === "ai_review" && deps.aiApprover) {
        aiApprover = deps.aiApprover;
      }
    } catch (error) {
      console.warn(`读取审批设置失败，退回用户审批：${String(error)}`);
    }

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
    };
    const entry: PendingApproval = {
      request,
      toolCallId: input.toolCallId,
      promise,
      resolve: resolvePromise,
      ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }),
    };
    pendingById.set(request.id, entry);
    pendingByToolCall.set(input.toolCallId, request.id);
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
