import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type Session,
  type Storage,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import { dayKeyOf } from "@/shared/local-day";
import type { UsageSample } from "./session-store";

type Counts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
type Metric = Counts & { at: number; lastAt: number };
export const UsageJournalDoc = defineDoc<{
  seen: Record<string, Counts>;
  days: Record<string, Record<string, Metric>>;
  undated: Record<string, Counts>;
}>({
  kind: "oint.usage-journal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ seen: {}, days: {}, undated: {} }),
});
const MAX_DAYS = 400;
const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const empty = (): Counts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
function add(target: Counts, source: Counts) {
  for (const key of keys) target[key] += source[key];
}
function buckets(state: Readonly<UsageState>): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const category of ["models", "tools"] as const)
    for (const [name, usage] of Object.entries(state[category])) {
      result[JSON.stringify([category, name])] = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      };
    }
  return result;
}
/** Checkpoint exact ledger snapshots, not assistant messages: failures, compaction and tool spend all count. */
export async function checkpointUsage(
  session: Session,
  conversationId: ConversationId,
  ledger: Readonly<UsageState>,
  at?: number,
) {
  await session.commit(async (tx) => {
    const journal = await tx.doc(UsageJournalDoc, conversationId);
    for (const [id, value] of Object.entries(buckets(ledger))) {
      const previous = journal.seen[id] ?? empty();
      const delta = empty();
      for (const key of keys) delta[key] = Math.max(0, value[key] - previous[key]);
      if (keys.every((key) => delta[key] === 0)) continue;
      journal.seen[id] = value;
      if (at === undefined) {
        const target = journal.undated[id] ?? empty();
        add(target, delta);
        journal.undated[id] = target;
      } else {
        const date = dayKeyOf(at);
        const day = journal.days[date] ?? {};
        const target = day[id] ?? { ...empty(), at, lastAt: at };
        add(target, delta);
        target.at = Math.min(target.at, at);
        target.lastAt = Math.max(target.lastAt, at);
        day[id] = target;
        journal.days[date] = day;
      }
    }
    const dates = Object.keys(journal.days).sort();
    for (const date of dates.slice(0, Math.max(0, dates.length - MAX_DAYS))) {
      for (const [id, value] of Object.entries(journal.days[date] ?? {})) {
        const target = journal.undated[id] ?? empty();
        add(target, value);
        journal.undated[id] = target;
      }
      delete journal.days[date];
    }
  }, context);
}

/** Install once on the family's sole Harness, before resume. The close path must flush this journal. */
export async function observeUsage(harness: Harness, storage: Storage) {
  let pending = Promise.resolve();
  const failures = new Map<ConversationId, unknown>();
  const enqueue = (conversationId: ConversationId, work: (undated: boolean) => Promise<void>) => {
    pending = pending.then(async () => {
      try {
        await work(failures.has(conversationId));
        failures.delete(conversationId);
      } catch (error) {
        failures.set(conversationId, error);
      }
    });
  };
  // Existing totals have no reliable timestamp. Never guess that they were spent today.
  const conversations = await storage.scanConversations(
    {},
    Number.MAX_SAFE_INTEGER,
    undefined,
    context,
  );
  for (const conversation of conversations.items) {
    const ledger = await harness.snapshot(UsageDoc, conversation.id, context);
    if (ledger) await checkpointUsage(harness, conversation.id, ledger);
  }
  const stop = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type !== "document" ||
        change.record.kind !== UsageDoc.definition.kind ||
        !change.value ||
        change.conversationId === undefined
      )
        continue;
      const conversationId = change.conversationId;
      const ledger = change.value as UsageState;
      const at = Date.now();
      enqueue(conversationId, (undated) =>
        checkpointUsage(harness, conversationId, ledger, undated ? undefined : at),
      );
    }
  });
  return {
    stop,
    async flush() {
      let previous: Promise<void>;
      do {
        previous = pending;
        await previous;
      } while (previous !== pending);
      if (failures.size > 0) throw failures.values().next().value;
    },
  };
}

/** Overlay uncheckpointed native totals as undated; read-only statistics do not create another Session. */
export function usageSamples(
  ledger: Readonly<UsageState>,
  journal?: ReturnType<typeof UsageJournalDoc.definition.initial>,
): UsageSample[] {
  const samples: UsageSample[] = [];
  const sample = (id: string, counts: Counts, at: number, lastAt?: number, undated = false) => {
    if (keys.every((key) => counts[key] === 0)) return;
    const [category, name] = JSON.parse(id) as [string, string];
    const slash = name.indexOf("/");
    samples.push({
      ...counts,
      at,
      ...(lastAt === undefined ? {} : { lastAt }),
      ...(undated ? { undated: true } : {}),
      ...(category === "tools"
        ? { modelId: `[tool] ${name}` }
        : slash >= 0
          ? { serviceId: name.slice(0, slash), modelId: name.slice(slash + 1) }
          : { modelId: name }),
    });
  };
  for (const day of Object.values(journal?.days ?? {}))
    for (const [id, value] of Object.entries(day)) sample(id, value, value.at, value.lastAt);
  const undated = structuredClone(journal?.undated ?? {}) as Record<string, Counts>;
  for (const [id, value] of Object.entries(buckets(ledger))) {
    const previous = journal?.seen[id] ?? empty();
    const target = undated[id] ?? empty();
    for (const key of keys) target[key] += Math.max(0, value[key] - previous[key]);
    undated[id] = target;
  }
  for (const [id, value] of Object.entries(undated)) sample(id, value, 0, undefined, true);
  return samples;
}

export function sumNativeUsage(ledger: Readonly<UsageState> | undefined): Usage {
  const result: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const category of [ledger?.models, ledger?.tools])
    for (const value of Object.values(category ?? {})) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
        result[key] += value[key];
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
        result.cost[key] += value.cost[key];
    }
  return result;
}
export type UsageJournal = JsonRepresentation<
  ReturnType<typeof UsageJournalDoc.definition.initial>
>;
