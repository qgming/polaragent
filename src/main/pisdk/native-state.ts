import type { Context, JsonRepresentation } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentWatch,
  defineDoc,
  defineTask,
  type Harness,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "@/shared/contracts/approval";
import type { AskRequest, AskResponse } from "@/shared/contracts/interaction";
import type { TodoState } from "./tools/todo";

/** Routing/ownership only: all application state lives in the attached Harness. */
export interface NativeStateAttachment {
  harness: Harness;
  conversationId: ConversationId;
  sessionId: string;
  displaySessionId: string;
}

/** Transaction drafts expire at commit; detach any value returned to application code. */
export function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const TodoDoc = defineDoc<JsonRepresentation<TodoState>>({
  kind: "oint.todo",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ revision: 0, todos: [] }),
});

export const TodoCallDoc = defineDoc<{ result: JsonRepresentation<TodoState> | null }>({
  kind: "oint.todo.call",
  version: 1,
  scope: "task",
  initial: () => ({ result: null }),
});

export type ApprovalEntry = JsonRepresentation<{
  request: ApprovalRequest;
  ownerTaskId: number;
  taskId: number;
  signature: string;
  record?: ApprovalRecord;
}>;
export const ApprovalDoc = defineDoc<{ entries: Record<string, ApprovalEntry> }>({
  kind: "oint.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ entries: {} }),
});

export type InteractionEntry = JsonRepresentation<{
  request: AskRequest;
  ownerTaskId: number;
  taskId: number;
  signature: string;
  deadline: number;
  response?: AskResponse;
}>;
export const InteractionDoc = defineDoc<{ entries: Record<string, InteractionEntry> }>({
  kind: "oint.interactions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ entries: {} }),
});

/** Watches are native invocation resources; no resolver table or pending-state cache. */
export async function waitForDocument<T extends JsonObject, R>(
  watch: DocumentWatch<T> | undefined,
  select: (value: Readonly<T> | null) => R | undefined,
  context: Context,
): Promise<R> {
  if (!watch) throw new Error("Durable request document is missing");
  try {
    const current = select(watch.value);
    if (current !== undefined) return current;
    return await awaitWithContext(
      new Promise<R>((resolve, reject) => {
        watch.start(async (value) => {
          const result = select(value);
          if (result !== undefined) resolve(result);
        });
        void watch.closed.then(() => reject(new Error("Durable request watch closed")));
      }),
      context,
    );
  } finally {
    await watch.stop();
  }
}

type RequestInput = { id: string };
type Waiting = { phase: "wait" };

export const ApprovalTask = defineTask<RequestInput, Waiting, ApprovalDecision>({
  name: "oint.approval",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    async wait(task, runtime, context) {
      const decision = await waitForDocument(
        await runtime.watchDoc(ApprovalDoc, task.conversationId, context),
        (value) => value?.entries[task.input.id]?.record?.decision,
        context,
      );
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: decision } }),
        context,
      );
    },
  },
  async abort(task, runtime, context) {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(ApprovalDoc, task.conversationId);
      const entry = doc.entries[task.input.id];
      if (entry && !entry.record)
        entry.record = {
          request: entry.request,
          decision: "deny",
          decidedAt: Date.now(),
          decidedBy: "user",
          note: "运行已停止",
        };
      return { status: "terminal", outcome: { status: "aborted", result: "deny" } };
    }, context);
  },
});

export const InteractionTask = defineTask<RequestInput, Waiting, JsonRepresentation<AskResponse>>({
  name: "oint.interaction",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    async wait(task, runtime, context) {
      const entry = (await runtime.snapshot(InteractionDoc, task.conversationId, context))?.entries[
        task.input.id
      ];
      if (!entry) throw new Error("Durable question is missing");
      const watch = await runtime.watchDoc(InteractionDoc, task.conversationId, context);
      try {
        const response = await Promise.race([
          waitForDocument(watch, (value) => value?.entries[task.input.id]?.response, context),
          runtime.sleep(entry.deadline, context).then(() => undefined),
        ]);
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(InteractionDoc, task.conversationId);
          const current = doc.entries[task.input.id];
          if (!current) throw new Error("Durable question is missing");
          current.response ??= response ?? {
            id: task.input.id,
            outcome: "unanswered",
            answers: [],
            note: "等待超时未回应",
          };
          return { status: "terminal", outcome: { status: "completed", result: current.response } };
        }, context);
      } finally {
        await watch?.stop();
      }
    },
  },
  async abort(task, runtime, context) {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(InteractionDoc, task.conversationId);
      const entry = doc.entries[task.input.id];
      const response = {
        id: task.input.id,
        outcome: "cancelled" as const,
        answers: [],
        note: "运行已停止",
      };
      if (entry) entry.response ??= response;
      return {
        status: "terminal",
        outcome: { status: "aborted", result: entry?.response ?? response },
      };
    }, context);
  },
});

export const nativeRequestTasks = [ApprovalTask, InteractionTask];

export function createAttachmentRegistry() {
  const attachments = new Map<string, NativeStateAttachment>();
  return {
    add(attachment: NativeStateAttachment) {
      attachments.set(attachment.sessionId, attachment);
      return () => {
        if (attachments.get(attachment.sessionId) === attachment)
          attachments.delete(attachment.sessionId);
      };
    },
    require(sessionId: string) {
      const attachment = attachments.get(sessionId);
      if (!attachment) throw new Error(`Native conversation is not attached: ${sessionId}`);
      return attachment;
    },
    all: () => [...attachments.values()],
  };
}

export { BACKGROUND_CONTEXT as stateContext };
