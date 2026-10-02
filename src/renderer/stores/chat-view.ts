import { applyImmutable } from "@earendil-works/chord/delta";
import type { ChatLiveSnapshot, ChatLiveState, ChatViewFrame } from "@/shared/contracts/chat";
import type { ChatMessage } from "@/shared/contracts/session";

export function acceptViewFrame(
  current: ChatLiveSnapshot | undefined,
  frame: ChatViewFrame,
): { snapshot?: ChatLiveSnapshot; resync: boolean } {
  if (
    current &&
    (frame.generation < current.generation ||
      (frame.generation === current.generation && frame.revision <= current.revision))
  )
    return { resync: false };
  if ("state" in frame) return { snapshot: frame, resync: false };
  if (
    !current ||
    current.generation !== frame.generation ||
    current.revision !== frame.previousRevision
  )
    return { resync: true };
  return {
    snapshot: {
      generation: frame.generation,
      revision: frame.revision,
      state: applyImmutable<ChatLiveState>(current.state, frame.ops),
    },
    resync: false,
  };
}

/** Keep paged history outside the active native context; only a different native conversation replaces branch membership. */
export function mergeViewMessages(
  existing: ChatMessage[],
  view: ChatLiveState,
  branchChanged: boolean,
): ChatMessage[] {
  const ids = new Set(view.messages.map((message) => message.id));
  const entries = new Set(
    view.messages.flatMap((message) => (message.entryId ? [message.entryId] : [])),
  );
  const admitted = new Set(view.admittedRequestIds);
  const historical = branchChanged
    ? []
    : existing.filter((message) => message.entryId && !entries.has(message.entryId));
  const optimistic = existing.filter(
    (message) =>
      !message.entryId &&
      !message.id.startsWith("live:") &&
      !message.id.startsWith("receipt:") &&
      !ids.has(message.id) &&
      !admitted.has(message.id),
  );
  const ordered = [...historical, ...view.messages].sort((a, b) => {
    const left = a.entryId ? Number(a.entryId.slice(6)) : Infinity;
    const right = b.entryId ? Number(b.entryId.slice(6)) : Infinity;
    return left - right;
  });
  return [...ordered, ...optimistic].map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool-call") return part;
      const report = view.reports[part.toolCallId];
      return report
        ? {
            ...part,
            result: report.text,
            details: report.details,
            isError: report.isError,
            status: report.isError ? ("error" as const) : ("done" as const),
          }
        : part;
    }),
  }));
}
