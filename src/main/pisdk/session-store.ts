import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  type EntryId,
  Harness,
  type Storage,
  type UsageState,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { dataDir, sessionWorkspaceDir, workspacesDir } from "@/main/app/paths";
import { type AgentMode, type ModelRef, normalizeAgentMode } from "@/shared/contracts/common";
import type {
  ChatMessage,
  SessionCreateOptions,
  SessionKind,
  SessionSummary,
  SessionUsageRecord,
} from "@/shared/contracts/session";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { createAttachmentForkCopier, removeSessionAttachments } from "./attachments";
import {
  AppSessionDoc,
  AppSessionHandle,
  type AppSessionMetadata,
  readDocument,
  SessionHandleReleased,
  SessionMetadataDoc,
  SessionPerformanceDoc,
} from "./durable-session";
import { JobsDoc } from "./jobs";
import { mapEntriesToMessages } from "./message-mapper";
import { type JobReportRecord, nativeReports, projectReportMessages } from "./native-reports";
import { TodoDoc } from "./native-state";
import {
  type NativeSubagent,
  parseSessionAddress,
  ROOT_SESSION_ID,
  SubagentsDoc,
} from "./native-subagents";
import { sumNativeUsage, type UsageJournal, UsageJournalDoc, usageSamples } from "./native-usage";
import { createSessionsIndex, type SessionIndexEntry } from "./sessions-index";

export interface OpenedSession {
  session: AppSessionHandle;
  storage: Storage;
  conversationId: import("@earendil-works/pi-durable").ConversationId;
  familyId: string;
  subagent?: NativeSubagent;
}
type LocalIndexEntry = SessionIndexEntry & {
  /** 会话种类；缺省按 chat（旧索引里没有这个字段） */
  kind?: SessionKind;
  /** 发起它的主会话 id；pi 元数据里也有，索引这份是 create 场景的兜底 */
  parentSessionId?: string;
  /** 子智能体运行：派发它的那次 Task 工具调用 id 与子智能体名 */
  parentToolCallId?: string;
  agentName?: string;
};

export interface LoadMessagesOptions {
  limit?: number;
  /** 游标：加载 seq 严格小于该值的更早条目 */
  beforeSeq?: number;
  /**
   * 取哪一端：默认 newestFirst（会话尾部，供翻页加载）；
   * oldestFirst 取会话开头的条目 —— 自动命名要看首轮问答，必须从开头读。
   */
  order?: "newestFirst" | "oldestFirst";
}

export interface LoadMessagesResult {
  messages: ChatMessage[];
  compactionSummaries: string[];
  nextCursor?: number;
}

