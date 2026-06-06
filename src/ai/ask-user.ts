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
  allowCustomInput: boolean;
  customInputLabel?: string;
}

interface PendingAskUser {
  threadId: string;
  resolve: (response: AskUserResponse) => void;
  reject: (error: Error) => void;
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
    allowCustomInput: request.allowCustomInput,
    customInputLabel: request.customInputLabel,
  });

  return new Promise<AskUserResponse>((resolve, reject) => {
    pendingRequests.set(requestId, {
      threadId: request.threadId,
      resolve,
      reject,
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
  pending.reject(new Error("用户取消了输入请求"));
  return true;
}

export function cancelAskUserRequestsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingRequests.entries()) {
    if (pending.threadId !== threadId) continue;
    pendingRequests.delete(requestId);
    pending.reject(new Error("用户取消了输入请求"));
  }

  useAskUserStore.getState().clearThreadRequests(threadId);
}
