import type { JsonRepresentation } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type TaskId } from "@earendil-works/pi-durable";
import type { SubagentDefinition, SubagentRun } from "@/shared/contracts/subagent";

export type NativeSubagent = JsonRepresentation<{
  run: SubagentRun;
  definition: SubagentDefinition;
  conversationId: ConversationId;
  anchorTaskId: TaskId;
  reporterTaskId: TaskId;
  sourceTaskId: TaskId;
  progressEntryId?: number;
}>;

/** Reports are product data; scheduling and recovery belong to the referenced native tasks. */
export const SubagentsDoc = defineDoc<{ runs: Record<string, NativeSubagent> }>({
  kind: "oint.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runs: {} }),
});

export const ROOT_SESSION_ID = /^[a-f0-9-]{36}$/i;

export function parseSessionAddress(
  id: string,
): { familyId: string; conversationId?: ConversationId } | undefined {
  const [familyId, raw, extra] = id.split("~");
  if (!familyId || !ROOT_SESSION_ID.test(familyId) || extra !== undefined) return undefined;
  if (raw === undefined) return { familyId };
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const conversationId = Number(raw);
  return Number.isSafeInteger(conversationId)
    ? { familyId, conversationId: conversationId as ConversationId }
    : undefined;
}

export function childSessionId(familyId: string, conversationId: ConversationId): string {
  return `${familyId}~${conversationId}`;
}
