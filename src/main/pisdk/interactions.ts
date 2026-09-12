// 提问服务：挂起 Promise + 事件桥；ask_user 工具经它向用户提问，渲染层回填答案。
//
// 骨架与 approvals.ts 同源（未决表 / 挂起 Promise / 事件桥 / 会话取消），但**刻意不合并**：
// 审批的结论是「放行还是拒绝这次工具调用」，提问的结论是「用户选了什么」；
// 两者的事件、UI、结算语义各不相同，抽一个共用的「未决请求」基类只会把两条业务耦在一起。
// 宁可有两份相似代码，也不要为了去重引入一处谁都不敢改的抽象。
//
// 与审批唯一的实质差别是**超时**：审批卡弹出来用户总会看到，而提问可能被无视
// （去开会、切走窗口），挂着的 Promise 不结算就会把整轮运行无限期卡住 ——
// 所以到点按「用户没回应」收尾，让模型带着这个事实继续。

import { randomUUID } from "node:crypto";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
import type {
  AskAnswerItem,
  AskOutcome,
  AskQuestion,
  AskReply,
  AskRequest,
  AskResponse,
} from "@/shared/contracts/interaction";

/**
 * 默认等待时长：5 分钟。
 *
 * 取这么长是因为提问本身就是「给用户时间想」的场景，短了会把用户还没看完的题判成没回应；
 * 而它终究只是个兜底 —— 用户随时可以点提交，或按停止结束这一轮。
 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface InteractionServiceDeps {
  /** 发往渲染进程的事件；带会话 id（后台会话的提问也要落到它自己头上） */
  emit: (payload: ChatEventEnvelope) => void;
  /** 等待用户回应的上限（毫秒）；缺省 DEFAULT_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 一次提问的输入：会话 + 工具调用 id + 题目 */
export interface AskInput {
  sessionId: string;
  toolCallId: string;
  questions: AskQuestion[];
}

export interface InteractionService {
  /** 发起提问并等待用户回答（挂起 Promise，由 respond / 超时 / cancelSession 结算） */
  request(input: AskInput): Promise<AskResponse>;
  /** 渲染进程回填答案 */
  respond(id: string, reply: AskReply): void;
  /** 未决提问列表（会话切换时恢复 UI） */
  pending(sessionId?: string): AskRequest[];
  /** 停止运行 / 关闭会话时收尾该会话的全部未决提问（按 cancelled 处理） */
  cancelSession(sessionId: string): void;
  /** 当前等待上限（毫秒）：工具侧要把它写进给模型的提示文案里，不能各自写死一个数 */
  timeoutMs(): number;
}

interface PendingAsk {
  request: AskRequest;
  toolCallId: string;
  promise: Promise<AskResponse>;
  resolve: (response: AskResponse) => void;
  /** 超时兜底定时器：结算时必须清掉，否则它会一直挂到超时（测试里就是「进程不退出」） */
  timer: NodeJS.Timeout;
}

export function createInteractionService(deps: InteractionServiceDeps): InteractionService {
  const waitMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pendingById = new Map<string, PendingAsk>();
  // toolCallId → 未决请求 id，保证同一次工具调用不重复弹卡
  const pendingByToolCall = new Map<string, string>();

  function emitSafe(sessionId: string, event: ChatEvent): void {
    try {
      deps.emit({ sessionId, event });
    } catch (error) {
      console.warn(`发送提问事件失败：${String(error)}`);
    }
  }

  function findPending(toolCallId: string): PendingAsk | undefined {
    const id = pendingByToolCall.get(toolCallId);
    if (id === undefined) return undefined;
    return pendingById.get(id);
  }

  /** 结算一条挂起提问：清定时器、通知渲染层、唤醒 Promise */
  function settle(
    id: string,
    outcome: AskOutcome,
    answers: AskAnswerItem[],
    note?: string,
  ): boolean {
    const entry = pendingById.get(id);
    if (!entry) return false;
    pendingById.delete(id);
    if (pendingByToolCall.get(entry.toolCallId) === id) pendingByToolCall.delete(entry.toolCallId);
    clearTimeout(entry.timer);
    emitSafe(entry.request.sessionId, { type: "ask-resolved", id, outcome });
    entry.resolve({ id, outcome, answers, ...(note === undefined ? {} : { note }) });
    return true;
  }

  function request(input: AskInput): Promise<AskResponse> {
    const duplicate = findPending(input.toolCallId);
    if (duplicate) return duplicate.promise;

    let resolvePromise: (response: AskResponse) => void = () => undefined;
    const promise = new Promise<AskResponse>((resolve) => {
      resolvePromise = resolve;
    });
    const request: AskRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      questions: input.questions,
      createdAt: Date.now(),
    };
    const timer = setTimeout(() => {
      // 超时 = 「用户没回应」：挂起项上留一句说明，模型侧据此按保守假设收尾，
      // 渲染层也能从 ask-resolved 的 outcome 看出这不是用户点出来的结果。
      settle(
        request.id,
        "unanswered",
        [],
        `等待超时（${Math.round(waitMs / 1000)} 秒）未回应`,
      );
    }, waitMs);
    // 兜底定时器不保活进程：等待用户回应这件事没必要时时刻刻吊着事件循环
    timer.unref();

    const entry: PendingAsk = {
      request,
      toolCallId: input.toolCallId,
      promise,
      resolve: resolvePromise,
      timer,
    };
    pendingById.set(request.id, entry);
    pendingByToolCall.set(input.toolCallId, request.id);
    emitSafe(request.sessionId, { type: "ask-requested", request });
    return promise;
  }

  function respond(id: string, reply: AskReply): void {
    // 重复点击、超时后补交、或已取消都视为已处理，避免 IPC 层抛错打断渲染进程
    if (!pendingById.has(id)) {
      console.warn(`提问请求不存在或已处理：${id}`);
      return;
    }
    settle(id, reply.outcome, reply.answers, reply.note);
  }

  function pending(sessionId?: string): AskRequest[] {
    const all = [...pendingById.values()].map((entry) => entry.request);
    if (sessionId === undefined) return all;
    return all.filter((item) => item.sessionId === sessionId);
  }

  function cancelSession(sessionId: string): void {
    for (const entry of [...pendingById.values()]) {
      if (entry.request.sessionId !== sessionId) continue;
      settle(entry.request.id, "cancelled", [], "运行已停止");
    }
  }

  return { request, respond, pending, cancelSession, timeoutMs: () => waitMs };
}
