import path from "node:path";
import {
  BACKGROUND_CONTEXT,
  type Branch,
  type LaneConfiguration,
  type LaneState,
  laneConfig,
  laneState,
  type SessionMetadata,
} from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { dataDir } from "@/main/app/paths";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import { mapEntriesToMessages } from "./message-mapper";
import { createSessionsIndex, type SessionIndexEntry } from "./sessions-index";

/** sqlite 包未从入口导出 SqliteOpenSession 类型，这里从 repo 方法推导 */
type SqliteOpenSession = Awaited<ReturnType<SqliteSessionRepo["open"]>>;

type OpenedSession = { session: SqliteOpenSession; branch: Branch };

export interface LoadMessagesOptions {
  limit?: number;
  /** 游标：加载 seq 严格小于该值的更早条目 */
  beforeSeq?: number;
}

export interface LoadMessagesResult {
  messages: ChatMessage[];
  compactionSummaries: string[];
  nextCursor?: number;
}

export interface SessionStore {
  /** 合并索引元数据；archived 可见性由调用方按设置过滤 */
  list(): Promise<SessionSummary[]>;
  create(options?: { cwd?: string; title?: string }): Promise<SessionSummary>;
  open(id: string): Promise<{ session: SqliteOpenSession; branch: Branch } | undefined>;
  /** 写 pi 会话名 + 索引标题 */
  rename(id: string, title: string): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  /** 物理删除 sqlite 文件并清索引 */
  remove(id: string): Promise<void>;
  /** 在指定条目处创建分支会话（scope:"branch", position:"at"） */
  fork(id: string, entryId: string): Promise<SessionSummary>;
  loadMessages(id: string, options?: LoadMessagesOptions): Promise<LoadMessagesResult>;
  /** 运行结束等场景更新索引（默认刷新 updatedAt） */
  touch(id: string, patch?: SessionIndexEntry): Promise<void>;
}

const MAIN_BRANCH = "main";
const DEFAULT_PAGE_SIZE = 40;

/**
 * fork 校验要求源分支是「完整配置的 AgentLane」（lane.config + lane.state）。
 * 纯消息会话先用占位值临时满足校验，fork 完成后立即清除，不污染运行时附着流程。
 */
const PLACEHOLDER_LANE_CONFIG: LaneConfiguration = {
  model: { provider: "", modelId: "" },
  thinkingLevel: "off",
  activeToolNames: [],
};
const PLACEHOLDER_LANE_STATE: LaneState = {
  currentOperationId: null,
  lastOperationId: null,
  inbox: [],
};

function toSummary(meta: SessionMetadata, entry?: SessionIndexEntry): SessionSummary {
  return {
    id: meta.id,
    title: entry?.title ?? null,
    createdAt: meta.createdAt,
    updatedAt: entry?.updatedAt ?? meta.createdAt,
    cwd: meta.cwd ?? entry?.cwd ?? "",
    ...(meta.parentSessionId === undefined ? {} : { parentSessionId: meta.parentSessionId }),
    archived: entry?.archived ?? false,
    messageCount: entry?.messageCount ?? 0,
  };
}

