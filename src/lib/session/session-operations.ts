// 会话级操作：打开/创建、列举、删除、标题、工作目录、团队归属与团队消息追加。
// 普通会话与团队会话成对提供（团队版走独立 repo），共用一组 *Impl 内部实现。
import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TeamMessage } from "@/stores/team/team-chat-store";
import {
  getExecutionEnv,
  getRepo,
  getTeamRepo,
  getTeamSessionsRoot,
  sessionPromises,
  getSessionsRoot,
} from "./session-repo";
import { pickBestMeta, readLastCustomEntryString, type SessionMeta } from "./meta-selection";
import { TEAM_REF_ENTRY, TEAM_SPEAKER_ENTRY, TEAM_VOTE_ENTRY, WORKING_DIR_ENTRY } from "./entries";
import { readTitleIndex, rebuildTitleIndex, removeTitleIndex } from "./title-index";
import { createDirectory, deleteFile, fileExists } from "@/lib/electron/electron-api";

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

/**
 * 列出所有会话的元数据（id + 创建时间 + 标题）。
 *
 * 快路径：repo.list() 只读每个 jsonl 第一行 header（廉价），拿到 id/createdAt；
 * 标题从 titles.json 索引读取，不再为取标题 open 整个文件。
 *
 * 慢路径（回退）：索引里缺失的 id（老用户首次启动、或新会话尚未写入索引），
 * 才逐个 open 读 session name；读完把全量结果回写索引，下次即走快路径。
 *
 * 历史脏数据可能出现同 id 的多个 jsonl（并发创建竞态遗留：一条带标题、一条带消息）。
 * 这里按 id 折叠为一条：createdAt 取最优那条，标题优先取索引、回退读 name。
 */
export async function listSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string; updatedAt?: number }>
> {
  const repo = await getRepo();
  const metas = await repo.list().catch(() => []);

  // 按 id 分组（折叠历史同 id 多文件）
  const groups = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    const list = groups.get(meta.id);
    if (list) list.push(meta);
    else groups.set(meta.id, [meta]);
  }

  const index = await readTitleIndex();
  let indexMissing = false; // 是否出现过「索引里没有」的 id，用于决定是否回写索引

  const result = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      // createdAt/path 取「内容最多」的那条，确保点开能读到有消息的会话
      const best = await pickBestMeta(group);
      const cached = index[best.id];
      let title: string | undefined;
      let updatedAt: number | undefined;
      if (cached) {
        // 快路径：标题/更新时间来自索引，零额外读盘
        title = cached.title;
        updatedAt = cached.updatedAt;
      } else {
        // 慢路径：索引缺失，回退逐个 open 读 session name
        indexMissing = true;
        title = await readTitleFromSessions(repo, group);
      }
      return { id: best.id, createdAt: best.createdAt, path: best.path, title, updatedAt };
    }),
  );

  // 索引有缺失（首次启动 / 老数据）则用本次全量结果重建一次，使下次走快路径
  if (indexMissing) {
    void rebuildTitleIndex(
      result.map((item) => ({
        id: item.id,
        title: item.title || "新对话",
        updatedAt: Date.parse(item.createdAt) || 0,
      })),
    );
  }

  return result;
}

/**
 * 团队会话版：列出团队会话仓库里的会话，并附带每条会话归属的 teamId。
 * 供团队聊天 store 按 teamId 分组。
 *
 * 快路径：标题与 teamId 都从 teams/conversations/titles.json 索引读取，零额外读盘。
 * 慢路径（回退）：索引缺失的 id 才 open 整文件读 session name + team_ref，
 * 读完把全量结果回写团队索引，下次即走快路径。
 */
