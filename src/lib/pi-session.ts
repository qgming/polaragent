// pi Session 仓库接线 —— 用 JsonlSessionRepo + ElectronExecutionEnv
// src/lib/pi-session.ts
//
// 所有会话以 pi 原生的 jsonl entry 树格式，持久化到
//   <appDataDir>/conversations/<sessionId>/...
// 由 pi 的 JsonlSessionRepo 管理（创建/打开/列举/删除/fork）。
//
// 该模块向上层（agent-manager / chat-store）暴露最小的会话仓库能力，
// 屏蔽 pi 的 metadata 细节。

import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getDataDir } from "./electron-api";
import { ElectronExecutionEnv } from "./electron-fs";
import type { ChatMessage, Segment } from "@/stores/chat-store";
import type { ArtifactItem, TodoItem } from "@/stores/task-monitor-store";
import type { TeamMessage } from "@/stores/team-chat-store";
import { toolDisplayName } from "@/ai/tools";

let envPromise: Promise<ElectronExecutionEnv> | null = null;
let repoPromise: Promise<JsonlSessionRepo> | null = null;
// 团队会话用独立的 repo，根目录指向 <appData>/teams/conversations，与普通对话物理隔离
let teamRepoPromise: Promise<JsonlSessionRepo> | null = null;

// 同一 sessionId 的「打开/创建」结果缓存：复用同一个 Promise，
// 杜绝 createThread 与 createHarness 并发时各自 create 一次，导致同 id 产生两个 jsonl 文件。
// （这是「重启后出现两条同名会话、一条有标题一条空」的根因。）
const sessionPromises = new Map<string, Promise<Session>>();

// 会话根目录：<appData>/conversations
async function getSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/conversations`;
}

// 团队会话根目录：<appData>/teams/conversations
async function getTeamSessionsRoot(): Promise<string> {
  const dataDir = (await getDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${dataDir}/teams/conversations`;
}

// 延迟初始化共享的 ExecutionEnv（cwd 指向会话根目录）
export async function getExecutionEnv(): Promise<ElectronExecutionEnv> {
  if (!envPromise) {
    envPromise = (async () => {
      const root = await getSessionsRoot();
      return new ElectronExecutionEnv(root);
    })();
  }
  return envPromise;
}

// 延迟初始化共享的 JsonlSessionRepo
async function getRepo(): Promise<JsonlSessionRepo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      const env = await getExecutionEnv();
      const sessionsRoot = await getSessionsRoot();
      // 确保根目录存在，避免首次 list/create 失败
      await env.createDir(sessionsRoot, { recursive: true });
      return new JsonlSessionRepo({ fs: env, sessionsRoot });
    })();
  }
  return repoPromise;
}

// 延迟初始化团队会话的 JsonlSessionRepo（根目录 = teams/conversations）。
// 复用同一个 ExecutionEnv（其 cwd 指向普通会话根，仅用于 fs 操作，不影响团队 repo 的 sessionsRoot）。
async function getTeamRepo(): Promise<JsonlSessionRepo> {
  if (!teamRepoPromise) {
    teamRepoPromise = (async () => {
      const env = await getExecutionEnv();
      const sessionsRoot = await getTeamSessionsRoot();
      await env.createDir(sessionsRoot, { recursive: true });
      return new JsonlSessionRepo({ fs: env, sessionsRoot });
    })();
  }
  return teamRepoPromise;
}

/**
 * 打开已存在的会话；若不存在则按给定 id 新建。
 * sessionId 即对话线程 id（threadId）。
 *
 * 用 sessionPromises 缓存按 id 串行化：并发调用复用同一个 Promise，
 * 保证整个进程内同一 id 只创建/打开一次底层 session，避免重复创建出双文件。
 */
export async function openOrCreateSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getRepo);
}

/**
 * 团队会话版：打开/创建团队会话（存于 teams/conversations 下的独立 repo）。
 * 缓存键加 "team::" 前缀，避免与普通会话的 id 撞键。
 */
export async function openOrCreateTeamSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getTeamRepo, "team::", true);
}