/** A native ledger bucket at an observed date, or an explicitly undated remainder. */
export interface UsageSample {
  /** Earliest observed spend in this bucket; zero only for undated samples. */
  at: number;
  lastAt?: number;
  /** Native aggregate spend whose original date was not durably observed. */
  undated?: boolean;
  serviceId?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One page of the current bounded journal snapshot. Cursors are offsets within this query. */
export interface UsageScanResult {
  samples: UsageSample[];
  /** Next sample offset; start a fresh report at zero. */
  nextSeq: number;
  /** Number of projected journal samples. */
  entries: number;
  /** Whether this snapshot has more samples. */
  done: boolean;
}

export interface SessionStore {
  /** 合并索引元数据；archived 可见性由调用方按设置过滤 */
  list(): Promise<SessionSummary[]>;
  /** 新建会话：从属会话（subagent）通过 options 带上种类与归属信息 */
  create(options?: SessionCreateOptions): Promise<SessionSummary>;
  open(id: string): Promise<OpenedSession | undefined>;
  close(): Promise<void>;
  release(id: string, owner: Harness): Promise<void>;
  /** Persist the application title in the native metadata document. */
  rename(id: string, title: string): Promise<void>;
  renameIfUntitled?(id: string, title: string): Promise<boolean>;
  /** 当前标题（null = 还没有名字，自动命名据此判断是否该生成） */
  readTitle(id: string): Promise<string | null>;
  setArchived(id: string, archived: boolean): Promise<void>;
  /** Pin preference in the native metadata document. */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** 会话绑定的工作目录（索引 cwd）；未绑定返回 null */
  readCwd(id: string): Promise<string | null>;
  /**
   * 会话的工作目录，**没有就现补一个**（`<数据根>/workspaces/<会话 id>`，并写回索引）。
   *
   * 与 readCwd 的差别只在「没有绑定」这一类会话上：readCwd 回 null，这个建目录并绑定。
   * 文件面板 / 终端 / 执行环境要的是「一个能用的根」，不是「有没有绑过」这个事实 ——
   * 早先它们拿 null 当错误，表现是「模型写过的文件在右侧一律打不开」。
   *
   * 会话不存在时抛错（否则会为一个拼错 / 已删的 id 留下一个没人认领的目录）。
   */
  ensureCwd(id: string): Promise<string>;
  /**
   * 重新绑定会话的工作目录。
   *
   * 新会话页上的「选择项目」用它：会话在创建时就已经有一个根（显式给的目录，或本会话的
   * 临时工作区），所以「先选项目再开聊」只能表现为**改绑定**，而不是创建时传参。
   *
   * 只对还没有消息的会话开放，目标必须是已存在的目录；不满足时抛错（见实现里的说明）。
   */
  setCwd(id: string, cwd: string): Promise<void>;
  /** 会话自己指定的模型；未绑定返回 null（调用方据此回落到默认模型） */
  readModel(id: string): Promise<ModelRef | null>;
  /** 写会话级模型绑定；null 表示清除绑定（回到「跟随默认」） */
  setModel(id: string, model: ModelRef | null): Promise<void>;
  /** 会话自己指定的智能体模式；未绑定返回 null（调用方据此回落到设置里的默认） */
  readAgentMode(id: string): Promise<AgentMode | null>;
  /** 写会话级模式绑定；null 表示清除绑定（回到「跟随默认」） */
  setAgentMode(id: string, mode: AgentMode | null): Promise<void>;
  /** 物理删除 sqlite 文件并清索引 */
  remove(id: string): Promise<void>;
  /** 在指定条目处创建分支会话（scope:"branch", position:"at"） */
  fork(id: string, entryId: string): Promise<SessionSummary>;
  loadMessages(id: string, options?: LoadMessagesOptions): Promise<LoadMessagesResult>;
  /**
   * 读会话的用量快照（统计 / Token 合计 / 上下文分解）。
   *
   * 没有记录（新会话，或升级前建的旧会话）时返回 undefined —— 调用方据此
   * 显示空状态，而不是渲染一份全 0 的假数据。
   */
  readUsage(id: string): Promise<SessionUsageRecord | undefined>;
  /**
   * Store derived performance and context estimates; native UsageDoc remains token authority.
   *
   * **不刷新 updatedAt**：这是展示派生数据的更新，不该让会话在侧栏里跳到最前
   * （那条排序属于「有新消息」这个语义，见 touch 的默认行为）。
   */
  writeUsage(id: string, usage: SessionUsageRecord): Promise<void>;
  /** 运行结束等场景更新索引（默认刷新 updatedAt） */
  touch(id: string, patch?: SessionIndexEntry): Promise<void>;
  /** 某个父会话的全部运行记录（含本进程没见过的历史运行），按 startedAt 升序 */
  listSubagentRunsFor(parentSessionId: string): Promise<SubagentRun[]>;
  /** Read the native journal snapshot. Root queries include ownerless retries; children include only their own spend. */
  scanUsageSamples(id: string, afterSeq: number, maxEntries: number): Promise<UsageScanResult>;
}

function normalizeSessionKind(raw: unknown): SessionKind {
  return raw === "subagent" ? raw : "chat";
}

function toSummary(meta: AppSessionMetadata, entry?: LocalIndexEntry): SessionSummary {
  const parentSessionId = entry?.parentSessionId;
  return {
    id: meta.id,
    // 空串/纯空白与「没有标题」是同一件事：归一成 null，消费方只需处理一种空值（与 readTitle 同口径）
    title: entry?.title?.trim() || null,
    createdAt: meta.createdAt,
    updatedAt: entry?.updatedAt ?? meta.createdAt,
    cwd: entry?.cwd ?? "",
    kind: normalizeSessionKind(entry?.kind),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(entry?.parentToolCallId === undefined ? {} : { parentToolCallId: entry.parentToolCallId }),
    ...(entry?.agentName === undefined ? {} : { agentName: entry.agentName }),
    archived: entry?.archived ?? false,
    pinned: entry?.pinned ?? false,
    messageCount: entry?.messageCount ?? 0,
    model: normalizeModelRef(entry?.model),
    agentMode: normalizeAgentMode(entry?.agentMode),
  };
}

/** 索引里的 model 是外部 JSON，可能被手改坏：只认完整的 {serviceId, modelId} 字符串对 */
function normalizeModelRef(raw: unknown): ModelRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const serviceId = typeof record.serviceId === "string" ? record.serviceId.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  if (serviceId === "" || modelId === "") return null;
  return { serviceId, modelId };
}

