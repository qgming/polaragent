import { create } from "zustand";

export type AskUserMode = "input" | "single" | "multiple";

export interface AskUserOption {
  id: string;
  label: string;
}

export interface AskUserRequest {
  requestId: string;
  threadId: string;
  requesterId?: string;
  requesterName: string;
  isTeam: boolean;
  prompt: string;
  mode: AskUserMode;
  options: AskUserOption[];
  customOptionLabel?: string;
}

export interface AskUserResponse {
  selectedOptionIds: string[];
  selectedOptions: string[];
  text: string;
  customText: string;
  submittedAt: number;
  timedOut?: boolean;
  message?: string;
}

interface AskUserState {
  activeRequest: AskUserRequest | null;
  queuedRequests: AskUserRequest[];
  enqueueRequest: (request: AskUserRequest) => void;
  clearRequest: (requestId: string) => void;
  clearThreadRequests: (threadId: string) => void;
}

export const useAskUserStore = create<AskUserState>((set) => ({
  activeRequest: null,
  queuedRequests: [],
  enqueueRequest: (request) =>
    set((state) => {
      if (!state.activeRequest) {
        return { activeRequest: request };
      }
      return { queuedRequests: [...state.queuedRequests, request] };
    }),
  clearRequest: (requestId) =>
    set((state) => {
      if (state.activeRequest?.requestId !== requestId) {
        return {
          queuedRequests: state.queuedRequests.filter(
            (request) => request.requestId !== requestId,
          ),
        };
      }
      const [next, ...rest] = state.queuedRequests;
      return {
        activeRequest: next ?? null,
        queuedRequests: rest,
      };
    }),
  clearThreadRequests: (threadId) =>
    set((state) => {
      const active =
        state.activeRequest?.threadId === threadId
          ? null
          : state.activeRequest;
      const queued = state.queuedRequests.filter(
        (request) => request.threadId !== threadId,
      );
      if (active) {
        return { activeRequest: active, queuedRequests: queued };
      }
      const [next, ...rest] = queued;
      return { activeRequest: next ?? null, queuedRequests: rest };
    }),
}));