async function openOrCreateSessionImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  cachePrefix = "",
  isTeam = false,
): Promise<Session> {
  const cacheKey = `${cachePrefix}${sessionId}`;
  const cached = sessionPromises.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const repo = await repoGetter();
    // 团队会话用团队根作为 cwd，避免把「普通会话根的绝对路径」编码进团队目录名
    // （否则会得到 teams/conversations/--C--Users-...-conversations--/ 这种诡异嵌套）。
    const cwd = isTeam ? await getTeamSessionsRoot() : (await getExecutionEnv()).cwd;

    // 命中已有的同 id 会话；若历史脏数据存在多条同 id，选「内容最多」的那条打开，
    // 保证读到的是有消息的会话而非空壳。
    const existing = await repo.list().catch(() => []);
    const hits = existing.filter((meta) => meta.id === sessionId);
    if (hits.length > 0) {
      const best = await pickBestMeta(hits);
      return repo.open(best);
    }

    return repo.create({ cwd, id: sessionId });
  })();

  sessionPromises.set(cacheKey, promise);
  // 创建/打开失败则移除缓存，避免后续一直拿到 rejected Promise
  promise.catch(() => sessionPromises.delete(cacheKey));
  return promise;
}

// session 列表项的最小元数据形状（repo.list 的返回元素）
type SessionMeta = Awaited<ReturnType<JsonlSessionRepo["list"]>>[number];

// 统计某 session 文件里 type==="message" 的行数（近似消息量），读失败按 0。
// 仅在同 id 出现多条时用于挑选「有内容」的那条。
async function metaMessageCount(meta: SessionMeta): Promise<number> {
  try {
    const env = await getExecutionEnv();
    const result = await env.readTextFile(meta.path);
    if (!result.ok) return 0;
    let count = 0;
    for (const line of result.value.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string };
        if (parsed.type === "message") count += 1;
      } catch {
        // 跳过无法解析的行
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// 在同 id 的多条 meta 中选「最优」：消息最多者优先；并列时取 createdAt 较新者。
// 单条时直接返回，避免无谓读盘。
async function pickBestMeta(metas: SessionMeta[]): Promise<SessionMeta> {
  if (metas.length === 1) return metas[0];
  const scored = await Promise.all(
    metas.map(async (meta) => ({
      meta,
      count: await metaMessageCount(meta),
      createdAt: Date.parse(meta.createdAt) || 0,
    })),
  );
  scored.sort((a, b) =>
    b.count !== a.count ? b.count - a.count : b.createdAt - a.createdAt,
  );
  return scored[0].meta;
}

/**
 * 列出所有会话的元数据（id + 创建时间 + 标题）。
 *
 * 历史脏数据可能出现同 id 的多个 jsonl（并发创建竞态遗留：一条带标题、一条带消息）。
 * 这里按 id 折叠为一条：createdAt 取最优那条，标题取组内任意有 name 的一条，
 * 避免侧边栏出现两条同名会话、且分别点不开。
 */
export async function listSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string }>
> {
  return listSessionsImpl(getRepo);
}

/**
 * 团队会话版：列出团队会话仓库里的会话，并附带每条会话归属的 teamId（来自 team_ref 自定义条目）。
 * 供团队聊天 store 按 teamId 分组。
 */
export async function listTeamSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string; teamId?: string }>
> {
  const repo = await getTeamRepo();
  // 排除成员私有 session（id 含 "__m_"）——它们只是各成员发言时的 harness 草稿，
  // 不是「团队会话」本身，不应出现在会话列表里。
  const base = (await listSessionsImpl(getTeamRepo)).filter(
    (item) => !item.id.includes("__m_"),
  );
  // 为每条会话回读 team_ref（最后一次写入）
  return Promise.all(
    base.map(async (item) => {
      let teamId: string | undefined;
      try {
        const session = await openOrCreateTeamSession(item.id);
        teamId = readLastCustomEntryString(
          await session.getEntries(),
          TEAM_REF_ENTRY,
          "teamId",
        );
      } catch {
        // 读不到归属则留空，由上层兜底
      }
      void repo;
      return { ...item, teamId };
    }),
  );
}

