// Native durable event batches translated only at the application's presentation boundary.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type AgentEventStream,
  type CompactionReason,
  type CompactionResult,
  type ConversationId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type SnapshotEvent,
  type SubmissionId,
  type TaskId,
  type UsageState,
  watchEvents,
} from "@earendil-works/pi-durable";

export interface RuntimeToolResult {
  content: ToolResultMessage["content"];
  details?: unknown;
}

export interface RuntimeEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: Message;
}

export type RuntimeEvent =
  | { type: "snapshot"; snapshot: SnapshotEvent }
  | { type: "message_start"; message: Message }
  | Extract<AgentEvent, { type: "message_update" }>
  | { type: "message_end"; message: Message }
  | { type: "entry_added"; entry: RuntimeEntry }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_update"; toolCallId: string; partialResult: RuntimeToolResult }
  | { type: "tool_end"; toolCallId: string; result: RuntimeToolResult; isError: boolean }
  | { type: "run_start"; runId: string }
  | ({ type: "run_end"; runId: string } & (
      | { status: "completed" | "aborted" }
      | { status: "failed"; error: { message: string } }
    ))
  | { type: "turn_start"; turnId: string }
  | { type: "usage"; row: { usage: Usage } }
  | { type: "native_usage"; usage: UsageState }
  | {
      type: "queue_update";
      queues: { type: "message"; kind: "steer" | "followUp"; entryId: string; message: Message }[];
    }
  | { type: "compaction_start"; reason: CompactionReason; startedAt: number }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      status: "completed" | "declined" | "aborted" | "failed";
      endedAt: number;
      entryId?: string;
      error?: unknown;
    };

export type RuntimeEventType = RuntimeEvent["type"];

function visibleEntry(entry: EntryRecord): boolean {
  return (
    entry.kind === "pi.user" || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result"
  );
}

/** Apply the native retained-window update before the UI's output throttling. */
export function updateRetainedOutput(
  previous: string,
  output: Extract<AgentEvent, { type: "tool_execution_update" }>["output"],
): string {
  if (output === undefined) return previous;
  if ("set" in output) return output.set;
  return previous.slice(output.trimStart ?? 0) + (output.append ?? "");
}

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

export interface RuntimeEventBridge {
  on<T extends RuntimeEventType>(
    type: T,
    listener: (event: Extract<RuntimeEvent, { type: T }>) => void | Promise<void>,
  ): () => void;
  start(): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export async function createRuntimeEventBridge(options: {
  harness: Harness;
  conversationId: ConversationId;
  projectEntry(
    entry: EntryRecord,
  ):
    | { record: EntryRecord; entryId: string; parentId: string | null }
    | Promise<{ record: EntryRecord; entryId: string; parentId: string | null }>;
  externalEntryId(id: NonNullable<CompactionResult["entryId"]>): string | Promise<string>;
}): Promise<RuntimeEventBridge> {
  const { harness, conversationId } = options;
  const stream: AgentEventStream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT);
  const listeners = new Map<string, Set<(event: RuntimeEvent) => void | Promise<void>>>();
  const outputs = new Map<string, string>();
  let pending = Promise.resolve();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const receiptController = new AbortController();
  const receiptContext = withAbortSignal(receiptController.signal, BACKGROUND_CONTEXT);
  const receipts = new Set<Promise<void>>();
  let taskFailure: string | undefined;
  let initialized = false;
  let assistantStreaming = false;
  let runInputs: readonly SubmissionId[] | undefined;
  const seenEntries = new Set<number>();

  async function project(entry: EntryRecord): Promise<RuntimeEntry> {
    const projected = await options.projectEntry(entry);
    const message = visibleEntry(entry) ? entry.model?.[0] : undefined;
    return {
      type: message === undefined ? entry.kind : "message",
      id: projected.entryId,
      parentId: projected.parentId,
      ...(message === undefined ? {} : { message }),
    };
  }

  async function emit(event: RuntimeEvent): Promise<void> {
    for (const listener of listeners.get(event.type) ?? []) await listener(event);
  }

