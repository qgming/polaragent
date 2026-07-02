// ask_user 请求运行时 —— 普通对话与团队对话共用同一套等待/提交机制。

import {
  useAskUserStore,
  type AskUserMode,
  type AskUserOption,
  type AskUserResponse,
} from "@/stores/ask-user-store";

export type { AskUserMode, AskUserOption, AskUserResponse };

export interface AskUserRuntimeRequest {
  threadId: string;
  requesterId?: string;
  requesterName?: string;
  isTeam?: boolean;
  prompt: string;
  mode: AskUserMode;
  options: AskUserOption[];
  customOptionLabel?: string;
  timeout?: number;
}

interface PendingAskUser {
  threadId: string;
  resolve: (response: AskUserResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingAskUser>();

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function initiateAskUser(
  request: AskUserRuntimeRequest,
): Promise<AskUserResponse> {
  const requestId = createId();

  return new Promise<AskUserResponse>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (request.timeout && request.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        pendingRequests.delete(requestId);
        useAskUserStore.getState().clearRequest(requestId);
        resolve({
          selectedOptionIds: [],
          selectedOptions: [],
          text: "",
          customText: "",
          submittedAt: Date.now(),
          timedOut: true,
          message: `用户未在 ${request.timeout! / 1000} 秒内响应`,
        });
      }, request.timeout);
    }

    pendingRequests.set(requestId, {
      threadId: request.threadId,
      resolve: (response: AskUserResponse) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        pendingRequests.delete(requestId);
        resolve(response);
      },
      reject: (error: Error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        pendingRequests.delete(requestId);
        reject(error);
      },
      timeoutHandle,
    });

    useAskUserStore.getState().enqueueRequest({
      requestId,
      threadId: request.threadId,
      requesterId: request.requesterId,
      requesterName:
        request.requesterName || (request.isTeam ? "团队成员" : "助手"),
      isTeam: !!request.isTeam,
      prompt: request.prompt,
      mode: request.mode,
      options: request.options,
      customOptionLabel: request.customOptionLabel,
    });
  });
}

export function submitAskUserResponse(
  requestId: string,
  response: Omit<AskUserResponse, "submittedAt">,
): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;

  pendingRequests.delete(requestId);
  useAskUserStore.getState().clearRequest(requestId);
  if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);

  pending.resolve({
    ...response,
    submittedAt: Date.now(),
  });
  return true;
}

export function cancelAskUserRequest(requestId: string): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;

  pendingRequests.delete(requestId);
  useAskUserStore.getState().clearRequest(requestId);
  if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
  pending.reject(new Error("用户取消了输入请求"));
  return true;
}

export function cancelAskUserRequestsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingRequests.entries()) {
    if (pending.threadId !== threadId) continue;
    pendingRequests.delete(requestId);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    pending.reject(new Error("用户取消了输入请求"));
  }

  useAskUserStore.getState().clearThreadRequests(threadId);
}
