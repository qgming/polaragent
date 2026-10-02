import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type {
  AskQuestion,
  AskReply,
  AskRequest,
  AskResponse,
} from "@/shared/contracts/interaction";
import {
  createAttachmentRegistry,
  detached,
  InteractionDoc,
  InteractionTask,
  type NativeStateAttachment,
  stateContext,
} from "./native-state";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export interface InteractionServiceDeps {
  emit: (payload: ChatEventEnvelope) => void;
  timeoutMs?: number;
}
export interface AskInput {
  sessionId: string;
  toolCallId: string;
  questions: AskQuestion[];
  api: ToolExecutionApi;
  context: Context;
}
export interface InteractionService {
  readonly taskDefinitions: readonly (typeof InteractionTask)[];
  attach(attachment: NativeStateAttachment): Promise<() => void>;
  request(input: AskInput): Promise<AskResponse>;
  respond(id: string, reply: AskReply): Promise<void>;
  pending(sessionId?: string): Promise<AskRequest[]>;
  cancelSession(sessionId: string): Promise<void>;
  timeoutMs(): number;
}
export function createInteractionService(deps: InteractionServiceDeps): InteractionService {
  const waitMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attachments = createAttachmentRegistry();
  function emit(payload: ChatEventEnvelope) {
    try {
      deps.emit(payload);
    } catch (error) {
      console.warn(`发送提问事件失败：${String(error)}`);
    }
  }
  async function attach(attachment: NativeStateAttachment) {
    const detach = attachments.add(attachment);
    await attachment.harness.commit(
      (tx) => tx.doc(InteractionDoc, attachment.conversationId),
      stateContext,
    );
    const watch = await attachment.harness.watchDoc(
      InteractionDoc,
      attachment.conversationId,
      stateContext,
    );
    if (watch) {
      const publish = (value: typeof watch.value) => {
        for (const entry of Object.values(value?.entries ?? {})) {
          if (entry.response)
            emit({
              sessionId: attachment.displaySessionId,
              event: {
                type: "ask-resolved",
                id: entry.request.id,
                outcome: entry.response.outcome,
              },
            });
          else
            emit({
              sessionId: attachment.displaySessionId,
              event: { type: "ask-requested", request: entry.request },
            });
        }
      };
      publish(watch.value);
      watch.start(async (value) => publish(value));
    }
    return () => {
      detach();
      void watch?.stop();
    };
  }
  async function entries() {
    return Promise.all(
      attachments.all().map(async (attachment) => ({
        attachment,
        values: Object.values(
          (
            await attachment.harness.snapshot(
              InteractionDoc,
              attachment.conversationId,
              stateContext,
            )
          )?.entries ?? {},
        ),
      })),
    );
  }
  async function request(input: AskInput): Promise<AskResponse> {
    const attachment = attachments.require(input.sessionId);
    if (attachment.conversationId !== input.api.conversationId)
      throw new Error("Question conversation mismatch");
    const signature = createHash("sha256")
      .update(JSON.stringify([input.api.taskId, input.questions]))
      .digest("hex");
    const entry = await input.api.commit(async (tx) => {
      const doc = await tx.doc(InteractionDoc, input.api.conversationId);
      const previous = Object.values(doc.entries).find((entry) => entry.signature === signature);
      if (previous) return detached(previous);
      const id = randomUUID();
      const createdAt = Date.now();
      const taskId = await tx.createTask(
        InteractionTask,
        { id },
        {
          conversationId: input.api.conversationId,
          ownership: { kind: "task", taskId: input.api.taskId },
        },
      );
      const entry = {
        request: {
          id,
          sessionId: attachment.displaySessionId,
          toolCallId: input.toolCallId,
          questions: input.questions,
          createdAt,
        },
        taskId,
        ownerTaskId: input.api.taskId,
        signature,
        deadline: createdAt + waitMs,
      };
      doc.entries[id] = entry;
      return entry;
    }, input.context);
    const receipt = await input.api.waitForTask(entry.taskId as TaskId<AskResponse>, input.context);
    return (
      receipt.state.outcome.result ?? {
        id: entry.request.id,
        outcome: "cancelled",
        answers: [],
        note: "运行已停止",
      }
    );
  }
  async function respond(id: string, reply: AskReply) {
    for (const { attachment, values } of await entries()) {
      if (!values.some((entry) => entry.request.id === id && !entry.response)) continue;
      await attachment.harness.commit(async (tx) => {
        const doc = await tx.doc(InteractionDoc, attachment.conversationId);
        const entry = doc.entries[id];
        if (!entry || entry.response) return;
        // The deadline is authoritative even if the task has not resumed yet.
        entry.response =
          Date.now() >= entry.deadline
            ? { id, outcome: "unanswered", answers: [], note: "等待超时未回应" }
            : { id, ...reply };
      }, stateContext);
      return;
    }
  }
  async function pending(sessionId?: string) {
    return (await entries()).flatMap(({ values }) =>
      values
        .filter(
          (entry) =>
            !entry.response && (sessionId === undefined || entry.request.sessionId === sessionId),
        )
        .map((entry) => entry.request),
    );
  }
  async function cancelSession(sessionId: string) {
    for (const { attachment, values } of await entries()) {
      if (attachment.sessionId !== sessionId) continue;
      for (const entry of values)
        if (!entry.response)
          await attachment.harness.abortTask(entry.taskId as TaskId, stateContext);
    }
  }
  return {
    attach,
    taskDefinitions: [InteractionTask],
    request,
    respond,
    pending,
    cancelSession,
    timeoutMs: () => waitMs,
  };
}
