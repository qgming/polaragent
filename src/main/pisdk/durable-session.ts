import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  defineDoc,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";

export const AppSessionDoc = defineDoc({
  kind: "oint.session",
  version: 1,
  scope: "session",
  initial: () => ({ id: "", createdAt: 0, activeConversation: 0 }),
});

/** Native records plus the presentation identity used by IPC and React. */
export interface AppEntry {
  record: EntryRecord;
  entryId: string;
  parentId: string | null;
  /** Entry identity is monotonic; commit sequences are intentionally not exposed as entry cursors. */
  sequence: number;
  createdAt: number;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export async function readDocument(
  storage: Storage,
  kind: string,
  conversationId?: ConversationId,
) {
  const record = await storage.findDocument(
    {
      kind,
      scope:
        conversationId === undefined
          ? { kind: "session" }
          : { kind: "conversation", conversationId },
    },
    "current",
    BACKGROUND_CONTEXT,
  );
  return record === undefined
    ? undefined
    : (await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value;
}

export interface AppSessionMetadata {
  id: string;
  createdAt: number;
}

/** A single owner of one native storage connection; read-only views never construct another Session. */
export class AppSessionHandle {
  private owner?: Harness;
  private ownership: Promise<void> = Promise.resolve();
  private closed = false;
  private history?: AppEntry[];
  private historyLoading?: Promise<AppEntry[]>;
  private observed = new Map<EntryId, EntryRecord>();
  private messageCount?: number;
  private parents = new Map<EntryId, string | null>();
  private lastEntry?: EntryRecord;
  private unsubscribe?: () => void;
  private unsubscribeClose?: () => void;
  private releasePromise?: Promise<void>;
  private released?: () => void;
  private closePromise?: Promise<void>;
  constructor(
    readonly storage: Storage,
    readonly metadata: AppSessionMetadata,
    public activeConversationId: ConversationId,
    private readonly invalidate: () => void,
    initialMessageCount?: number,
  ) {
    this.messageCount = initialMessageCount;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ownership.then(operation, operation);
    this.ownership = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Wait for the previous owner to finish closing before reopening its SQLite file. */
  get releasing(): Promise<void> | undefined {
    return this.releasePromise;
  }

  private markReleasing(): void {
    this.releasePromise ??= new Promise<void>((resolve) => {
      this.released = resolve;
    });
  }

  private finishRelease(): void {
    this.unsubscribe?.();
    this.unsubscribeClose?.();
    this.closed = true;
    this.owner = undefined;
    this.invalidate();
    this.released?.();
  }

  bindHarness(factory: () => Promise<Harness>): Promise<Harness> {
    return this.serialize(async () => {
      if (this.closed || this.releasePromise) throw new Error("会话存储已关闭，请重新打开会话");
      if (!this.owner) {
        await this.primeTail(BACKGROUND_CONTEXT);
        this.owner = await factory();
        this.unsubscribeClose = this.owner.subscribeClose(() => this.markReleasing());
        this.unsubscribe = this.owner.subscribeCommits((publication) => {
          const entries = publication.changes.flatMap((change) =>
            change.type === "entry" && change.value.conversationId === this.activeConversationId
              ? [change.value]
              : [],
          );
          entries.sort((left, right) => left.id - right.id);
          for (const entry of entries) {
            if (!this.history) this.observed.set(entry.id, entry);
            const projected = this.projectEntry(entry);
            this.history?.push(projected);
            if (
              this.messageCount !== undefined &&
              (entry.kind === "pi.user" || entry.kind === "pi.assistant")
            )
              this.messageCount++;
          }
        });
      }
      return this.owner;
    });
  }

  unbindHarness(owner: Harness): Promise<void> {
    return this.serialize(async () => {
      if (this.owner !== owner) return;
      this.markReleasing();
      this.finishRelease();
    });
  }

  close(): Promise<void> {
    this.markReleasing();
    this.closePromise ??= this.serialize(async () => {
      if (this.closed) return;
      try {
        if (this.owner) await this.owner.close(BACKGROUND_CONTEXT);
        else await this.storage.close(BACKGROUND_CONTEXT);
      } finally {
        this.finishRelease();
      }
    });
    return this.closePromise;
  }

  externalEntryId(id: EntryId): string {
    return `entry:${id}`;
  }

  /** Native ID serialization at the IPC boundary; visibility is checked by storage.entry(). */
  resolveEntryId(externalId: string): EntryId | undefined {
    if (!/^entry:[1-9]\d*$/.test(externalId)) return undefined;
    const id = Number(externalId.slice(6));
    return Number.isSafeInteger(id) ? (id as EntryId) : undefined;
  }

  private async primeTail(context: Context): Promise<void> {
    const page = await this.storage.scanEntries(
      { conversationId: this.activeConversationId },
      1,
      undefined,
      context,
    );
    this.lastEntry = page.items[0];
  }

  /** One lazy chronological snapshot. Native commit notifications append immutable new entries. */
  private loadHistory(context: Context): Promise<AppEntry[]> {
    if (this.history) return Promise.resolve(this.history);
    if (this.historyLoading) return this.historyLoading;
    const conversationId = this.activeConversationId;
    const loading = (async () => {
      const records = new Map<EntryId, EntryRecord>();
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanEntries({ conversationId }, 500, cursor, context);
        for (const entry of page.items) records.set(entry.id, entry);
        cursor = page.next;
      } while (cursor !== undefined);
      if (this.activeConversationId !== conversationId) return this.loadHistory(context);
      for (const [id, entry] of this.observed) records.set(id, entry);
      const ordered = [...records.values()].sort((left, right) => left.id - right.id);
      let parent: string | null = null;
      for (const record of ordered) {
        this.parents.set(record.id, parent);
        parent = this.externalEntryId(record.id);
      }
      this.history = ordered.map((record) => this.projectEntry(record));
      this.messageCount = ordered.filter(
        (entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant",
      ).length;
      this.observed.clear();
      return this.history;
    })();
    this.historyLoading = loading;
    void loading.then(
      () => {
        if (this.historyLoading === loading) this.historyLoading = undefined;
      },
      () => {
        if (this.historyLoading === loading) this.historyLoading = undefined;
      },
    );
    return loading;
  }

  async allEntries(context: Context = BACKGROUND_CONTEXT): Promise<AppEntry[]> {
    return [...(await this.loadHistory(context))];
  }

  knownMessageCount(): number | undefined {
    return this.messageCount;
  }

  private makeProjection(record: EntryRecord, parentId: string | null): AppEntry {
    const first = record.model?.[0];
    return {
      record,
      entryId: this.externalEntryId(record.id),
      parentId,
      sequence: record.id,
      createdAt: first && "timestamp" in first ? first.timestamp : this.metadata.createdAt,
    };
  }

  projectEntry(record: EntryRecord): AppEntry {
    if (!this.parents.has(record.id)) {
      this.parents.set(
        record.id,
        this.lastEntry && this.lastEntry.id < record.id
          ? this.externalEntryId(this.lastEntry.id)
          : null,
      );
    }
    if (!this.lastEntry || record.id > this.lastEntry.id) this.lastEntry = record;
    return this.makeProjection(record, this.parents.get(record.id) ?? null);
  }

  /** Reads at most the requested page plus one predecessor, retaining exact parent links. */
  async newestPage(limit: number, before: number | undefined, context: Context) {
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 1))
      return { entries: [], hasMore: false };
    const bound = before === undefined ? undefined : this.resolveEntryId(`entry:${before - 1}`);
    const page = await this.storage.scanEntries(
      {
        conversationId: this.activeConversationId,
        ...(bound === undefined ? {} : { maxEntryId: bound }),
      },
      limit + 1,
      undefined,
      context,
    );
    const selected = page.items.slice(0, limit);
    const entries = selected
      .map((record, index) => {
        const previous = page.items[index + 1];
        const parent = previous ? this.externalEntryId(previous.id) : null;
        this.parents.set(record.id, parent);
        return this.makeProjection(record, parent);
      })
      .reverse();
    return { entries, hasMore: page.items.length > limit };
  }

  /** Oldest-first consumers reuse one sorted snapshot and locate their cursor in logarithmic time. */
  async oldestPage(limit: number, after: number, context: Context) {
    const history = await this.loadHistory(context);
    let low = 0,
      high = history.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const entry = history[mid];
      if (entry && entry.sequence <= after) low = mid + 1;
      else high = mid;
    }
    return { entries: history.slice(low, low + limit), hasMore: low + limit < history.length };
  }