async function listSessionsImpl(
  repoGetter: () => Promise<JsonlSessionRepo>,
): Promise<Array<{ id: string; createdAt: string; path: string; title?: string }>> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);

  // 按 id 分组
  const groups = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    const list = groups.get(meta.id);
    if (list) list.push(meta);
    else groups.set(meta.id, [meta]);
  }

  const result = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      // createdAt/path 取「内容最多」的那条，确保点开能读到有消息的会话
      const best = await pickBestMeta(group);
      // 标题：组内任意一条 session 有 name 即采用（标题常落在空壳那条）
      let title: string | undefined;
      for (const meta of group) {
        try {
          const session = await repo.open(meta);
          const name = await session.getSessionName();
          if (name && name.trim()) {
            title = name;
            break;
          }
        } catch {
          // 忽略打不开的条目
        }
      }
      return {
        id: best.id,
        createdAt: best.createdAt,
        path: best.path,
        title,
      };
    }),
  );
  return result;
}

/**
 * 设置会话标题（写入 pi Session 的 session name）。
 * 同 id 多条时写入「内容最多」的那条，使标题与消息归于同一文件，
 * 从根上消除「标题在空壳、消息在另一文件」的分裂。
 */
export async function setSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  return setSessionTitleImpl(sessionId, title, getRepo);
}

/** 团队会话版：设置团队会话标题。 */
export async function setTeamSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  return setSessionTitleImpl(sessionId, title, getTeamRepo);
}

async function setSessionTitleImpl(
  sessionId: string,
  title: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
): Promise<void> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);
  const hits = metas.filter((meta) => meta.id === sessionId);
  if (hits.length === 0) return;
  const best = await pickBestMeta(hits);
  const session = await repo.open(best);
  await session.appendSessionName(title);
}

/**
 * 删除某个会话（连同其 jsonl 文件）。
 * 同 id 若存在多个文件（历史竞态遗留），一并删除，避免删一条后另一条重启又出现。
 */
export async function deleteSession(sessionId: string): Promise<void> {
  return deleteSessionImpl(sessionId, getRepo);
}

/** 团队会话版：删除团队会话。 */
export async function deleteTeamSession(sessionId: string): Promise<void> {
  return deleteSessionImpl(sessionId, getTeamRepo, "team::");
}

/**
 * 清空某团队的所有会话（删除其全部团队会话文件）。
 * 通过 team_ref 自定义条目判断会话归属。返回被删除的会话 id 列表。
 */
export async function clearTeamSessions(teamId: string): Promise<string[]> {
  const sessions = await listTeamSessions().catch(() => []);
  const owned = sessions.filter((s) => s.teamId === teamId);
  await Promise.all(owned.map((s) => deleteTeamSession(s.id)));
  return owned.map((s) => s.id);
}

async function deleteSessionImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  cachePrefix = "",
): Promise<void> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);
  const hits = metas.filter((meta) => meta.id === sessionId);
  for (const hit of hits) {
    await repo.delete(hit).catch((error) => {
      console.error(`删除会话文件失败 ${sessionId}:`, error);
    });
  }
  // 删除后清掉进程内缓存，避免后续复用已删除的 session
  sessionPromises.delete(`${cachePrefix}${sessionId}`);
}

// 团队归属持久化用的自定义条目类型：把会话所属的 teamId 作为一条会话条目落进 jsonl。
const TEAM_REF_ENTRY = "team_ref";

/** 把团队会话归属（teamId）写入会话 meta（追加一条自定义条目）。 */
export async function setTeamSessionTeamRef(
  sessionId: string,
  teamId: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_REF_ENTRY, { teamId });
  } catch (error) {
    console.error(`写入团队会话归属失败 ${sessionId}:`, error);
  }
}

// 从会话条目里取最后一条指定 customType 的某个字符串字段值（后写覆盖先写）。
function readLastCustomEntryString(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
  customType: string,
  field: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === customType) {
      const data = entry.data as Record<string, unknown> | undefined;
      const value = data?.[field];
      if (typeof value === "string" && value.trim()) return value;
      return undefined;
    }
  }
  return undefined;
}

// 工作目录持久化用的自定义条目类型。pi 的 SessionMetadata 不可写自定义字段，
// 这里用 appendCustomEntry 把工作目录作为一条会话条目落进 jsonl，
// 读取时取最后一条同类型条目的值（后写覆盖先写）。
const WORKING_DIR_ENTRY = "working_dir";

/**
 * 读取某会话持久化的工作目录（取最后一次写入）。无则返回 undefined。
 */
