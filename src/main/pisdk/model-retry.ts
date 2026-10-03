import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type {
  ConversationRetryPolicy,
  EntryRecord,
  LiveState,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ChatRetryState } from "@/shared/contracts/chat";

/** Only the durable generation retries; provider-level retries stay disabled. */
export const MODEL_RETRY_POLICY = {
  enabled: true,
  maxRetries: 5,
} satisfies Partial<ConversationRetryPolicy>;

export function modelGenerationId(conversationId: number, taskId: number): string {
  return `${conversationId}:${taskId}`;
}

/** Recover feedback from committed attempts, including while a retry request is streaming. */
export function projectModelRetry(
  conversationId: number,
  records: readonly EntryRecord[],
  live: LiveState | undefined,
  submission: SubmissionRecord | undefined,
): ChatRetryState | null {
  const assistants = records.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      entry.kind === "pi.assistant" && message.role === "assistant"
        ? [{ entry, message: message as AssistantMessage }]
        : [],
    ),
  );
  const generation = live?.generation;
  if (live?.run) {
    if (!generation || (!generation.retry && generation.attempt <= 1)) return null;
    const attempts = assistants.filter(({ entry }) => entry.byTaskId === live.run?.taskId);
    const latest = attempts.filter(({ message }) => message.stopReason === "error").at(-1);
    // A successful response can still own the run while its tools execute.
    const last = attempts.at(-1);
    if (last && last.message.stopReason !== "error") return null;
    return {
      generationId: modelGenerationId(conversationId, live.run.taskId),
      phase: "retrying",
      attempt: Math.min(
        MODEL_RETRY_POLICY.maxRetries,
        generation.retry ? generation.attempt : generation.attempt - 1,
      ),
      maxAttempts: MODEL_RETRY_POLICY.maxRetries,
      error: generation.retry?.error ?? latest?.message.errorMessage ?? "",
    };
  }

  if (
    submission?.type !== "input" ||
    submission.status !== "unanswered" ||
    submission.reason !== "model_error"
  )
    return null;
  const last = assistants.at(-1);
  if (
    !last ||
    last.entry.byTaskId === undefined ||
    last.entry.id <= (submission.entry ?? Infinity) ||
    last.message.stopReason !== "error" ||
    records.some((entry) => entry.kind === "pi.user" && entry.id > last.entry.id)
  )
    return null;

  // Overflow recovery uses compaction without incrementing the native retry budget.
  const retriedFailures = assistants.filter(
    ({ entry, message }) =>
      entry.byTaskId === last.entry.byTaskId &&
      entry.id < last.entry.id &&
      message.stopReason === "error" &&
      !isContextOverflow(message),
  );
  return {
    generationId: modelGenerationId(conversationId, last.entry.byTaskId),
    phase: "failed",
    attempt: Math.min(MODEL_RETRY_POLICY.maxRetries, retriedFailures.length),
    maxAttempts: MODEL_RETRY_POLICY.maxRetries,
    error:
      typeof submission.detail === "string" ? submission.detail : (last.message.errorMessage ?? ""),
  };
}