/** 创建会话存储；测试可注入临时目录与自定义 repo（如控制时钟） */
export function createSessionStore(baseDir: string, repo?: SqliteSessionRepo): SessionStore {
  const activeRepo =
    repo ??
    new SqliteSessionRepo({
      directory: path.join(baseDir, "sessions"),
      databaseFactory: createNodeSqliteFactory(),
    });
  const index = createSessionsIndex(baseDir);
  // 同 id 复用打开结果，避免 repo 层重复 open 触发 "Session is already open"
  const handles = new Map<string, Promise<OpenedSession | undefined>>();

  function updateIndex(id: string, patch: SessionIndexEntry): Promise<void> {
    return index.update(id, patch).catch((error: unknown) => {
      console.warn(`更新会话索引失败 ${id}: ${String(error)}`);
    });
  }

  function openHandle(id: string): Promise<OpenedSession | undefined> {
    const cached = handles.get(id);
    if (cached) return cached;
    const opened = (async (): Promise<OpenedSession | undefined> => {
      try {
        const metas = await activeRepo.list(undefined, BACKGROUND_CONTEXT);
        const meta = metas.find((item) => item.id === id);
        if (!meta) {
          console.warn(`打开会话失败，元数据不存在: ${id}`);
          return undefined;
        }
        const session = await activeRepo.open(meta, BACKGROUND_CONTEXT);
        const branch = await session.branch(MAIN_BRANCH, BACKGROUND_CONTEXT);
        if (!branch) {
          await session.close(BACKGROUND_CONTEXT);
          console.warn(`打开会话失败，缺少 ${MAIN_BRANCH} 分支: ${id}`);
          return undefined;
        }
        return { session, branch };
      } catch (error) {
        console.warn(`打开会话失败 ${id}: ${String(error)}`);
        return undefined;
      }
    })();
    handles.set(id, opened);
    // 失败结果不缓存，允许调用方稍后重试
    void opened.then((value) => {
      if (!value && handles.get(id) === opened) handles.delete(id);
    });
    return opened;
  }

  async function closeHandle(id: string): Promise<void> {
    const pending = handles.get(id);
    handles.delete(id);
    if (!pending) return;
    const opened = await pending;
    if (!opened) return;
    try {
      await opened.session.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭会话失败 ${id}: ${String(error)}`);
    }
  }

  async function list(): Promise<SessionSummary[]> {
    try {
      const metas = await activeRepo.list(undefined, BACKGROUND_CONTEXT);
      const entries = await index.read();
      return metas
        .map((meta) => toSummary(meta, entries[meta.id]))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    } catch (error) {
      console.warn(`列出会话失败: ${String(error)}`);
      return [];
    }
  }

  async function create(options: { cwd?: string; title?: string } = {}): Promise<SessionSummary> {
    try {
      const session = await activeRepo.create(undefined, BACKGROUND_CONTEXT);
      const branch = await session.createBranch(MAIN_BRANCH, null, BACKGROUND_CONTEXT);
      if (options.title) await session.setName(options.title, BACKGROUND_CONTEXT);
      handles.set(session.metadata.id, Promise.resolve({ session, branch }));

      const entry: SessionIndexEntry = {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        updatedAt: session.metadata.createdAt,
        messageCount: 0,
      };
      await updateIndex(session.metadata.id, entry);
      return toSummary(session.metadata, entry);
    } catch (error) {
      // 创建失败没有可用空值，记录后抛给调用方决定如何提示
      console.warn(`创建会话失败: ${String(error)}`);
      throw error;
    }
  }

  async function rename(id: string, title: string): Promise<void> {
    const opened = await openHandle(id);
    if (!opened) return;
    try {
      await opened.session.setName(title, BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`重命名会话失败 ${id}: ${String(error)}`);
      return;
    }
    await updateIndex(id, { title });
  }

  async function setArchived(id: string, archived: boolean): Promise<void> {
    await updateIndex(id, { archived });
  }

  async function remove(id: string): Promise<void> {
    await closeHandle(id);
    let deleted = true;
    try {
      const meta = (await activeRepo.list(undefined, BACKGROUND_CONTEXT)).find(
        (item) => item.id === id,
      );
      if (meta) await activeRepo.delete(meta, BACKGROUND_CONTEXT);
    } catch (error) {
      deleted = false;
      console.warn(`删除会话失败 ${id}: ${String(error)}`);
    }
    if (deleted) {
      try {
        await index.remove(id);
      } catch (error) {
        console.warn(`删除会话索引失败 ${id}: ${String(error)}`);
      }
    }
  }

  async function fork(id: string, entryId: string): Promise<SessionSummary> {
    try {
      const meta = (await activeRepo.list(undefined, BACKGROUND_CONTEXT)).find(
        (item) => item.id === id,
      );
      if (!meta) throw new Error(`源会话不存在: ${id}`);
      const source = await openHandle(id);
      if (!source) throw new Error(`无法打开源会话: ${id}`);

      const hasConfig =
        (await source.session.getValue(laneConfig(MAIN_BRANCH), BACKGROUND_CONTEXT)) !== undefined;
      const hasState =
        (await source.session.getValue(laneState(MAIN_BRANCH), BACKGROUND_CONTEXT)) !== undefined;
      const needsPlaceholder = !hasConfig || !hasState;
      if (needsPlaceholder) {
        await source.session.setValue(
          laneConfig(MAIN_BRANCH),
          PLACEHOLDER_LANE_CONFIG,
          BACKGROUND_CONTEXT,
        );
        await source.session.setValue(
          laneState(MAIN_BRANCH),
          PLACEHOLDER_LANE_STATE,
          BACKGROUND_CONTEXT,
        );
      }

      let forked: SqliteOpenSession | undefined;
      let forkedBranch: Branch | undefined;
      try {
        forked = await activeRepo.fork(
          meta,
          { scope: "branch", branch: MAIN_BRANCH, entryId, position: "at" },
          BACKGROUND_CONTEXT,
        );
        forkedBranch = await forked.branch(MAIN_BRANCH, BACKGROUND_CONTEXT);
        if (!forkedBranch) throw new Error(`分支会话缺少 ${MAIN_BRANCH} 分支`);
        if (needsPlaceholder) {
          // 派生会话也去掉占位元数据，保持与新建会话一致的「等待附着」状态
          await forked.deleteValue(laneConfig(MAIN_BRANCH), BACKGROUND_CONTEXT);
          await forked.deleteValue(laneState(MAIN_BRANCH), BACKGROUND_CONTEXT);
        }
      } finally {
        if (needsPlaceholder) {
          await source.session
            .deleteValue(laneConfig(MAIN_BRANCH), BACKGROUND_CONTEXT)
            .catch(() => undefined);
          await source.session
            .deleteValue(laneState(MAIN_BRANCH), BACKGROUND_CONTEXT)
            .catch(() => undefined);
        }
      }

      if (!forked || !forkedBranch) throw new Error("分支会话创建结果不完整");
      handles.set(forked.metadata.id, Promise.resolve({ session: forked, branch: forkedBranch }));

      const stats = await forked.getStats(BACKGROUND_CONTEXT);
      const sourceTitle = (await index.read())[id]?.title;
      const entry: SessionIndexEntry = {
        ...(sourceTitle ? { title: `${sourceTitle} · 分支` } : {}),
        updatedAt: Date.now(),
        messageCount: stats.messageCount,
      };
      await updateIndex(forked.metadata.id, entry);
      return toSummary(forked.metadata, entry);
    } catch (error) {
      // fork 失败同样没有可用的空值，记录后抛给调用方
      console.warn(`创建分支会话失败 ${id}: ${String(error)}`);
      throw error;
    }
  }

  async function loadMessages(
    id: string,
    options: LoadMessagesOptions = {},
  ): Promise<LoadMessagesResult> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const opened = await openHandle(id);
    if (!opened) return { messages: [], compactionSummaries: [] };

    try {
      // newestFirst + cursor 取尾部，再倒转为时间正序
      const raw = await opened.branch.findEntries(
        {
          order: "newestFirst",
          limit,
          ...(options.beforeSeq === undefined ? {} : { cursor: { seq: options.beforeSeq } }),
        },
        BACKGROUND_CONTEXT,
      );
      const ordered = [...raw].reverse();
      const { messages, compactionSummaries } = mapEntriesToMessages(ordered);
      const oldestSeq = ordered[0]?.seq;
      // 批次未取满说明已到分支起点；取满才给游标继续向上翻页
      const nextCursor = raw.length === limit && oldestSeq !== undefined ? oldestSeq : undefined;

      // 索引 messageCount 与真实统计对账，避免运行结束后列表计数滞后（不刷新 updatedAt）
      const entry = (await index.read())[id];
      const stats = await opened.session.getStats(BACKGROUND_CONTEXT);
      if (entry?.messageCount !== stats.messageCount) {
        await updateIndex(id, { messageCount: stats.messageCount });
      }

      return {
        messages,
        compactionSummaries,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    } catch (error) {
      console.warn(`加载会话消息失败 ${id}: ${String(error)}`);
      return { messages: [], compactionSummaries: [] };
    }
  }

  async function touch(id: string, patch: SessionIndexEntry = {}): Promise<void> {
    await updateIndex(id, { ...patch, updatedAt: patch.updatedAt ?? Date.now() });
  }

  return {
    list,
    create,
    open: openHandle,
    rename,
    setArchived,
    remove,
    fork,
    loadMessages,
    touch,
  };
}

let defaultStore: SessionStore | null = null;

/** 默认单例：会话库位于 dataDir()/sessions，索引位于 dataDir()/config */
export function getSessionStore(): SessionStore {
  defaultStore ??= createSessionStore(dataDir());
  return defaultStore;
}