export async function getSessionWorkingDir(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateSession(sessionId);
    const entries = await session.getEntries();
    // 从后往前找最后一条 working_dir 自定义条目
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === WORKING_DIR_ENTRY) {
        const data = entry.data as { dir?: unknown } | undefined;
        if (data && typeof data.dir === "string" && data.dir.trim()) {
          return data.dir;
        }
        // 显式写过空串表示「清除」，返回 undefined
        return undefined;
      }
    }
    return undefined;
  } catch (error) {
    console.error(`读取会话工作目录失败 ${sessionId}:`, error);
    return undefined;
  }
}

/**
 * 把工作目录持久化到某会话的 meta（追加一条自定义条目）。
 * 传空串表示清除该会话的工作目录。
 */
export async function setSessionWorkingDir(
  sessionId: string,
  dir: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(WORKING_DIR_ENTRY, { dir });
  } catch (error) {
    console.error(`写入会话工作目录失败 ${sessionId}:`, error);
  }
}

/** 团队会话版：读取某团队会话持久化的工作目录（取最后一次写入）。 */
export async function getTeamSessionWorkingDir(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    const entries = await session.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === WORKING_DIR_ENTRY) {
        const data = entry.data as { dir?: unknown } | undefined;
        if (data && typeof data.dir === "string" && data.dir.trim()) {
          return data.dir;
        }
        return undefined;
      }
    }
    return undefined;
  } catch (error) {
    console.error(`读取团队会话工作目录失败 ${sessionId}:`, error);
    return undefined;
  }
}

/** 团队会话版：把工作目录持久化到某团队会话。 */
export async function setTeamSessionWorkingDir(
  sessionId: string,
  dir: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(WORKING_DIR_ENTRY, { dir });
  } catch (error) {
    console.error(`写入团队会话工作目录失败 ${sessionId}:`, error);
  }
}

/**
 * 回读某会话的「任务监控」快照（待办 + 产物），供重启后恢复右侧面板。
 *
 * 数据与消息回读同源（都来自 jsonl 的工具调用），按时间顺序遍历 assistant 的
 * toolCall block 的 arguments 重建：
 *   - update_todos → 覆盖待办（最后一次调用生效，与运行时 setTodos 语义一致）
 *   - write_file   → 产物（kind 按入参 final 区分 最终/工作 文件）
 *   - edit_file    → 产物（工作文件）
 *   - delete_file  → 从产物快照移除对应文件或目录下全部文件
 * 产物以路径为唯一键去重，后写覆盖先写（含 kind）。
 */
export async function loadThreadMonitor(
  sessionId: string,
): Promise<{ todos: TodoItem[]; artifacts: ArtifactItem[] }> {
  try {
    const session = await openOrCreateSession(sessionId);
    const branch = await session.getBranch().catch(() => []);

    let todos: TodoItem[] = [];
    // 路径 -> 产物，保留插入顺序由下方数组维护
    const artifactMap = new Map<string, ArtifactItem>();
    let order = 0; // 用作 updatedAt 的单调序，避免依赖 Date.now()

    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "assistant") continue;

      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const args = (block.arguments ?? {}) as Record<string, unknown>;

        if (block.name === "update_todos" && Array.isArray(args.todos)) {
          todos = args.todos
            .map((item, index) => {
              if (!item || typeof item !== "object") return null;
              const record = item as { content?: unknown; status?: unknown };
              const content =
                typeof record.content === "string" ? record.content : "";
              const status =
                record.status === "in_progress" ||
                record.status === "completed"
                  ? record.status
                  : "pending";
              if (!content) return null;
              return { id: `todo-${index}`, content, status } as TodoItem;
            })
            .filter((t): t is TodoItem => t !== null);
        } else if (
          (block.name === "write_file" ||
            block.name === "edit_file" ||
            block.name === "delete_file") &&
          typeof args.path === "string" &&
          args.path.trim()
        ) {
          const path = args.path;
          if (block.name === "delete_file") {
            const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
            const prefix = `${normalized}/`;
            for (const key of Array.from(artifactMap.keys())) {
              const itemPath = key.replace(/\\/g, "/").replace(/\/+$/, "");
              if (itemPath === normalized || itemPath.startsWith(prefix)) {
                artifactMap.delete(key);
              }
            }
            continue;
          }
          const name = path.split(/[\\/]/).pop() || path;
          const kind: ArtifactItem["kind"] =
            block.name === "write_file" && args.final === true
              ? "final"
              : "working";
          artifactMap.set(path, { path, name, kind, updatedAt: order++ });
        }
      }
    }

    return { todos, artifacts: Array.from(artifactMap.values()) };
  } catch (error) {
    console.error(`回读会话任务监控失败 ${sessionId}:`, error);
    return { todos: [], artifacts: [] };
  }
}

