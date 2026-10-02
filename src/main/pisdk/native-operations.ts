import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CompactionResult, Harness, TaskId } from "@earendil-works/pi-durable";

export async function compactionReceipt(
  harness: Harness,
  taskId: TaskId<CompactionResult>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{
  status: "completed" | "declined" | "aborted" | "failed";
  entryId?: CompactionResult["entryId"];
  error?: unknown;
}> {
  context.abortSignal?.throwIfAborted();
  const task = await harness.waitForTask(taskId, context);
  context.abortSignal?.throwIfAborted();
  const outcome = task.state.outcome;
  if (outcome.status === "aborted") return { status: "aborted" };
  if (outcome.status !== "completed") {
    return { status: "failed", error: "error" in outcome ? outcome.error : outcome.reason };
  }
  const result = outcome.result;
  if (result.entryId !== undefined) return { status: "completed", entryId: result.entryId };
  if (result.submissionId !== undefined) {
    const submission = await harness.submission(result.submissionId, context);
    context.abortSignal?.throwIfAborted();
    const receipt = await submission?.wait(context);
    if (receipt?.status === "done") return { status: "completed", entryId: receipt.entry };
    return { status: "failed", error: receipt?.reason ?? "Compaction summary was not placed" };
  }
  return { status: "declined" };
}
