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
import { ALL_THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "@/shared/contracts/common";
import type {
  ChatMessage,
  SessionCreateOptions,
  SessionKind,
  SessionSummary,
} from "@/shared/contracts/session";
import type { SubagentRun, SubagentRunStatus, SubagentSource } from "@/shared/contracts/subagent";
import { mapEntriesToMessages } from "./message-mapper";
import { createSessionsIndex, type SessionIndexEntry } from "./sessions-index";

/**
 * 本地索引条目 + 从属会话字段。
 *
 * 索引条目的类型定义在 sessions-index.ts（本文件不拥有那个文件），
 * 子智能体这类「从属会话」需要多存 kind 与归属信息；这里用交叉类型扩展一次，
 * 而不是再写第二份索引实现。读取时全部字段缺省值由 toSummary 补齐（kind 缺省 = "chat"）。
 */
type LocalIndexEntry = SessionIndexEntry & {
  /** 会话种类；缺省按 chat（旧索引里没有这个字段） */
  kind?: SessionKind;
  /** 发起它的主会话 id；pi 元数据里也有，索引这份是 create 场景的兜底 */
  parentSessionId?: string;
  /** 子智能体运行：派发它的那次 Task 工具调用 id 与子智能体名 */
  parentToolCallId?: string;
  agentName?: string;
  /** 子智能体运行 id（与 parentToolCallId 相同，冗余一份便于按会话查） */
  delegationId?: string;
  /**
   * 这次子智能体运行的记录本体。一次运行 == 一个子会话，所以它挂在子会话条目上 ——
   * 索引是外部 JSON，读回来时必须重新校验（见 parseSubagentRun）。
   */
  subagentRun?: SubagentRun;
};

/** sqlite 包未从入口导出 SqliteOpenSession 类型，这里从 repo 方法推导 */
type SqliteOpenSession = Awaited<ReturnType<SqliteSessionRepo["open"]>>;
/** repo.list() 的元素类型（带 path 等额外字段，比 SessionMetadata 更宽） */
type SqliteSessionMetadata = Awaited<ReturnType<SqliteSessionRepo["list"]>>[number];

type OpenedSession = { session: SqliteOpenSession; branch: Branch };

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

export interface SessionStore {
  /** 合并索引元数据；archived 可见性由调用方按设置过滤 */
  list(): Promise<SessionSummary[]>;
  /** 新建会话：从属会话（subagent）通过 options 带上种类与归属信息 */
  create(options?: SessionCreateOptions): Promise<SessionSummary>;
  open(id: string): Promise<{ session: SqliteOpenSession; branch: Branch } | undefined>;
  /** 写 pi 会话名 + 索引标题 */
  /** 写 pi 会话名 + 索引标题 */
  rename(id: string, title: string): Promise<void>;
  /** 当前标题（null = 还没有名字，自动命名据此判断是否该生成） */
  readTitle(id: string): Promise<string | null>;
  setArchived(id: string, archived: boolean): Promise<void>;
  /** 置顶/取消置顶：只写索引，不动 pi 元数据 */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** 会话绑定的工作目录（索引 cwd）；未绑定返回 null */
  readCwd(id: string): Promise<string | null>;
  /** 会话自己指定的模型；未绑定返回 null（调用方据此回落到默认模型） */
  readModel(id: string): Promise<ModelRef | null>;
  /** 写会话级模型绑定；null 表示清除绑定（回到「跟随默认」） */
  setModel(id: string, model: ModelRef | null): Promise<void>;
  /** 物理删除 sqlite 文件并清索引 */
  remove(id: string): Promise<void>;
  /** 在指定条目处创建分支会话（scope:"branch", position:"at"） */
  fork(id: string, entryId: string): Promise<SessionSummary>;
  loadMessages(id: string, options?: LoadMessagesOptions): Promise<LoadMessagesResult>;
  /** 运行结束等场景更新索引（默认刷新 updatedAt） */
  touch(id: string, patch?: SessionIndexEntry): Promise<void>;
  /**
   * 落一次子智能体运行的记录。
   *
   * 为什么挂在**子会话**条目上、而不是父会话那次 Task 调用的 details 上：details 只在派发时写一次
   * （转录是追加型的，没有「改回上一条」这回事），进程一退出就再也读不到结局；而子会话条目是
   * 「一次运行一条记录」的天然主键 —— 重启后只有它还能被后来的进程寻址，靠它才分得清谁没跑完。
   */
  saveSubagentRun(childSessionId: string, run: SubagentRun): Promise<void>;
  /** 某个父会话的全部运行记录（含本进程没见过的历史运行），按 startedAt 升序 */
  listSubagentRunsFor(parentSessionId: string): Promise<SubagentRun[]>;
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

/**
 * 索引里的 kind 是外部 JSON，可能被手改坏，也可能是旧版本留下的：只认 "subagent"，
 * 其余（含缺省）一律按 "chat" —— 否则一个坏值会让会话从左侧栏消失。
 *
 * 旧版本给侧边聊天写下的 kind 值同样落回 "chat"：那种历史会话会作为普通会话出现在
 * 左侧栏里。这是有意为之 —— 它只是一段孤立的旧对话，让它可见是用户能看见并删掉它的
 * 唯一方式；不迁移、不加墓碑、不做特判。
 */
function normalizeSessionKind(raw: unknown): SessionKind {
  return raw === "subagent" ? raw : "chat";
}

function toSummary(meta: SessionMetadata, entry?: LocalIndexEntry): SessionSummary {
  // parentSessionId 优先取 pi 元数据（fork 写在那里），本地索引的那份作为 create 场景的兜底
  const parentSessionId = meta.parentSessionId ?? entry?.parentSessionId;
  return {
    id: meta.id,
    // 空串/纯空白与「没有标题」是同一件事：归一成 null，消费方只需处理一种空值（与 readTitle 同口径）
    title: entry?.title?.trim() || null,
    createdAt: meta.createdAt,
    updatedAt: entry?.updatedAt ?? meta.createdAt,
    cwd: meta.cwd ?? entry?.cwd ?? "",
    kind: normalizeSessionKind(entry?.kind),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(entry?.parentToolCallId === undefined ? {} : { parentToolCallId: entry.parentToolCallId }),
    ...(entry?.agentName === undefined ? {} : { agentName: entry.agentName }),
    archived: entry?.archived ?? false,
    pinned: entry?.pinned ?? false,
    messageCount: entry?.messageCount ?? 0,
    model: normalizeModelRef(entry?.model),
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

/** 契约里的运行状态取值；索引里读到的字符串必须在这一档里，否则整条记录按坏数据丢掉 */
const SUBAGENT_RUN_STATUSES: readonly SubagentRunStatus[] = [
  "running",
  "completed",
  "truncated",
  "failed",
  "aborted",
  "denied",
  "interrupted",
];

function isSubagentRunStatus(raw: unknown): raw is SubagentRunStatus {
  return typeof raw === "string" && (SUBAGENT_RUN_STATUSES as readonly string[]).includes(raw);
}

function isSubagentSource(raw: unknown): raw is SubagentSource {
  return raw === "builtin" || raw === "user" || raw === "temp";
}

function isThinkingLevel(raw: unknown): raw is ThinkingLevel {
  return (ALL_THINKING_LEVELS as readonly unknown[]).includes(raw);
}

/**
 * 索引里的运行记录同样是外部 JSON，可能被手改坏或被别的版本写坏：只认自己写得出来的形状。
 *
 * 必填字段缺一个就返回 undefined（调用方跳过这一条），可选字段只在类型对得上时才带上 ——
 * 与其把一条读不懂的记录当成「还在跑」交给面板，不如让它消失，其余运行照常显示。
 */
function parseSubagentRun(raw: unknown): SubagentRun | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const delegationId = text(record.delegationId);
  const sessionId = text(record.sessionId);
  const parentToolCallId = text(record.parentToolCallId);
  const childSessionId = text(record.childSessionId);
  const agentName = text(record.agentName);
  const description = text(record.description);
  const task = text(record.task);
  const modelId = text(record.modelId);
  const startedAt = count(record.startedAt);
  const maxTurns = count(record.maxTurns);
  const turns = count(record.turns);
  const toolCalls = count(record.toolCalls);
  const tools = record.tools;
  if (
    delegationId === undefined ||
    sessionId === undefined ||
    parentToolCallId === undefined ||
    childSessionId === undefined ||
    agentName === undefined ||
    description === undefined ||
    task === undefined ||
    modelId === undefined ||
    startedAt === undefined ||
    maxTurns === undefined ||
    turns === undefined ||
    toolCalls === undefined ||
    !isSubagentRunStatus(record.status) ||
    !isSubagentSource(record.agentSource) ||
    !isThinkingLevel(record.thinkingLevel) ||
    !Array.isArray(tools) ||
    !tools.every((tool) => typeof tool === "string")
  ) {
    return undefined;
  }
  // model 是唯一结构化的字段：null = 继承父会话；写了值却解析不出来，说明这条记录已经坏了
  const rawModel = record.model ?? null;
  const model = rawModel === null ? null : normalizeModelRef(rawModel);
  if (rawModel !== null && model === null) return undefined;

  const run: SubagentRun = {
    delegationId,
    sessionId,
    parentToolCallId,
    childSessionId,
    agentName,
    agentSource: record.agentSource,
    description,
    task,
    status: record.status,
    startedAt,
    model,
    modelId,
    thinkingLevel: record.thinkingLevel,
    maxTurns,
    tools,
    turns,
    toolCalls,
  };
  const endedAt = count(record.endedAt);
  if (endedAt !== undefined) run.endedAt = endedAt;
  const updatedAt = count(record.updatedAt);
  if (updatedAt !== undefined) run.updatedAt = updatedAt;
  const report = text(record.report);
  if (report !== undefined) run.report = report;
  const error = text(record.error);
  if (error !== undefined) run.error = error;
  const resumedFrom = text(record.resumedFrom);
  if (resumedFrom !== undefined) run.resumedFrom = resumedFrom;
  return run;
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
  /**
   * `activeRepo.list()` 的结果缓存。
   *
   * 为什么必须有：那次调用对**每个会话文件**做 readdir → realpath → open → query → close，
   * 底层是同步 `node:sqlite`（`DatabaseSync`）。本机实测 50 个会话 = **每次约 220 ms 的主进程
   * 阻塞**，而它在「列会话」「打开会话」「删会话」「fork」以及发送路径上都会被调到 ——
   * 表现为每切一次会话 UI 卡一下，且随会话数线性变差。
   *
   * 失效策略：只在**会改变会话集合或元数据**的操作上置空，下次 list() 重新扫一遍。
   * 逐条精确更新容易漏（`messageCount` 等字段由各处 touch 写入），而重扫一次
   * 只在写操作后发生，代价可接受。
   */
  let metaCache: SqliteSessionMetadata[] | null = null;

  /** 取会话元数据（带缓存）；调用方**不要**改写返回的数组 */
  async function listMetas(): Promise<SqliteSessionMetadata[]> {
    if (metaCache !== null) return metaCache;
    const metas = await activeRepo.list(undefined, BACKGROUND_CONTEXT);
    metaCache = metas;
    return metas;
  }

  /** 让元数据缓存失效（任何可能改变会话集合/元数据的写入之后调用） */
  function invalidateMetas(): void {
    metaCache = null;
  }

  function updateIndex(id: string, patch: LocalIndexEntry): Promise<void> {
    return index.update(id, patch).catch((error: unknown) => {
      console.warn(`更新会话索引失败 ${id}: ${String(error)}`);
    });
  }

  function openHandle(id: string): Promise<OpenedSession | undefined> {
    const cached = handles.get(id);
    if (cached) return cached;
    const opened = (async (): Promise<OpenedSession | undefined> => {
      try {
        const metas = await listMetas();
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
      const metas = await listMetas();
      const entries = await index.read();
      return metas
        .map((meta) => toSummary(meta, entries[meta.id]))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    } catch (error) {
      console.warn(`列出会话失败: ${String(error)}`);
      return [];
    }
  }

  async function create(options: SessionCreateOptions = {}): Promise<SessionSummary> {
    try {
      // parentSessionId 是 pi 元数据的一部分（fork 也写在那里）：从这里传下去，
      // 子会话与父会话的关联在底层就固定了，重启后 list 仍读得回来
      const session = await activeRepo.create(
        options.parentSessionId === undefined
          ? undefined
          : { parentSessionId: options.parentSessionId },
        BACKGROUND_CONTEXT,
      );
      const branch = await session.createBranch(MAIN_BRANCH, null, BACKGROUND_CONTEXT);
      if (options.title) await session.setName(options.title, BACKGROUND_CONTEXT);
      handles.set(session.metadata.id, Promise.resolve({ session, branch }));
      // 会话集合变了：下次 list() 必须重新扫盘（否则新建的会话不会出现在列表里）
      invalidateMetas();

      // 其余从属字段（kind / 工具调用 id / 子智能体名 / 运行 id）落在本地索引里：
      // SQLite 后端的 create 只收 { id, parentSessionId }，多出来的字段没有地方放
      const entry: LocalIndexEntry = {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        ...(options.parentSessionId === undefined
          ? {}
          : { parentSessionId: options.parentSessionId }),
        ...(options.parentToolCallId === undefined
          ? {}
          : { parentToolCallId: options.parentToolCallId }),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
        ...(options.delegationId === undefined ? {} : { delegationId: options.delegationId }),
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

  async function readTitle(id: string): Promise<string | null> {
    const title = (await index.read())[id]?.title?.trim() ?? "";
    return title === "" ? null : title;
  }

  async function readCwd(id: string): Promise<string | null> {
    // 只 trim 用于判空，返回原值——路径本身的首尾空白不真正剪掉
    const cwd = (await index.read())[id]?.cwd ?? "";
    return cwd.trim() === "" ? null : cwd;
  }

  async function readModel(id: string): Promise<ModelRef | null> {
    return normalizeModelRef((await index.read())[id]?.model);
  }

  /**
   * 写会话级模型绑定。null 会作为显式值写进索引（覆盖旧的绑定）——
   * 「取消绑定、回到跟随默认」必须能落盘，否则重启后旧的绑定又回来了。
   */
  async function setModel(id: string, model: ModelRef | null): Promise<void> {
    await updateIndex(id, { model });
  }

  async function setArchived(id: string, archived: boolean): Promise<void> {
    await updateIndex(id, { archived });
  }

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    await updateIndex(id, { pinned });
  }

  async function remove(id: string): Promise<void> {
    await closeHandle(id);
    let deleted = true;
    try {
      const meta = (await listMetas()).find((item) => item.id === id);
      if (meta) await activeRepo.delete(meta, BACKGROUND_CONTEXT);
    } catch (error) {
      deleted = false;
      console.warn(`删除会话失败 ${id}: ${String(error)}`);
    }
    // 无论删除成功与否都失效：失败的删除也可能已经动过文件
    invalidateMetas();
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
      const meta = (await listMetas()).find((item) => item.id === id);
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
      // 分支是一个新会话：会话集合变了
      invalidateMetas();

      const stats = await forked.getStats(BACKGROUND_CONTEXT);
      const sourceTitle = (await index.read())[id]?.title;
      const entry: SessionIndexEntry = {
        ...(sourceTitle ? { title: `${sourceTitle} · 分支` } : {}),
        updatedAt: Date.now(),
        messageCount: stats.messageCount,
        // 继承源会话的模型绑定：分支接着同一段（由那个模型产生的）上下文，
        // 让它悄悄改用默认模型与「分支」的语义不符
        model: (await index.read())[id]?.model ?? null,
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
      // 默认取尾部（newestFirst + cursor），再倒转为时间正序；oldestFirst 用于从会话开头读
      const order = options.order ?? "newestFirst";
      const raw = await opened.branch.findEntries(
        {
          order,
          limit,
          ...(options.beforeSeq === undefined ? {} : { cursor: { seq: options.beforeSeq } }),
        },
        BACKGROUND_CONTEXT,
      );
      const ordered = order === "newestFirst" ? [...raw].reverse() : [...raw];
      const { messages, compactionSummaries } = mapEntriesToMessages(ordered);
      // 游标指向「已读到的另一端」：尾部模式向上翻，开头模式向下翻
      const cursorSeq =
        order === "newestFirst" ? ordered[0]?.seq : ordered[ordered.length - 1]?.seq;
      // 批次未取满说明已到分支边界；取满才给游标继续翻页
      const nextCursor = raw.length === limit && cursorSeq !== undefined ? cursorSeq : undefined;

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

  async function saveSubagentRun(childSessionId: string, run: SubagentRun): Promise<void> {
    // 失败只记录：运行记录是「给下一个进程看的账」，写不进去不该让正在跑的运行失败（见接口注释）
    await updateIndex(childSessionId, { subagentRun: run });
  }

  async function listSubagentRunsFor(parentSessionId: string): Promise<SubagentRun[]> {
    const entries = await index.read();
    const runs: SubagentRun[] = [];
    for (const raw of Object.values(entries) as unknown[]) {
      // 条目本身也可能被手改坏（写成字符串 / null）：跳过，绝不让一条坏数据把整份列表带塌
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as LocalIndexEntry;
      if (entry.kind !== "subagent" || entry.parentSessionId !== parentSessionId) continue;
      const run = parseSubagentRun(entry.subagentRun);
      // sessionId 对不上的记录（例如被贴到了别的条目下）同样跳过
      if (run === undefined || run.sessionId !== parentSessionId) continue;
      runs.push(run);
    }
    // 与 listSubagentRuns 一样按派发顺序升序：调用方（面板 / 对账 / 工具文案）不必再排一次
    return runs.sort((left, right) => left.startedAt - right.startedAt);
  }

  return {
    list,
    create,
    open: openHandle,
    rename,
    readTitle,
    setArchived,
    setPinned,
    readCwd,
    readModel,
    setModel,
    remove,
    fork,
    loadMessages,
    touch,
    saveSubagentRun,
    listSubagentRunsFor,
  };
}

let defaultStore: SessionStore | null = null;

/** 默认单例：会话库位于 dataDir()/sessions，索引位于数据根下的 sessions-index.json */
export function getSessionStore(): SessionStore {
  defaultStore ??= createSessionStore(dataDir());
  return defaultStore;
}