/**
 * 回读某会话的历史消息，重建为 UI 用的 ChatMessage[]（含 assistant 的 segments）。
 *
 * pi 的 session 把每条 user / assistant / toolResult 作为独立 message 存储。
 * 这里按顺序遍历：
 *   - user      -> 一条用户 ChatMessage（取纯文本）
 *   - assistant -> 一条助手 ChatMessage，content 取 text block，segments 取有序 block
 *   - toolResult-> 不单独成条，按 toolCallId 回填到对应 assistant 的 tool segment 标签
 */
export async function loadChatMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  return loadChatMessagesImpl(sessionId, getRepo);
}

// 团队会话消息：在普通 ChatMessage 基础上附带发言成员 id / 投票信息。
export type TeamChatMessage = ChatMessage & Pick<TeamMessage, "speakerAgentId" | "vote">;

/**
 * 团队会话版：回读团队会话历史，并为每条 assistant 消息附带发言成员 speakerAgentId。
 * 发言成员来自运行时在每位成员发言前写入的 team_speaker 自定义条目（按出现顺序跟踪）。
 */
export async function loadTeamChatMessages(
  sessionId: string,
): Promise<TeamChatMessage[]> {
  return loadChatMessagesImpl(sessionId, getTeamRepo, { trackSpeaker: true });
}

