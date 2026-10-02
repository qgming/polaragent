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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { dataDir, sessionWorkspaceDir, workspacesDir } from "@/main/app/paths";
import {
  type AgentMode,
  ALL_THINKING_LEVELS,
  type ModelRef,
  type ThinkingLevel,
} from "@/shared/contracts/common";
import type {
  ChatMessage,
  SessionCreateOptions,
  SessionKind,
  SessionSummary,
  SessionUsageRecord,
} from "@/shared/contracts/session";
import type { SubagentRun, SubagentRunStatus, SubagentSource } from "@/shared/contracts/subagent";
import { createAttachmentForkCopier, removeSessionAttachments } from "./attachments";
import {
  AppSessionDoc,
  AppSessionHandle,
  type AppSessionMetadata,
  readDocument,
} from "./durable-session";
import { mapEntriesToMessages } from "./message-mapper";
import { createSessionsIndex, type SessionIndexEntry } from "./sessions-index";

export interface OpenedSession {
  session: AppSessionHandle;
  storage: Storage;
  conversationId: import("@earendil-works/pi-durable").ConversationId;
}
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

/**
 * 会话日志里的一条用量样本：一条**带 usage 的助手消息**。
 *
 * 这里刻意只做「照抄」不做归并：模型键、按日分桶、口径换算都是统计侧的语义
 * （见 main/stats/usage-rollup.ts），会话库只负责把日志里写着的事实读出来。
 * serviceId 取自内核消息的 `provider` —— 在本应用里它就是设置里的服务 id
 *（见 shared/contracts/common.ts 的 ModelRef 注释）。
 */
