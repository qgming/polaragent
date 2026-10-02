import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, watchEvents } from "@earendil-works/pi-durable";
import {
  onFirstToken,
  onMessageEnd,
  onMessageStart,
  onRunEnd,
  onToolEnd,
  onToolStart,
  onTurnStart,
  type SessionStatsState,
} from "./session-stats";

/** Timing observation only. No transcript, stream, queue or usage-total state is reconstructed here. */
export async function createNativeMetrics(input: {
  harness: Harness;
  conversationId: ConversationId;
  initial: SessionStatsState;
  changed(state: SessionStatsState): void;
  sample(usage: Usage): void;
}) {
  const stream = await watchEvents(input.harness, input.conversationId, context);
  let state = input.initial;
  let pending = Promise.resolve();
  stream.start(async (events) => {
    pending = (async () => {
      for (const event of events) {
        const now = Date.now();
        if (event.type === "message_start" && event.message.role === "assistant")
          state = onMessageStart(state, randomUUID(), now);
        else if (event.type === "message_update" && state.openStep)
          state = onFirstToken(state, state.openStep.messageId, now);
        else if (event.type === "message_end") {
          const message = event.entry.model?.[0];
          if (message?.role === "assistant") {
            if (state.openStep)
              state = onMessageEnd(state, state.openStep.messageId, now, message.usage.output);
            input.sample(message.usage);
          }
        } else if (event.type === "tool_execution_start")
          state = onToolStart(state, event.toolCallId, now);
        else if (event.type === "tool_execution_end")
          state = onToolEnd(state, event.toolCallId, now);
        else if (event.type === "turn_start") state = onTurnStart(state, randomUUID());
        else if (event.type === "run_end") state = onRunEnd(state);
      }
      input.changed(state);
    })();
    await pending;
  });
  return {
    async flush() {
      await pending;
    },
    async stop() {
      await stream.stop();
      await pending;
    },
  };
}
export type NativeMetrics = Awaited<ReturnType<typeof createNativeMetrics>>;