  async getEntry(externalId: string, context: Context): Promise<AppEntry | undefined> {
    const id = this.resolveEntryId(externalId);
    if (id === undefined) return undefined;
    const found = await this.storage.entry(this.activeConversationId, id, context);
    if (!found) return undefined;
    const page = await this.storage.scanEntries(
      { conversationId: this.activeConversationId, maxEntryId: id },
      2,
      undefined,
      context,
    );
    const previous = page.items.find((entry) => entry.id < id);
    const parent = previous ? this.externalEntryId(previous.id) : null;
    this.parents.set(id, parent);
    return this.makeProjection(found.entry, parent);
  }

  async getStats(context: Context) {
    await this.loadHistory(context);
    const usage = emptyUsage();
    const conversations = await this.storage.scanConversations(
      {},
      Number.MAX_SAFE_INTEGER,
      undefined,
      context,
    );
    for (const conversation of conversations.items) {
      const ledger = await readDocument(this.storage, "pi.usage", conversation.id);
      for (const category of [ledger?.models, ledger?.tools]) {
        if (!category || typeof category !== "object" || Array.isArray(category)) continue;
        for (const bucket of Object.values(category)) {
          if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
          for (const key of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "totalTokens",
          ] as const) {
            const value = bucket[key];
            if (typeof value === "number") usage[key] += value;
          }
          for (const key of ["reasoning", "cacheWrite1h"] as const) {
            const value = bucket[key];
            if (typeof value === "number") usage[key] = (usage[key] ?? 0) + value;
          }
          const cost = bucket.cost;
          if (cost && typeof cost === "object" && !Array.isArray(cost)) {
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
              const value = cost[key];
              if (typeof value === "number") usage.cost[key] += value;
            }
          }
        }
      }
    }
    const messageCount = this.messageCount ?? 0;
    return { messageCount, usage };
  }

  async forkAndSelect(at: string | null, context: Context): Promise<Conversation> {
    const owner = this.owner;
    if (!owner) throw new Error("重试需要打开的会话运行时");
    const active = await owner.conversation(this.activeConversationId, context);
    if (!active) throw new Error("当前会话不存在");
    const inspection = await owner.inspect(context);
    if (
      inspection.tasks.some((task) => task.record.conversationId === active.id) ||
      inspection.submissions.some((submission) => submission.conversationId === active.id)
    ) {
      throw new Error("会话仍有运行或排队的工作，无法切换分支");
    }
    const selected = at === null ? undefined : await this.getEntry(at, context);
    const target = selected?.record.id;
    if (at !== null && target === undefined) throw new Error(`条目不存在：${at}`);
    const agent = await owner.snapshot(AgentDoc, active.id, context);
    const next = await owner.commit(async (tx) => {
      const meta = await tx.doc(AppSessionDoc);
      const record =
        target === undefined
          ? await tx.createConversation({ ownership: { kind: "ownerless" } })
          : await tx.forkConversation(active.id, target, { ownership: { kind: "ownerless" } });
      if (target === undefined && agent) Object.assign(await tx.doc(AgentDoc, record.id), agent);
      meta.activeConversation = record.id;
      return record.id;
    }, context);
    this.activeConversationId = next;
    this.history = undefined;
    this.historyLoading = undefined;
    this.observed.clear();
    this.messageCount = undefined;
    this.parents.clear();
    this.lastEntry = undefined;
    await this.primeTail(context);
    const conversation = await owner.conversation(next, context);
    if (!conversation) throw new Error("无法打开重试分支");
    return conversation;
  }
}