async function loadChatMessagesImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  opts?: { trackSpeaker?: boolean },
): Promise<TeamChatMessage[]> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);
  const hits = metas.filter((meta) => meta.id === sessionId);
  if (hits.length === 0) return [];

  // 同 id 多条时读「内容最多」的那条，确保回读到有消息的会话而非空壳
  const best = await pickBestMeta(hits);
  const session = await repo.open(best);
  const branch = await session.getBranch().catch(() => []);

  // 先收集所有 toolResult，按 toolCallId 建索引，供 assistant 的 tool segment 回填
  const toolResults = new Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      todos?: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    }
  >();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, {
        label: summarizeToolResultContent(message.toolName, message.details),
        isError: message.isError,
        resultText: toolResultDetailsText(message.details),
        // 还原 update_todos 的待办快照，供重启后历史对话仍能按任务分组折叠
        todos: extractTodosFromDetails(message.toolName, message.details),
      });
    }
  }

  const messages: TeamChatMessage[] = [];
  const voteMessageIndexes = new Map<string, number>();

  // 团队模式下跟踪「当前发言成员」：每遇到一条 team_speaker 自定义条目就更新。
  let currentSpeaker: string | undefined;

  // 一次用户提问可能触发 agent 多轮调用，产生多条相邻的 assistant 消息
  // （中间夹着 toolResult）。这里把「相邻的 assistant」合并为一条 ChatMessage，
  // segments 按序拼接，与实时运行时聚合为「一整条消息」的结构保持一致。
  // 遇到 user 消息即断开。
  let pending: {
    id: string;
    createdAt: number;
    segments: Segment[];
    model?: string;
    tokenCount?: number;
    speakerAgentId?: string;
  } | null = null;

  // 把累积中的助手消息落地为一条 ChatMessage
  const flushPending = () => {
    if (!pending || pending.segments.length === 0) {
      pending = null;
      return;
    }
    const content = pending.segments
      .filter((seg): seg is Extract<Segment, { kind: "text" }> => seg.kind === "text")
      .map((seg) => seg.text)
      .filter(Boolean)
      .join("\n");
    messages.push({
      id: pending.id,
      role: "assistant",
      content,
      createdAt: pending.createdAt,
      status: "complete",
      model: pending.model,
      tokenCount: pending.tokenCount,
      segments: pending.segments,
      speakerAgentId: pending.speakerAgentId,
    });
    pending = null;
  };

  for (const entry of branch) {
    if (
      opts?.trackSpeaker &&
      entry.type === "custom" &&
      entry.customType === TEAM_VOTE_ENTRY
    ) {
      flushPending();
      const message = parseTeamVoteEntry(entry.data);
      if (message) {
        const existingIndex = voteMessageIndexes.get(message.id);
        if (existingIndex === undefined) {
          voteMessageIndexes.set(message.id, messages.length);
          messages.push(message);
        } else {
          messages[existingIndex] = message;
        }
      }
      continue;
    }

    // 团队模式：team_speaker 自定义条目用于切换「当前发言成员」，先落地上一位的消息
    if (
      opts?.trackSpeaker &&
      entry.type === "custom" &&
      entry.customType === TEAM_SPEAKER_ENTRY
    ) {
      const data = entry.data as { agentId?: unknown } | undefined;
      if (data && typeof data.agentId === "string") {
        flushPending();
        currentSpeaker = data.agentId;
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const timestamp = Date.parse(entry.timestamp) || message.timestamp || 0;

    if (message.role === "user") {
      // 新的用户消息 -> 先落地累积的助手消息，断开合并
      flushPending();
      const text = userMessageText(message);
      if (text.trim().length === 0) continue;
      messages.push({
        id: entry.id,
        role: "user",
        content: text,
        createdAt: timestamp,
        status: "complete",
      });
    } else if (message.role === "assistant") {
      const segments = assistantSegments(message, toolResults);
      if (segments.length === 0) continue;
      // 追加到当前累积；id/model/tokenCount/时间取该组最后一条（与实时聚合一致）
      if (!pending) {
        pending = {
          id: entry.id,
          createdAt: timestamp,
          segments: [...segments],
          model: message.model,
          tokenCount: message.usage?.totalTokens,
          speakerAgentId: currentSpeaker,
        };
      } else {
        pending.id = entry.id;
        pending.createdAt = timestamp;
        pending.segments.push(...segments);
        pending.model = message.model ?? pending.model;
        pending.tokenCount = message.usage?.totalTokens ?? pending.tokenCount;
      }
    }
    // toolResult 已在上面收集，不单独成条
  }

  // 尾部可能还有未落地的助手消息
  flushPending();

  return messages;
}

// 团队发言成员持久化用的自定义条目类型：运行时在每位成员发言前写入其 agentId。
const TEAM_SPEAKER_ENTRY = "team_speaker";
const TEAM_VOTE_ENTRY = "team_vote";

function parseTeamVoteEntry(data: unknown): TeamChatMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = (data as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const record = message as Partial<TeamMessage>;
  if (
    typeof record.id !== "string" ||
    record.role !== "assistant" ||
    typeof record.content !== "string" ||
    typeof record.createdAt !== "number" ||
    !record.vote
  ) {
    return null;
  }

  return {
    id: record.id,
    role: "assistant",
    content: record.content,
    createdAt: record.createdAt,
    status: record.status ?? "complete",
    model: record.model,
    tokenCount: record.tokenCount,
    segments: record.segments,
    speakerAgentId: record.speakerAgentId,
    vote: record.vote,
  };
}

/** 在团队会话里标记「接下来发言的成员」（运行时在每位成员 prompt 前调用）。 */
export async function appendTeamSpeaker(
  sessionId: string,
  agentId: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_SPEAKER_ENTRY, { agentId });
  } catch (error) {
    console.error(`写入团队发言成员失败 ${sessionId}:`, error);
  }
}

export async function appendTeamVoteMessage(
  sessionId: string,
  message: TeamMessage,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_VOTE_ENTRY, {
      message,
    });
  } catch (error) {
    console.error(`写入团队投票失败 ${sessionId}:`, error);
  }
}

/**
 * 把一条用户消息直接写入团队会话（不经 harness 运行）。
 * 用于团队领导模式：把用户输入作为共享会话的权威记录持久化。
 */
export async function appendTeamUserMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendMessage({
      role: "user",
      content: text,
    } as AgentMessage);
  } catch (error) {
    console.error(`写入团队用户消息失败 ${sessionId}:`, error);
  }
}

/**
 * 把某成员一轮发言（纯文本正文）作为 assistant 消息写入团队会话，
 * 并在其前写入 team_speaker 标记发言成员。供重启后回读还原「谁说了什么」。
 */