  async function queue(): Promise<void> {
    const inbox = await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT);
    await emit({
      type: "queue_update",
      queues: (inbox?.items ?? []).flatMap((item) =>
        item.mode === "write"
          ? []
          : [
              {
                type: "message" as const,
                kind: item.mode,
                entryId: String(item.id),
                message: { role: "user" as const, content: item.content, timestamp: Date.now() },
              },
            ],
      ),
    });
  }

  async function finishRun(inputs: readonly SubmissionId[]): Promise<void> {
    const records = await Promise.all(
      inputs.map(async (id) =>
        (await harness.submission(id, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT),
      ),
    );
    const failure = records.find(
      (record) =>
        record?.status === "unanswered" && record.reason !== "aborted" && record.reason !== "reset",
    );
    const aborted = records.some(
      (record) =>
        record?.status === "unanswered" &&
        (record.reason === "aborted" || record.reason === "reset"),
    );
    const reason =
      failure?.status === "unanswered"
        ? typeof failure.detail === "string"
          ? failure.detail
          : failure.reason
        : taskFailure;
    taskFailure = undefined;
    await emit(
      reason === undefined
        ? { type: "run_end", runId: String(inputs[0]), status: aborted ? "aborted" : "completed" }
        : {
            type: "run_end",
            runId: String(inputs[0]),
            status: "failed",
            error: { message: reason },
          },
    );
  }

  async function process(events: readonly AgentEvent[]): Promise<void> {
    for (const [eventIndex, event] of events.entries()) {
      if (stopped) return;
      switch (event.type) {
        case "snapshot": {
          if (initialized) {
            for (const entry of event.entries) {
              if (seenEntries.has(entry.id)) continue;
              const message = visibleEntry(entry) ? entry.model?.[0] : undefined;
              if (message !== undefined) {
                if (message.role !== "assistant" || !assistantStreaming)
                  await emit({ type: "message_start", message });
                await emit({ type: "message_end", message });
                if (message.role === "assistant") assistantStreaming = false;
              }
              await emit({ type: "entry_added", entry: await project(entry) });
            }
          }
          for (const entry of event.entries) seenEntries.add(entry.id);
          initialized = true;
          outputs.clear();
          for (const tool of event.tools) outputs.set(tool.callId, tool.output ?? "");
          await emit({ type: "snapshot", snapshot: event });
          assistantStreaming = event.generation?.message !== undefined;
          if (runInputs !== undefined && event.run === undefined) await finishRun(runInputs);
          runInputs = event.run?.inputs;
          await queue();
          break;
        }
        case "message_start": {
          const next = events[eventIndex + 1];
          // Compaction/reset/system entries can contribute model messages without becoming chat messages.
          if (next?.type === "message_end" && !visibleEntry(next.entry)) break;
          if (event.message.role === "assistant") assistantStreaming = true;
          await emit(event);
          break;
        }
        case "message_update":
          await emit(event);
          break;
        case "message_end": {
          const message = visibleEntry(event.entry) ? event.entry.model?.[0] : undefined;
          if (message !== undefined) await emit({ type: "message_end", message });
          if (message?.role === "assistant") assistantStreaming = false;
          seenEntries.add(event.entry.id);
          await emit({ type: "entry_added", entry: await project(event.entry) });
          break;
        }
        case "entry_appended":
          seenEntries.add(event.entry.id);
          await emit({ type: "entry_added", entry: await project(event.entry) });
          break;
        case "tool_execution_start":
          await emit({
            type: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_update": {
          const text = updateRetainedOutput(outputs.get(event.toolCallId) ?? "", event.output);
          outputs.set(event.toolCallId, text);
          await emit({
            type: "tool_update",
            toolCallId: event.toolCallId,
            partialResult: { content: [{ type: "text", text }], details: event.details },
          });
          break;
        }
        case "tool_execution_end": {
          outputs.delete(event.toolCallId);
          const message = event.entry?.model?.find((item) => item.role === "toolResult");
          await emit({
            type: "tool_end",
            toolCallId: event.toolCallId,
            isError: message?.isError ?? true,
            result: message ?? { content: [{ type: "text", text: "工具执行已中断" }] },
          });
          break;
        }
        case "run_start":
          runInputs = event.inputs;
          taskFailure = undefined;
          await emit({ type: "run_start", runId: String(event.inputs[0]) });
          break;
        case "run_end":
          await finishRun(event.inputs);
          runInputs = undefined;
          break;
        case "turn_start":
          await emit({ type: "turn_start", turnId: randomUUID() });
          break;
        case "inbox_update":
          await queue();
          break;
        case "usage_changed":
          await emit({ type: "native_usage", usage: event.usage });
          break;
        case "task_failed":
          if (event.kind === "pi.generation") taskFailure = event.message;
          break;
        case "compaction_start":
          await emit({ type: "compaction_start", reason: event.reason, startedAt: Date.now() });
          break;
        case "compaction_end": {
          // A summary write can wait for the next boundary. Do not hold up the event watch while it settles.
          const receipt = compactionReceipt(
            harness,
            event.taskId as TaskId<CompactionResult>,
            receiptContext,
          )
            .then(async (receipt) => {
              if (stopped) return;
              await emit({
                type: "compaction_end",
                reason: event.reason,
                status: receipt.status,
                endedAt: Date.now(),
                ...(receipt.entryId === undefined
                  ? {}
                  : { entryId: await options.externalEntryId(receipt.entryId) }),
                ...(receipt.error === undefined ? {} : { error: receipt.error }),
              });
            })
            .catch((error: unknown) => {
              if (error !== receiptController.signal.reason)
                console.warn("读取压缩结果失败", error);
            });
          receipts.add(receipt);
          void receipt.finally(() => receipts.delete(receipt));
          break;
        }
      }
    }
  }

  return {
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      const wrapped = listener as (event: RuntimeEvent) => void | Promise<void>;
      set.add(wrapped);
      listeners.set(type, set);
      return () => {
        set.delete(wrapped);
      };
    },
    async start() {
      if (stopped) return;
      pending = process([stream.snapshot]);
      await pending;
      if (stopped) return;
      stream.start(async (events) => {
        pending = process(events).catch((error: unknown) =>
          console.warn("处理 durable 事件失败", error),
        );
        await pending;
      });
    },
    async flush() {
      // Let the native committed watch enqueue its delivery before joining the current batch.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await pending;
    },
    stop() {
      if (stopping !== undefined) return stopping;
      stopped = true;
      receiptController.abort();
      // Upstream stop detaches immediately but does not join its running async listener.
      // Keep the owner open until every admitted delivery and receipt observer has drained.
      const detached = stream.stop();
      stopping = (async () => {
        await detached;
        await pending;
        await Promise.allSettled([...receipts]);
        listeners.clear();
      })();
      return stopping;
    },
  };
}
