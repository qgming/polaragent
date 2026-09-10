// 审批服务：挂起 Promise + 事件桥；AI 预审可用时自动放行，拒绝/失败则退回用户审批。

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "@/shared/contracts/approval";
import type { ChatEvent } from "@/shared/contracts/chat";
import type { Settings } from "@/shared/contracts/settings";
import type { AiApprover, AiApproverResult } from "./ai-approver";

export interface ApprovalServiceDeps {
  getSettings: () => Promise<Settings>;
  emit: (event: ChatEvent) => void;
  /** AI 审批器（"帮我审批"模式）；未注入时该模式退化为用户审批 */
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
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const pendingById = new Map<string, PendingApproval>();
  // toolCallId → 未决请求 id，保证同一次工具调用不重复弹卡
  const pendingByToolCall = new Map<string, string>();
  const records: ApprovalRecord[] = [];

  function emitSafe(event: ChatEvent): void {
    try {
      deps.emit(event);
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
    emitSafe({ type: "approval-resolved", id, decision });
    entry.resolve(decision);
    return true;
  }

  /** AI 预审：放行则直接结算；拒绝则保留挂起等待用户覆盖；异常按用户审批兜底 */
  async function runAiApproval(entry: PendingApproval, aiApprover: AiApprover): Promise<void> {
    let result: AiApproverResult;
    try {
      result = await aiApprover({
        toolName: entry.request.toolName,
        argsText: entry.request.argsText,
      });
    } catch (error) {
      entry.request.reason = `AI 审批失败：${String(error)}`;
      return;
    }
    // 用户可能已在 AI 返回前处理；已结算则忽略本次结果
    if (!pendingById.has(entry.request.id)) return;
    entry.request.reason = result.reason;
    if (result.allow) {
      settle(entry.request.id, "allow_once", "ai", `AI：${result.reason}`);
    }
  }

  async function request(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsText: string;
    risk: "low" | "high";
  }): Promise<ApprovalDecision> {
    const duplicate = findPending(input.toolCallId);
    if (duplicate) return duplicate.promise;

    // 读取设置失败时退回用户审批；「帮我审批」模式本身即代表 AI 审批，无需额外开关
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
    };
    pendingById.set(request.id, entry);
    pendingByToolCall.set(input.toolCallId, request.id);
    emitSafe({ type: "approval-requested", request });
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
