import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { HookApi, TaskId } from "@earendil-works/pi-durable";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "@/shared/contracts/approval";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { ModelRef, PermissionMode } from "@/shared/contracts/common";
import type { Settings } from "@/shared/contracts/settings";
import type { AiApprover } from "./ai-approver";
import {
  ApprovalDoc,
  ApprovalTask,
  createAttachmentRegistry,
  detached,
  type NativeStateAttachment,
  stateContext,
} from "./native-state";

export interface ApprovalServiceDeps {
  getSettings: () => Promise<Settings>;
  emit: (payload: ChatEventEnvelope) => void;
  aiApprover?: AiApprover;
}
export interface ApprovalInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsText: string;
  risk: "low" | "high";
  workingDir?: string;
  warning?: string;
  modelRef?: ModelRef;
  isSubagent?: boolean;
  signal?: AbortSignal;
  api: HookApi;
  context: Context;
}
export interface ApprovalService {
  readonly taskDefinitions: readonly (typeof ApprovalTask)[];
  attach(attachment: NativeStateAttachment): Promise<() => void>;
  request(input: ApprovalInput): Promise<ApprovalDecision>;
  respond(id: string, decision: ApprovalDecision, note?: string): Promise<void>;
  pending(sessionId?: string): Promise<ApprovalRequest[]>;
  cancelSession(sessionId: string): Promise<void>;
  history(): Promise<ApprovalRecord[]>;
}
export function effectivePermissionMode(mode: PermissionMode, isSubagent: boolean): PermissionMode {
  return isSubagent && mode === "default" ? "ai_review" : mode;
}
/** The memo belongs to the task and the final normalized name/arguments, never merely the model call id. */
function signature(input: ApprovalInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.api.taskId, input.toolName, input.argsText]))
    .digest("hex");
}
export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const attachments = createAttachmentRegistry();
  function emit(payload: ChatEventEnvelope) {
    try {
      deps.emit(payload);
    } catch (error) {
      console.warn(`发送审批事件失败：${String(error)}`);
    }
  }
  async function attach(attachment: NativeStateAttachment) {
    const detach = attachments.add(attachment);
    await attachment.harness.commit(
      (tx) => tx.doc(ApprovalDoc, attachment.conversationId),
      stateContext,
    );
    // A process restart cannot resume an external AI RPC. Hand pending cards back to the user.
    await attachment.harness.commit(async (tx) => {
      const doc = await tx.doc(ApprovalDoc, attachment.conversationId);
      for (const entry of Object.values(doc.entries)) {
        if (!entry.record && entry.request.source === "ai" && !entry.request.aiReviewed) {
          entry.request.aiReviewed = true;
          entry.request.reason = "审批已恢复，请确认是否允许";
        }
      }
    }, stateContext);
    const watch = await attachment.harness.watchDoc(
      ApprovalDoc,
      attachment.conversationId,
      stateContext,
    );
    const publish = (
      value: typeof watch extends undefined ? never : NonNullable<typeof watch>["value"],
    ) => {
      for (const entry of Object.values(value?.entries ?? {})) {
        if (entry.record)
          emit({
            sessionId: attachment.displaySessionId,
            event: {
              type: "approval-resolved",
              id: entry.request.id,
              decision: entry.record.decision,
            },
          });
        else {
          emit({
            sessionId: attachment.displaySessionId,
            event: { type: "approval-requested", request: entry.request },
          });
          if (entry.request.aiReviewed)
            emit({
              sessionId: attachment.displaySessionId,
              event: {
                type: "approval-reviewed",
                id: entry.request.id,
                reason: entry.request.reason ?? "",
              },
            });
        }
      }
    };
    if (watch) {
      publish(watch.value);
      watch.start(async (value) => publish(value));
    }
    return () => {
      detach();
      void watch?.stop();
    };
  }
  async function entries() {
    return await Promise.all(
      attachments.all().map(async (attachment) => ({
        attachment,
        values: Object.values(
          (await attachment.harness.snapshot(ApprovalDoc, attachment.conversationId, stateContext))
            ?.entries ?? {},
        ),
      })),
    );
  }
  async function settle(
    id: string,
    decision: ApprovalDecision,
    decidedBy: "user" | "ai",
    note?: string,
  ) {
    for (const { attachment, values } of await entries()) {
      if (!values.some((entry) => entry.request.id === id && !entry.record)) continue;
      await attachment.harness.commit(async (tx) => {
        const doc = await tx.doc(ApprovalDoc, attachment.conversationId);
        const entry = doc.entries[id];
        if (!entry || entry.record) return;
        entry.record = {
          request: entry.request,
          decision,
          decidedAt: Date.now(),
          decidedBy,
          ...(note === undefined ? {} : { note }),
        };
      }, stateContext);
      return;
    }
  }
  async function review(
    attachment: NativeStateAttachment,
    request: ApprovalRequest,
    input: ApprovalInput,
  ) {
    if (!deps.aiApprover) return;
    let reason: string;
    try {
      const result = await deps.aiApprover({
        toolName: request.toolName,
        argsText: request.argsText,
        ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }),
        ...(input.modelRef === undefined ? {} : { modelRef: input.modelRef }),
      });
      if (result.allow) {
        await settle(request.id, "allow_once", "ai", `AI: ${result.reason}`);
        return;
      }
      reason = result.reason;
    } catch (error) {
      reason = `AI 审批失败：${String(error)}`;
    }
    await attachment.harness.commit(async (tx) => {
      const entry = (await tx.doc(ApprovalDoc, attachment.conversationId)).entries[request.id];
      if (entry && !entry.record) {
        entry.request.aiReviewed = true;
        entry.request.reason = reason;
      }
    }, stateContext);
  }
  async function request(input: ApprovalInput): Promise<ApprovalDecision> {
    if (input.signal) input = { ...input, context: withAbortSignal(input.signal, input.context) };
    if (input.signal?.aborted || input.context.abortSignal?.aborted) return "deny";
    const attachment = attachments.require(input.sessionId);
    if (attachment.conversationId !== input.api.conversationId)
      throw new Error("Approval conversation mismatch");
    const key = signature(input);
    const memoName = `oint.approval:${key}`;
    const saved = await input.api.memo<ApprovalDecision>(memoName, input.context);
    if (saved !== undefined) return saved;
    let ai = false;
    try {
      const settings = await awaitWithContext(deps.getSettings(), input.context);
      ai =
        !!deps.aiApprover &&
        effectivePermissionMode(settings.permissionMode, input.isSubagent === true) === "ai_review";
    } catch (error) {
      if (input.signal?.aborted || input.context.abortSignal?.aborted) return "deny";
      console.warn(`读取审批设置失败，退回用户审批：${String(error)}`);
    }
    const admitted = await attachment.harness.commit(async (tx) => {
      if (input.signal?.aborted || input.context.abortSignal?.aborted) return undefined;
      const owner = await tx.task(input.api.taskId);
      if (!owner || owner.abortRequested || owner.state.status === "terminal") return undefined;
      const doc = await tx.doc(ApprovalDoc, attachment.conversationId);
      const previous = Object.values(doc.entries).find((entry) => entry.signature === key);
      if (previous) return { entry: detached(previous), fresh: false };
      const id = randomUUID();
      const taskId = await tx.createTask(
        ApprovalTask,
        { id },
        {
          conversationId: attachment.conversationId,
          ownership: { kind: "task", taskId: input.api.taskId },
        },
      );
      const request: ApprovalRequest = {
        id,
        sessionId: attachment.displaySessionId,
        toolName: input.toolName,
        argsText: input.argsText,
        risk: input.risk,
        source: ai ? "ai" : "user",
        ...(input.warning === undefined ? {} : { warning: input.warning }),
        ...(input.modelRef === undefined ? {} : { modelRef: input.modelRef }),
      };
      const entry = { request, taskId, ownerTaskId: input.api.taskId, signature: key };
      doc.entries[id] = entry;
      return { entry, fresh: true };
    }, input.context);
    if (!admitted) return "deny";
    if (admitted.fresh && ai)
      void review(attachment, admitted.entry.request, input).catch((error) =>
        console.warn(`AI 审批回填失败：${String(error)}`),
      );
    const abort = () => {
      void attachment.harness
        .abortTask(admitted.entry.taskId as TaskId, stateContext)
        .catch(() => {});
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      const terminal = await attachment.harness.waitForTask(
        admitted.entry.taskId as TaskId<ApprovalDecision>,
        input.context,
      );
      const decision = terminal.state.outcome.result ?? "deny";
      return await input.api.memo(memoName, decision, input.context);
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
  async function pending(sessionId?: string) {
    return (await entries()).flatMap(({ values }) =>
      values
        .filter(
          (entry) =>
            !entry.record && (sessionId === undefined || entry.request.sessionId === sessionId),
        )
        .map((entry) => entry.request),
    );
  }
  async function cancelSession(sessionId: string) {
    for (const { attachment, values } of await entries()) {
      if (attachment.sessionId !== sessionId) continue;
      for (const entry of values)
        if (!entry.record) await attachment.harness.abortTask(entry.taskId as TaskId, stateContext);
    }
  }
  async function history() {
    return (await entries())
      .flatMap(({ values }) => values.flatMap((entry) => (entry.record ? [entry.record] : [])))
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, 50);
  }
  return {
    attach,
    taskDefinitions: [ApprovalTask],
    request,
    respond: (id, decision, note) => settle(id, decision, "user", note),
    pending,
    cancelSession,
    history,
  };
}