export async function listTeamSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string; updatedAt?: number; teamId?: string }>
> {
  const repo = await getTeamRepo();
  const metas = await repo.list().catch(() => []);

  // 按 id 分组（折叠历史同 id 多文件），并排除成员私有 session（id 含 "__m_"）——
  // 它们只是各成员发言时的 harness 草稿，不是「团队会话」本身。
  const groups = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    if (meta.id.includes("__m_")) continue;
    const list = groups.get(meta.id);
    if (list) list.push(meta);
    else groups.set(meta.id, [meta]);
  }

  const index = await readTitleIndex("team");
  let indexMissing = false;

  const result = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const best = await pickBestMeta(group);
      const cached = index[best.id];
      let title: string | undefined;
      let teamId: string | undefined;
      let updatedAt: number | undefined;
      if (cached) {
        // 快路径：标题/归属/更新时间均来自索引
        title = cached.title;
        teamId = cached.teamId;
        updatedAt = cached.updatedAt;
      } else {
        // 慢路径：索引缺失，回退 open 整文件读标题与 team_ref
        indexMissing = true;
        title = await readTitleFromSessions(repo, group);
        teamId = await readTeamRefFromSession(best.id);
      }
      return { id: best.id, createdAt: best.createdAt, path: best.path, title, updatedAt, teamId };
    }),
  );

  // 索引有缺失（首次启动 / 老数据）则用本次全量结果重建团队索引，使下次走快路径
  if (indexMissing) {
    void rebuildTitleIndex(
      result.map((item) => ({
        id: item.id,
        title: item.title || "新会话",
        updatedAt: item.updatedAt ?? (Date.parse(item.createdAt) || 0),
        teamId: item.teamId,
      })),
      "team",
    );
  }

  return result;
}

/** 慢路径读团队归属：open 整个团队会话取最后一条 team_ref 的 teamId。 */
async function readTeamRefFromSession(sessionId: string): Promise<string | undefined> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    return readLastCustomEntryString(await session.getEntries(), TEAM_REF_ENTRY, "teamId");
  } catch {
    return undefined;
  }
}

/**
 * 慢路径取标题：在同 id 的一组 meta 里，打开任意一条能读到 session name 的会话取其标题。
 * 标题常落在「空壳」那条，故需遍历整组。仅在索引缺失（回退）时调用。
 * 会读取整个 jsonl，开销较大——平时由 titles.json 索引覆盖，避免走到这里。
 */
async function readTitleFromSessions(
  repo: JsonlSessionRepo,
  group: SessionMeta[],
): Promise<string | undefined> {
  for (const meta of group) {
    try {
      const session = await repo.open(meta);
      const name = await session.getSessionName();
      if (name && name.trim()) return name;
    } catch {
      // 忽略打不开的条目
    }
  }
  return undefined;
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
  // 删除各会话的文件存储目录
  await Promise.all(owned.map((s) => deleteTeamSessionFilesDir(s.id)));
  // 同步从团队标题索引移除被删会话
  await Promise.all(owned.map((s) => removeTitleIndex(s.id, "team")));
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

// ============ 文件目录管理 ============

/**
 * 获取会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getSessionsRoot();
  return `${root}/${sessionId}_files`;
}

/**
 * 获取团队会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getTeamSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getTeamSessionsRoot();
  return `${root}/${sessionId}_files`;
}

/**
 * 创建会话的文件存储目录（如果不存在）。
 * 在创建新会话时自动调用。
 */
export async function ensureSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (!exists) {
      await createDirectory(dir);
      console.log(`创建会话文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`创建会话文件目录失败 ${sessionId}:`, error);
  }
}

/**
 * 创建团队会话的文件存储目录（如果不存在）。
 * 在创建新团队会话时自动调用。
 */
export async function ensureTeamSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getTeamSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (!exists) {
      await createDirectory(dir);
      console.log(`创建团队文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`创建团队文件目录失败 ${sessionId}:`, error);
  }
}

/**
 * 删除会话的文件存储目录（如果存在）。
 * 在删除会话时自动调用。
 */
export async function deleteSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (exists) {
      await deleteFile(dir);
      console.log(`删除会话文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`删除会话文件目录失败 ${sessionId}:`, error);
  }
}

/**
 * 删除团队会话的文件存储目录（如果存在）。
 * 在删除团队会话时自动调用。
 */
export async function deleteTeamSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getTeamSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (exists) {
      await deleteFile(dir);
      console.log(`删除团队文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`删除团队文件目录失败 ${sessionId}:`, error);
  }
}