export async function appendTeamAssistantMessage(
  sessionId: string,
  agentId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_SPEAKER_ENTRY, { agentId });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
    } as AgentMessage);
  } catch (error) {
    console.error(`写入团队成员发言失败 ${sessionId}:`, error);
  }
}

// 剥离后台注入的技能块 <skill …>…</skill> 与文件块 <file …>…</file>（方案 C）：
// 这些块是 "/" 选中技能时拼进发送内容的 SKILL.md 全文、以及 "@" 选中文件的内容，
// 供模型读取，不应在 UI 对话记录里显示。回读时移除所有此类块及其后随空白，仅保留用户问题。
function stripSkillBlocks(text: string): string {
  return text
    .replace(/<skill\b[^>]*>[\s\S]*?<\/skill>\s*/g, "")
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>\s*/g, "")
    .trim();
}

// 取用户消息的纯文本（content 可能是 string 或 (text|image)[]），并剥离技能块
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  const raw =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("");
  return stripSkillBlocks(raw);
}

// 从 assistant message 的有序 content blocks 重建 segments
function assistantSegments(
  message: Extract<AgentMessage, { role: "assistant" }>,
  toolResults: Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      todos?: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    }
  >,
): Segment[] {
  const segments: Segment[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        segments.push({ kind: "text", text: block.text });
      }
    } else if (block.type === "thinking") {
      if (block.thinking.trim().length > 0) {
        segments.push({ kind: "thinking", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const result = toolResults.get(block.id);
      segments.push({
        kind: "tool",
        toolCallId: block.id,
        toolName: block.name,
        label: result?.label ?? toolDisplayName(block.name),
        status: result ? (result.isError ? "error" : "done") : "done",
        resultText: result?.resultText,
        // 还原 update_todos 的待办快照，使重启后历史对话仍能按任务分组折叠
        todos: result?.todos,
      });
    }
  }
  return segments;
}

// 工具结果 details -> 单行摘要（与 agent.ts 的运行时摘要保持一致风格）
function summarizeToolResultContent(toolName: string, details: unknown): string {
  const base = toolDisplayName(toolName);
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (toolName === "update_todos" && Array.isArray(record.todos)) {
      return `已更新待办 ${record.todos.length} 项`;
    }
    if (toolName === "write_file" && typeof record.path === "string") {
      return `已写入 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "create_directory" && typeof record.path === "string") {
      return `已创建目录 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "delete_file" && typeof record.path === "string") {
      return `已删除 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "list_directory" && Array.isArray(record.entries)) {
      return `列出 ${record.entries.length} 个条目`;
    }
  }
  return base;
}

// 从回读到的 toolResult.details 里抽取 update_todos 的待办快照。
// 与 agent.ts 的 extractTodos 等价，但这里 details 已是对象（无 result.details 外层）。
function extractTodosFromDetails(
  toolName: string,
  details: unknown,
):
  | Array<{ content: string; status: "pending" | "in_progress" | "completed" }>
  | undefined {
  if (toolName !== "update_todos") return undefined;
  if (!details || typeof details !== "object") return undefined;
  const rawTodos = (details as Record<string, unknown>).todos;
  if (!Array.isArray(rawTodos)) return undefined;

  const todos = rawTodos
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as { content?: unknown; status?: unknown };
      const content = typeof record.content === "string" ? record.content : "";
      const status =
        record.status === "in_progress" || record.status === "completed"
          ? record.status
          : "pending";
      if (!content) return null;
      return { content, status } as const;
    })
    .filter(
      (
        item,
      ): item is {
        content: string;
        status: "pending" | "in_progress" | "completed";
      } => item !== null,
    );

  return todos.length > 0 ? todos : undefined;
}

// 工具结果 details -> 完整可读文本（供步骤项点击展开查看）
function toolResultDetailsText(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") {
    return details.trim() || undefined;
  }
  if (typeof details === "object") {
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return undefined;
    }
  }
  return String(details);
}

// 测试期重置（清空缓存的 env/repo），便于在数据目录变化后重建
export function resetSessionRuntime(): void {
  envPromise = null;
  repoPromise = null;
  teamRepoPromise = null;
  sessionPromises.clear();
}
