import type { ChatEvent, ChatLiveState } from "@/shared/contracts/chat";

let revision = 0;
export function viewEvent(state: Partial<ChatLiveState> = {}, generation = 1): ChatEvent {
  return {
    type: "view",
    frame: {
      generation,
      revision: ++revision,
      state: {
        conversationId: 1,
        messages: [],
        reports: {},
        admittedRequestIds: [],
        running: false,
        runId: null,
        queue: [],
        usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        compaction: null,
        ...state,
      },
    },
  };
}