export interface UsageSample {
  /** 助手消息时间戳（epoch ms） */
  at: number;
  serviceId?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 一次增量扫描的结果 */
export interface UsageScanResult {
  samples: UsageSample[];
  /** 已扫到的最大 seq（没有新条目时等于入参 afterSeq）；下次从这个游标继续 */
  nextSeq: number;
  /** 本次实际读过的条目数（含非助手消息条目），调用方用它做工作量预算 */
  entries: number;
  /** 是否已经扫到主分支末尾；false 表示还有更多条目，调用方下轮接着扫 */
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
   * 写会话的用量快照。
   *
   * **不刷新 updatedAt**：这是展示派生数据的更新，不该让会话在侧栏里跳到最前
   * （那条排序属于「有新消息」这个语义，见 touch 的默认行为）。
   */
  writeUsage(id: string, usage: SessionUsageRecord): Promise<void>;
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
  /**
   * 增量扫描一个会话的用量样本（数据统计用）。
   *
   * 只扫**主分支**、只取 `seq > afterSeq` 的条目 —— 与 loadMessages 同一个分支口径，
   * 这样统计里的数字与用户在会话里看得到的消息是同一批。`maxEntries` 是工作量预算：
   * 一次不让主进程在同步 SQLite 上停太久（几百条实测 < 10ms），预算用尽就带着
   * `done: false` 回来，调用方下一轮从 `nextSeq` 接着扫。
   *
   * 打开失败（文件损坏 / 路径异常）返回空结果而不是抛错：统计是只读的旁路，
   * 不该让一个坏会话把整份报告打掉。
   */
  scanUsageSamples(id: string, afterSeq: number, maxEntries: number): Promise<UsageScanResult>;
}

function normalizeSessionKind(raw: unknown): SessionKind {
  return raw === "subagent" ? raw : "chat";
}

function toSummary(meta: AppSessionMetadata, entry?: LocalIndexEntry): SessionSummary {
  // parentSessionId 优先取 pi 元数据（fork 写在那里），本地索引的那份作为 create 场景的兜底
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

/** 索引里的 agentMode 是外部 JSON，可能被手改坏：只认两个合法取值，其余按「未绑定」 */
function normalizeAgentMode(raw: unknown): AgentMode | null {
  return raw === "standard" || raw === "orchestrate" ? raw : null;
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
    turns === undefined ||
    toolCalls === undefined ||
    !isSubagentRunStatus(record.status) ||
    !isSubagentSource(record.agentSource) ||
    !isThinkingLevel(record.thinkingLevel) ||
    /**
     * `tools` 是**可选**的：只有主 AI 临时定义的子智能体带工具白名单，
     * 内置 / 用户定义的运行记录里没有这个字段。
     *
     * 这里曾经要求它必须是数组 —— 那样一来新写的记录（没有 tools）会在读回时
     * 被判为坏记录整条丢掉，表现为「重启后子智能体运行列表空了」。
     * 写了就必须是字符串数组（那才是坏数据），没写就是合法的。
     */
    (tools !== undefined &&
      (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")))
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
    ...(tools === undefined ? {} : { tools }),
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

/** 非负有限数：统计/用量字段的通用守卫（缺项或坏值 → undefined） */
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 索引里的用量快照同样是外部 JSON：只认自己写得出来的形状。
 *
 * 三段（统计 / Token 合计 / 分解）**必须全部有效**才返回记录 ——
 * 缺一段就让整条作废，好过让底栏半个胶囊有数、半个显示 0。
 */
function parseUsageRecord(raw: unknown): SessionUsageRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;

  const statsRaw = record.stats;
  const usageRaw = record.tokenUsage;
  const breakdownRaw = record.breakdown;
  if (
    typeof statsRaw !== "object" ||
    statsRaw === null ||
    typeof usageRaw !== "object" ||
    usageRaw === null ||
    typeof breakdownRaw !== "object" ||
    breakdownRaw === null
  ) {
    return undefined;
  }

  const stats = statsRaw as Record<string, unknown>;
  const turns = nonNegative(stats.turns);
  const steps = nonNegative(stats.steps);
  const llmMs = nonNegative(stats.llmMs);
  const toolMs = nonNegative(stats.toolMs);
  const ttftMs = nonNegative(stats.ttftMs);
  const ttftSteps = nonNegative(stats.ttftSteps);
  const decodeMs = nonNegative(stats.decodeMs);
  const decodeTokens = nonNegative(stats.decodeTokens);
  if (
    turns === undefined ||
    steps === undefined ||
    llmMs === undefined ||
    toolMs === undefined ||
    ttftMs === undefined ||
    ttftSteps === undefined ||
    decodeMs === undefined ||
    decodeTokens === undefined
  ) {
    return undefined;
  }

  const usage = usageRaw as Record<string, unknown>;
  const uncachedInputTokens = nonNegative(usage.uncachedInputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  const cacheReadTokens = nonNegative(usage.cacheReadTokens);
  const cacheWriteTokens = nonNegative(usage.cacheWriteTokens);
  if (
    uncachedInputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  const breakdown = breakdownRaw as Record<string, unknown>;
  const systemTokens = nonNegative(breakdown.systemTokens);
  const toolsTokens = nonNegative(breakdown.toolsTokens);
  const messageTokens = nonNegative(breakdown.messageTokens);
  if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) {
    return undefined;
  }

  return {
    stats: { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens },
    tokenUsage: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    breakdown: { systemTokens, toolsTokens, messageTokens },
  };
}

export interface SessionStoreOptions {
  now?: () => number;
  openStorage?: (file: string) => Promise<Storage>;
}
const PAGE_SIZE = 40;
const SESSION_ID = /^[a-f0-9-]{36}$/i;

/** App metadata stays in the index; native transcripts live in a dedicated Pi 1.0 directory. */
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
    if (!SESSION_ID.test(id) || removing.has(id)) return undefined;
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
        const session = new AppSessionHandle(
          storage,
          { id, createdAt: value.createdAt },
          active.id,
          () => {
            if (handles.get(id) === pending) handles.delete(id);
          },
          (await index.read())[id]?.messageCount,
        );
        return { session, storage, conversationId: active.id };
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

  async function updateIndex(id: string, patch: LocalIndexEntry) {
    await index.update(id, patch);
  }
  async function ensureWorkspaceDir(id: string) {
    const cwd = sessionWorkspaceDir(id, baseDir);
    await mkdir(cwd, { recursive: true });
    return cwd;
  }
  async function list() {
    const metas = await listMetas();
    const entries = await index.read();
    for (const meta of metas.values()) {
      if (!entries[meta.id]?.cwd?.trim()) {
        const cwd = await ensureWorkspaceDir(meta.id);
        entries[meta.id] = { ...entries[meta.id], cwd };
        await updateIndex(meta.id, { cwd });
      }
    }
    return [...metas.values()]
      .map((meta) => toSummary(meta, entries[meta.id]))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function create(input: SessionCreateOptions = {}) {
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
      ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
    };
    await updateIndex(id, entry);
    const meta = { id, createdAt };
    if (metadataRead) await metadataRead;
    metadata?.set(id, meta);
    return toSummary(meta, entry);
  }
  async function rename(id: string, title: string) {
    if (await openHandle(id)) await updateIndex(id, { title });
  }
  async function readTitle(id: string) {
    return (await index.read())[id]?.title?.trim() || null;
  }
  async function readCwd(id: string) {
    const cwd = (await index.read())[id]?.cwd;
    return cwd?.trim() ? cwd : null;
  }
  async function ensureCwd(id: string) {
    if (!(await openHandle(id))) throw new Error(`会话不存在：${id}`);
    const cwd = await readCwd(id);
    if (cwd) return cwd;
    const generated = await ensureWorkspaceDir(id);
    await updateIndex(id, { cwd: generated });
    return generated;
  }
  async function removeWorkspace(id: string, cwd: string | null) {
    if (!cwd) return;
    const target = path.resolve(cwd);
    if (path.dirname(target) !== path.resolve(workspacesDir(baseDir))) return;
    const entries = await index.read();
    if (
      Object.entries(entries).some(
        ([other, entry]) => other !== id && entry.cwd && path.resolve(entry.cwd) === target,
      )
    )
      return;
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
    await updateIndex(id, { cwd: target });
    if (previous && path.resolve(previous) !== path.resolve(target))
      await removeWorkspace(id, previous);
  }
  async function remove(id: string) {
    const entries = await index.read();
    const visited = new Set<string>();
    const removeOne = async (target: string): Promise<void> => {
      if (visited.has(target)) return;
      visited.add(target);
      removing.add(target);
      try {
        for (const [child, raw] of Object.entries(entries)) {
          const entry = raw as LocalIndexEntry;
          if (entry.kind === "subagent" && entry.parentSessionId === target) await removeOne(child);
        }
        const opened = await handles.get(target);
        if (opened) await opened.session.close();
        if (SESSION_ID.test(target)) await rm(filename(target), { force: true });
        const cwd = await readCwd(target);
        await index.remove(target);
        metadata?.delete(target);
        await removeWorkspace(target, cwd);
        await removeSessionAttachments(target, baseDir);
      } finally {
        removing.delete(target);
      }
    };
    await removeOne(id);
  }

  async function fork(id: string, externalId: string) {
    const source = await openHandle(id);
    if (!source) throw new Error(`源会话不存在：${id}`);
    const history = await source.session.allEntries();
    const cutoff = history.findIndex((entry) => entry.entryId === externalId);
    if (cutoff < 0) throw new Error(`条目不存在：${externalId}`);
    const selected = history[cutoff];
    if (!selected) throw new Error(`条目不存在：${externalId}`);
    const sourceIndex = (await index.read())[id];
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
      const sourcePoint = await source.storage.entry(selected.record.id, BACKGROUND_CONTEXT);
      const agentRecord =
        sourcePoint &&
        (await source.storage.findDocument(
          {
            kind: AgentDoc.definition.kind,
            scope: { kind: "conversation", conversationId: source.session.activeConversationId },
          },
          sourcePoint.commitSeq,
          BACKGROUND_CONTEXT,
        ));
      const agent =
        agentRecord &&
        sourcePoint &&
        (await source.storage.document(agentRecord.id, sourcePoint.commitSeq, BACKGROUND_CONTEXT));
      await owner.commit(async (tx) => {
        const agentDraft = await tx.doc(AgentDoc, destination.conversationId);
        if (agent) Object.assign(agentDraft, agent.value);
        const ids = new Map<EntryId, EntryId>();
        for (const record of copiedHistory) {
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
        }
      }, BACKGROUND_CONTEXT);
      await updateIndex(created.id, {
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
    return toSummary(created, (await index.read())[created.id]);
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
    const next = newest ? page[0]?.sequence : page.at(-1)?.sequence;
    const messageCount = opened.session.knownMessageCount();
    if (messageCount !== undefined && (await index.read())[id]?.messageCount !== messageCount)
      await updateIndex(id, { messageCount });
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
    const opened = await openHandle(id);
    if (!opened) return { samples: [], nextSeq: afterSeq, entries: 0, done: true };
    const result = await opened.session.oldestPage(
      Math.max(1, Math.floor(maxEntries)),
      afterSeq,
      BACKGROUND_CONTEXT,
    );
    const page = result.entries;
    const samples: UsageSample[] = [];
    for (const entry of page)
      for (const message of entry.record.model ?? []) {
        if (message.role !== "assistant") continue;
        samples.push({
          at: message.timestamp,
          serviceId: message.provider,
          modelId: message.model,
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
        });
      }
    return {
      samples,
      nextSeq: page.at(-1)?.sequence ?? afterSeq,
      entries: page.length,
      done: !result.hasMore,
    };
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
    readTitle,
    readCwd,
    ensureCwd,
    setCwd,
    remove,
    fork,
    loadMessages,
    scanUsageSamples,
    setArchived: (id, archived) => updateIndex(id, { archived }),
    setPinned: (id, pinned) => updateIndex(id, { pinned }),
    readModel: async (id) => normalizeModelRef((await index.read())[id]?.model),
    setModel: (id, model) => updateIndex(id, { model }),
    readAgentMode: async (id) => normalizeAgentMode((await index.read())[id]?.agentMode),
    setAgentMode: (id, agentMode) => updateIndex(id, { agentMode }),
    readUsage: async (id) => parseUsageRecord((await index.read())[id]?.usage),
    writeUsage: (id, usage) => updateIndex(id, { usage }),
    touch: (id, patch = {}) => updateIndex(id, { ...patch, updatedAt: patch.updatedAt ?? now() }),
    saveSubagentRun: (id, subagentRun) => updateIndex(id, { subagentRun }),
    listSubagentRunsFor: async (parentSessionId) =>
      Object.values(await index.read())
        .filter((value) => value && typeof value === "object")
        .map((entry) => entry as LocalIndexEntry)
        .filter((entry) => entry.kind === "subagent" && entry.parentSessionId === parentSessionId)
        .map((entry) => parseSubagentRun(entry.subagentRun))
        .filter((run): run is SubagentRun => run !== undefined && run.sessionId === parentSessionId)
        .sort((a, b) => a.startedAt - b.startedAt),
  };
}

let defaultStore: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  defaultStore ??= createSessionStore(dataDir());
  return defaultStore;
}