export interface SessionStoreOptions {
  now?: () => number;
  openStorage?: (file: string) => Promise<Storage>;
}
const PAGE_SIZE = 40;
const SESSION_ID = ROOT_SESSION_ID;

/** Native documents own metadata, metrics and transcripts; the JSON catalogue is disposable. */
export function createSessionStore(
  baseDir: string,
  options: SessionStoreOptions = {},
): SessionStore {
  const directory = path.join(baseDir, "sessions-v1");
  const index = createSessionsIndex(baseDir);
  const now = options.now ?? Date.now;
  const openStorage = options.openStorage ?? openNodeSqliteStorage;
  const handles = new Map<string, Promise<OpenedSession | undefined>>();
  const removing = new Set<string>();
  let metadata: Map<string, AppSessionMetadata> | undefined;
  let metadataRead: Promise<Map<string, AppSessionMetadata>> | undefined;
  const filename = (id: string) => {
    if (!SESSION_ID.test(id)) throw new Error(`非法会话 ID：${id}`);
    return path.join(directory, `${id}.sqlite`);
  };

  async function openHandle(id: string): Promise<OpenedSession | undefined> {
    const address = parseSessionAddress(id);
    if (!address || removing.has(address.familyId)) return undefined;
    if (address.conversationId !== undefined) {
      const family = await openHandle(address.familyId);
      if (!family) return undefined;
      const existing = await handles.get(id);
      if (existing && !existing.session.releasing) return existing;
      const conversation = await family.storage.conversation(
        address.conversationId,
        BACKGROUND_CONTEXT,
      );
      if (!conversation?.owner) return undefined;
      const native = await readDocument(
        family.storage,
        SubagentsDoc.definition.kind,
        conversation.owner.conversationId,
      );
      const runs = native?.runs as Record<string, NativeSubagent> | undefined;
      const subagent = Object.values(runs ?? {}).find(
        (entry) => entry.conversationId === address.conversationId,
      );
      if (!subagent) return undefined;
      const session = new AppSessionHandle(
        family.storage,
        { id, createdAt: subagent.run.startedAt },
        address.conversationId,
        () => {
          handles.delete(id);
        },
        undefined,
        family.session,
      );
      const opened = {
        session,
        storage: family.storage,
        get conversationId() {
          return session.activeConversationId;
        },
        familyId: address.familyId,
        subagent,
      };
      handles.set(id, Promise.resolve(opened));
      return opened;
    }
    const existing = handles.get(id);
    if (existing) {
      const opened = await existing;
      if (opened?.session.releasing) {
        await opened.session.releasing;
        return openHandle(id);
      }
      return opened;
    }
    const pending = (async () => {
      if (!(await stat(filename(id)).catch(() => undefined))?.isFile()) return undefined;
      const storage = await openStorage(filename(id));
      try {
        const value = await readDocument(storage, AppSessionDoc.definition.kind);
        if (
          value?.id !== id ||
          typeof value.createdAt !== "number" ||
          typeof value.activeConversation !== "number"
        ) {
          throw new Error("缺少有效的会话元数据");
        }
        const conversations = await storage.scanConversations(
          {},
          Number.MAX_SAFE_INTEGER,
          undefined,
          BACKGROUND_CONTEXT,
        );
        const active = conversations.items.find((entry) => entry.id === value.activeConversation);
        if (!active) throw new Error("当前会话不存在");
        const attributes = (await readDocument(storage, SessionMetadataDoc.definition.kind))
          ?.attributes as LocalIndexEntry | undefined;
        const session = new AppSessionHandle(
          storage,
          { id, createdAt: value.createdAt },
          active.id,
          () => {
            if (handles.get(id) === pending) handles.delete(id);
          },
          attributes?.messageCount,
        );
        return {
          session,
          storage,
          get conversationId() {
            return session.activeConversationId;
          },
          familyId: id,
        };
      } catch (error) {
        await storage.close(BACKGROUND_CONTEXT);
        throw error;
      }
    })();
    handles.set(id, pending);
    void pending.then(
      (value) => {
        if (!value && handles.get(id) === pending) handles.delete(id);
      },
      () => {
        if (handles.get(id) === pending) handles.delete(id);
      },
    );
    return pending;
  }

  async function listMetas(): Promise<Map<string, AppSessionMetadata>> {
    if (metadata) return metadata;
    if (metadataRead) return metadataRead;
    metadataRead = (async () => {
      const found = new Map<string, AppSessionMetadata>();
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files) {
        if (!file.endsWith(".sqlite")) continue;
        const id = file.slice(0, -7);
        if (!SESSION_ID.test(id)) continue;
        try {
          const cached = await handles.get(id);
          if (cached) {
            found.set(id, cached.session.metadata);
            continue;
          }
          const storage = await openStorage(filename(id));
          try {
            const value = await readDocument(storage, AppSessionDoc.definition.kind);
            if (value?.id !== id || typeof value.createdAt !== "number")
              throw new Error("无效会话元数据");
            found.set(id, { id, createdAt: value.createdAt });
          } finally {
            await storage.close(BACKGROUND_CONTEXT);
          }
        } catch (error) {
          console.warn(`读取会话失败 ${id}: ${String(error)}`);
        }
      }
      metadata = found;
      return found;
    })();
    try {
      return await metadataRead;
    } finally {
      metadataRead = undefined;
    }
  }

  async function readFamily<T>(
    id: string,
    operation: (storage: Storage) => Promise<T>,
    drainUsage = false,
  ): Promise<T | undefined> {
    const address = parseSessionAddress(id);
    if (!address || removing.has(address.familyId)) return undefined;
    const cached = await handles.get(address.familyId);
    if (cached) {
      try {
        if (drainUsage) {
          try {
            await cached.session.flushUsage();
          } catch (error) {
            console.warn(`用量日期记录未完成，未确认日期的部分按未知日期统计：${String(error)}`);
          }
        }
        return await cached.session.readStorage(operation);
      } catch (error) {
        if (!(error instanceof SessionHandleReleased)) throw error;
        await cached.session.releasing;
        return readFamily(id, operation, drainUsage);
      }
    }
    if (!(await stat(filename(address.familyId)).catch(() => undefined))?.isFile())
      return undefined;
    const storage = await openStorage(filename(address.familyId));
    try {
      return await operation(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  async function readMetadata(id: string): Promise<LocalIndexEntry | undefined> {
    return readFamily(
      id,
      async (storage) =>
        (await readDocument(storage, SessionMetadataDoc.definition.kind))?.attributes as
          | LocalIndexEntry
          | undefined,
    );
  }
  async function mutateSession<T>(
    id: string,
    operation: (
      session: import("@earendil-works/pi-durable").Session,
      opened: OpenedSession,
    ) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const opened = await openHandle(id);
      if (!opened) throw new Error(`会话不存在：${id}`);
      try {
        return await opened.session.withSession((session) => operation(session, opened));
      } catch (error) {
        if (!(error instanceof SessionHandleReleased)) throw error;
      }
    }
  }
  async function updateMetadata(id: string, patch: LocalIndexEntry) {
    if (!SESSION_ID.test(id)) return;
    await mutateSession(id, (session, opened) =>
      session.commit(async (tx) => {
        Object.assign((await tx.doc(SessionMetadataDoc)).attributes, patch);
        if (patch.cwd !== undefined)
          (await tx.doc(AgentDoc, opened.session.activeConversationId)).cwd = patch.cwd;
      }, BACKGROUND_CONTEXT),
    );
    // Disposable catalogue only. It can be deleted without losing user metadata.
    try {
      await index.update(id, patch);
    } catch (error) {
      console.warn(`刷新会话目录缓存失败：${String(error)}`);
    }
  }
  async function ensureWorkspaceDir(id: string) {
    const cwd = sessionWorkspaceDir(id, baseDir);
    await mkdir(cwd, { recursive: true });
    return cwd;
  }
  async function list() {
    const metas = await listMetas();
    const entries: Record<string, LocalIndexEntry> = {};
    for (const meta of metas.values()) {
      const attributes = (await readMetadata(meta.id)) ?? {};
      const known = (await handles.get(meta.id))?.session.knownMessageCount();
      if (known !== undefined) attributes.messageCount = known;
      entries[meta.id] = attributes;
    }
    for (const meta of metas.values()) {
      if (!entries[meta.id]?.cwd?.trim()) {
        const cwd = await ensureWorkspaceDir(meta.id);
        entries[meta.id] = { ...entries[meta.id], cwd };
        await updateMetadata(meta.id, { cwd });
      }
    }
    const summaries = [...metas.values()].map((meta) => toSummary(meta, entries[meta.id]));
    for (const meta of metas.values()) {
      for (const run of await listSubagentRunsFor(meta.id)) {
        summaries.push(
          toSummary(
            { id: run.childSessionId, createdAt: run.startedAt },
            {
              kind: "subagent",
              parentSessionId: meta.id,
              parentToolCallId: run.parentToolCallId,
              agentName: run.agentName,
              title: `${run.agentName} · ${run.description}`,
              cwd: entries[meta.id]?.cwd,
              model: run.model,
              updatedAt: run.updatedAt ?? run.startedAt,
            },
          ),
        );
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function create(input: SessionCreateOptions = {}) {
    if (input.kind === "subagent") throw new Error("子智能体必须由原生任务创建");
    const id = randomUUID();
    const createdAt = now();
    const cwd = input.cwd?.trim() ? input.cwd : await ensureWorkspaceDir(id);
    await mkdir(directory, { recursive: true });
    const storage = await openStorage(filename(id));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd } });
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(AppSessionDoc), { id, createdAt, activeConversation: root.id });
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    const entry: LocalIndexEntry = {
      cwd,
      updatedAt: createdAt,
      messageCount: 0,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.parentToolCallId === undefined ? {} : { parentToolCallId: input.parentToolCallId }),
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
    };
    await updateMetadata(id, entry);
    const meta = { id, createdAt };
    if (metadataRead) await metadataRead;
    metadata?.set(id, meta);
    return toSummary(meta, entry);
  }
  async function rename(id: string, title: string) {
    if (await openHandle(id)) await updateMetadata(id, { title });
  }
  async function renameIfUntitled(id: string, title: string): Promise<boolean> {
    if (!(await openHandle(id))) return false;
    const changed = await mutateSession(id, (session) =>
      session.commit(async (tx) => {
        const metadata = (await tx.doc(SessionMetadataDoc)).attributes;
        if (metadata.title?.trim()) return false;
        metadata.title = title;
        return true;
      }, BACKGROUND_CONTEXT),
    );
    if (changed) {
      // Read the current value after commit so a concurrent manual rename wins in the cache too.
      const current = await readMetadata(id);
      try {
        await index.update(id, { title: current?.title });
      } catch (error) {
        console.warn(`刷新会话目录缓存失败：${String(error)}`);
      }
    }
    return changed;
  }
  async function readTitle(id: string) {
    return (await readMetadata(id))?.title?.trim() || null;
  }
  async function readCwd(id: string) {
    const familyId = parseSessionAddress(id)?.familyId ?? id;
    const cwd = (await readMetadata(familyId))?.cwd;
    return cwd?.trim() ? cwd : null;
  }
  async function ensureCwd(id: string) {
    if (!(await openHandle(id))) throw new Error(`会话不存在：${id}`);
    const cwd = await readCwd(id);
    if (cwd) return cwd;
    const generated = await ensureWorkspaceDir(id);
    await updateMetadata(id, { cwd: generated });
    return generated;
  }
  async function removeWorkspace(id: string, cwd: string | null) {
    if (!cwd) return;
    const target = path.resolve(cwd);
    if (path.dirname(target) !== path.resolve(workspacesDir(baseDir))) return;
    for (const other of (await listMetas()).keys()) {
      if (other === id) continue;
      const otherCwd = await readCwd(other);
      if (otherCwd && path.resolve(otherCwd) === target) return;
    }
    await rm(target, { recursive: true, force: true });
  }
  async function setCwd(id: string, cwd: string) {
    const target = cwd.trim();
    if (!target) throw new Error("工作目录不能为空");
    const opened = await openHandle(id);
    if (!opened) throw new Error(`会话不存在：${id}`);
    if ((await opened.session.getStats(BACKGROUND_CONTEXT)).messageCount > 0)
      throw new Error("会话已有消息，不能再改工作目录");
    if (!(await stat(target).catch(() => undefined))?.isDirectory())
      throw new Error(`目录不存在：${target}`);
    const previous = await readCwd(id);
    await updateMetadata(id, { cwd: target });
    if (previous && path.resolve(previous) !== path.resolve(target))
      await removeWorkspace(id, previous);
  }
  async function remove(id: string) {
    if (!SESSION_ID.test(id)) throw new Error("子智能体转录随主会话一起删除");
    const cwd = await readCwd(id);
    removing.add(id);
    try {
      for (const [address, pending] of handles) {
        if (address.startsWith(`${id}~`)) await (await pending)?.session.close();
      }
      const opened = await handles.get(id);
      if (opened) await opened.session.close();
      await rm(filename(id), { force: true });
      await index.remove(id);
      metadata?.delete(id);
      await removeWorkspace(id, cwd);
      await removeSessionAttachments(id, baseDir);
    } finally {
      removing.delete(id);
    }
  }

  async function fork(id: string, externalId: string) {
    const source = await openHandle(id);
    if (!source) throw new Error(`源会话不存在：${id}`);
    const history = await source.session.allEntries();
    const cutoff = history.findIndex((entry) => entry.entryId === externalId);
    if (cutoff < 0) throw new Error(`条目不存在：${externalId}`);
    const selected = history[cutoff];
    if (!selected) throw new Error(`条目不存在：${externalId}`);
    const sourceIndex = await readMetadata(id);
    const created = await create({
      title: sourceIndex?.title ? `${sourceIndex.title} · 分支` : undefined,
      cwd: sourceIndex?.cwd,
      parentSessionId: id,
    });
    const destination = await openHandle(created.id);
    if (!destination) throw new Error("无法创建分支会话");
    const owner = await destination.session.bindHarness(() =>
      Harness.open(
        destination.storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      ),
    );
    try {
      const copyAttachments = createAttachmentForkCopier(id, created.id, baseDir);
      const copiedHistory = await Promise.all(
        history.slice(0, cutoff + 1).map(async ({ record }) => ({
          ...record,
          ...(record.model ? { model: await copyAttachments(record.model) } : {}),
          ...(record.edits
            ? {
                edits: await Promise.all(
                  record.edits.map(async (edit) =>
                    edit.action === "replace"
                      ? { ...edit, messages: await copyAttachments(edit.messages) }
                      : edit,
                  ),
                ),
              }
            : {}),
        })),
      );
      // Reproduce each historical document boundary so a later native retry of this
      // independent chat also rewinds its app state to the selected entry.
      const ids = new Map<EntryId, EntryId>();
      for (const record of copiedHistory) {
        const point = await source.storage.entry(
          source.session.activeConversationId,
          record.id,
          BACKGROUND_CONTEXT,
        );
        if (!point) throw new Error("分支条目不可见");
        const readAt = async (kind: string) => {
          const document = await source.storage.findDocument(
            { kind, scope: { kind: "conversation", conversationId: point.entry.conversationId } },
            point.commitSeq,
            BACKGROUND_CONTEXT,
          );
          return document
            ? (await source.storage.document(document.id, point.commitSeq, BACKGROUND_CONTEXT))
                ?.value
            : undefined;
        };
        const [agent, todo] = await Promise.all([
          readAt(AgentDoc.definition.kind),
          readAt(TodoDoc.definition.kind),
        ]);
        await owner.commit(async (tx) => {
          if (agent) Object.assign(await tx.doc(AgentDoc, destination.conversationId), agent);
          if (todo) Object.assign(await tx.doc(TodoDoc, destination.conversationId), todo);
          const copy = await tx.appendEntry(destination.conversationId, {
            kind: record.kind,
            ...(record.model ? { model: record.model } : {}),
            ...(record.data === undefined ? {} : { data: record.data }),
            ...(record.head === undefined
              ? {}
              : { head: record.head === record.id ? "self" : ids.get(record.head) }),
            ...(record.edits === undefined
              ? {}
              : {
                  edits: record.edits.map((edit) => {
                    const target = ids.get(edit.target);
                    if (target === undefined) throw new Error("上下文编辑指向分支外的条目");
                    return { ...edit, target };
                  }),
                }),
          });
          ids.set(record.id, copy.id);
        }, BACKGROUND_CONTEXT);
      }
      await updateMetadata(created.id, {
        model: sourceIndex?.model ?? null,
        agentMode: sourceIndex?.agentMode ?? null,
        messageCount: (await destination.session.getStats(BACKGROUND_CONTEXT)).messageCount,
      });
    } catch (error) {
      await destination.session.close();
      await remove(created.id);
      throw error;
    } finally {
      await destination.session.close();
    }
    return toSummary(created, await readMetadata(created.id));
  }

  async function loadMessages(
    id: string,
    options: LoadMessagesOptions = {},
  ): Promise<LoadMessagesResult> {
    const opened = await openHandle(id);
    if (!opened) return { messages: [], compactionSummaries: [] };
    const limit = Math.max(1, options.limit ?? PAGE_SIZE);
    const newest = options.order !== "oldestFirst";
    const result = newest
      ? await opened.session.newestPage(limit, options.beforeSeq, BACKGROUND_CONTEXT)
      : await opened.session.oldestPage(limit, options.beforeSeq ?? 0, BACKGROUND_CONTEXT);
    const page = result.entries;
    const mapped = mapEntriesToMessages(page);
    const [agentState, jobState] = await Promise.all([
      readDocument(
        opened.storage,
        SubagentsDoc.definition.kind,
        opened.session.activeConversationId,
      ),
      readDocument(opened.storage, JobsDoc.definition.kind, opened.session.activeConversationId),
    ]);
    const reports = nativeReports(
      Object.values((agentState?.runs ?? {}) as unknown as Record<string, NativeSubagent>).map(
        (record) => record.run,
      ),
      Object.values((jobState?.entries ?? {}) as unknown as Record<string, JobReportRecord>),
    );
    mapped.messages = projectReportMessages(mapped.messages, reports);
    const next = newest ? page[0]?.sequence : page.at(-1)?.sequence;
    return {
      ...mapped,
      ...(result.hasMore && next !== undefined ? { nextCursor: next } : {}),
    };
  }
  async function scanUsageSamples(
    id: string,
    afterSeq: number,
    maxEntries: number,
  ): Promise<UsageScanResult> {
    return (
      (await readFamily(
        id,
        async (storage) => {
          const address = parseSessionAddress(id);
          const conversations = await storage.scanConversations(
            {},
            Number.MAX_SAFE_INTEGER,
            undefined,
            BACKGROUND_CONTEXT,
          );
          const selected =
            address?.conversationId !== undefined
              ? conversations.items.filter((item) => item.id === address.conversationId)
              : conversations.items.filter((item) => !item.owner);
          const samples: UsageSample[] = [];
          for (const conversation of selected) {
            const ledger = (await readDocument(storage, "pi.usage", conversation.id)) as
              | UsageState
              | undefined;
            if (!ledger) continue;
            const journal = (await readDocument(
              storage,
              UsageJournalDoc.definition.kind,
              conversation.id,
            )) as UsageJournal | undefined;
            samples.push(...usageSamples(ledger, journal));
          }
          samples.sort((a, b) => a.at - b.at || (a.modelId ?? "").localeCompare(b.modelId ?? ""));
          const start = Math.max(0, afterSeq);
          const page = samples.slice(start, start + Math.max(1, Math.floor(maxEntries)));
          return {
            samples: page,
            nextSeq: start + page.length,
            entries: page.length,
            done: start + page.length >= samples.length,
          };
        },
        true,
      )) ?? { samples: [], nextSeq: afterSeq, entries: 0, done: true }
    );
  }
  async function listSubagentRunsFor(id: string): Promise<SubagentRun[]> {
    return (
      (await readFamily(id, async (storage) => {
        const address = parseSessionAddress(id);
        const conversations = await storage.scanConversations(
          {},
          Number.MAX_SAFE_INTEGER,
          undefined,
          BACKGROUND_CONTEXT,
        );
        const runs = new Map<string, SubagentRun>();
        for (const conversation of conversations.items) {
          if (address?.conversationId !== undefined && conversation.id !== address.conversationId)
            continue;
          const state = await readDocument(storage, SubagentsDoc.definition.kind, conversation.id);
          for (const entry of Object.values((state?.runs ?? {}) as Record<string, NativeSubagent>))
            runs.set(entry.run.delegationId, entry.run);
        }
        return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
      })) ?? []
    );
  }
  async function close() {
    const opened = await Promise.all(handles.values());
    await Promise.all(opened.map((value) => value?.session.close()));
  }
  return {
    list,
    create,
    open: openHandle,
    close,
    release: async (id, owner) => {
      const opened = await handles.get(id);
      if (opened) await opened.session.unbindHarness(owner);
    },
    rename,
    renameIfUntitled,
    readTitle,
    readCwd,
    ensureCwd,
    setCwd,
    remove,
    fork,
    loadMessages,
    scanUsageSamples,
    setArchived: (id, archived) => updateMetadata(id, { archived }),
    setPinned: (id, pinned) => updateMetadata(id, { pinned }),
    readModel: async (id) =>
      (await openHandle(id))?.subagent?.definition.model ??
      normalizeModelRef((await readMetadata(id))?.model),
    setModel: (id, model) => updateMetadata(id, { model }),
    readAgentMode: async (id) => normalizeAgentMode((await readMetadata(id))?.agentMode),
    setAgentMode: (id, agentMode) => updateMetadata(id, { agentMode }),
    readUsage: async (id) => {
      const opened = await openHandle(id);
      if (!opened) return undefined;
      const conversationId = opened.session.activeConversationId;
      const saved = await readDocument(
        opened.storage,
        SessionPerformanceDoc.definition.kind,
        conversationId,
      );
      const ledger = (await readDocument(opened.storage, "pi.usage", conversationId)) as
        | UsageState
        | undefined;
      if (
        !saved?.performance &&
        (!ledger ||
          (Object.keys(ledger.models).length === 0 && Object.keys(ledger.tools).length === 0))
      )
        return undefined;
      const performance = saved?.performance as unknown as
        | Omit<SessionUsageRecord, "tokenUsage">
        | undefined;
      const total = sumNativeUsage(ledger);
      return {
        stats: performance?.stats ?? {
          turns: 0,
          steps: 0,
          llmMs: 0,
          toolMs: 0,
          ttftMs: 0,
          ttftSteps: 0,
          decodeMs: 0,
          decodeTokens: 0,
        },
        breakdown: performance?.breakdown ?? { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
        tokenUsage: {
          uncachedInputTokens: total.input,
          outputTokens: total.output,
          cacheReadTokens: total.cacheRead,
          cacheWriteTokens: total.cacheWrite,
        },
      };
    },
    writeUsage: (id, usage) =>
      mutateSession(id, (session, opened) =>
        session.commit(async (tx) => {
          (await tx.doc(SessionPerformanceDoc, opened.session.activeConversationId)).performance = {
            stats: { ...usage.stats },
            breakdown: { ...usage.breakdown },
          };
        }, BACKGROUND_CONTEXT),
      ),
    touch: (id, patch = {}) =>
      updateMetadata(id, { ...patch, updatedAt: patch.updatedAt ?? now() }),
    listSubagentRunsFor,
  };
}

let defaultStore: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  defaultStore ??= createSessionStore(dataDir());
  return defaultStore;
}
