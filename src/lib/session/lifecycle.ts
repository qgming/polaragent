import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  getRepo,
  getTeamRepo,
  sessionPromises,
} from "./session-repo";
import {
  pickBestMeta,
  readLastCustomEntryString,
  type SessionMeta,
} from "./meta-selection";
import { TEAM_REF_ENTRY } from "./entries";
import { readTitleIndex, rebuildTitleIndex, removeTitleIndex } from "./title-index";
import { deleteTeamSessionFilesDir } from "./files";
import { pMap, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";

/** 打开已存在的会话；若不存在则按给定 id 新建。 */
export async function openOrCreateSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getRepo);
}

/** 团队会话版：打开/创建团队会话（存于 teams/conversations 下的独立 repo）。 */
export async function openOrCreateTeamSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getTeamRepo, "team::");
}

async function openOrCreateSessionImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  cachePrefix = "",
): Promise<Session> {
  const cacheKey = `${cachePrefix}${sessionId}`;
  const cached = sessionPromises.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const repo = await repoGetter();
    // cwd 会被 JsonlSessionRepo 编码为子目录名，使用 "." 避免绝对路径被编码成冗长目录名
    const cwd = ".";
    const existing = await repo.list().catch(() => []);
    const hits = existing.filter((meta) => meta.id === sessionId);
    if (hits.length > 0) {
      const best = await pickBestMeta(hits);
      return repo.open(best);
    }

    return repo.create({ cwd, id: sessionId });
  })();

  sessionPromises.set(cacheKey, promise);
  promise.catch(() => sessionPromises.delete(cacheKey));
  return promise;
}

export async function listSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string; updatedAt?: number }>
> {
  const repo = await getRepo();
  const metas = await repo.list().catch(() => []);
  const groups = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    const list = groups.get(meta.id);
    if (list) list.push(meta);
    else groups.set(meta.id, [meta]);
  }

  const index = await readTitleIndex();
  let indexMissing = false;
  const result = await pMap(
    Array.from(groups.values()),
    async (group) => {
      const best = await pickBestMeta(group);
      const cached = index[best.id];
      let title: string | undefined;
      let updatedAt: number | undefined;
      if (cached) {
        title = cached.title;
        updatedAt = cached.updatedAt;
      } else {
        indexMissing = true;
        title = await readTitleFromSessions(repo, group);
      }
      return { id: best.id, createdAt: best.createdAt, path: best.path, title, updatedAt };
    },
    { concurrency: LOCAL_IO_CONCURRENCY },
  );

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

export async function listTeamSessions(): Promise<
  Array<{ id: string; createdAt: string; path: string; title?: string; updatedAt?: number; teamId?: string }>
> {
  const repo = await getTeamRepo();
  const metas = await repo.list().catch(() => []);
  const groups = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    if (meta.id.includes("__m_")) continue;
    const list = groups.get(meta.id);
    if (list) list.push(meta);
    else groups.set(meta.id, [meta]);
  }

  const index = await readTitleIndex("team");
  let indexMissing = false;
  const result = await pMap(
    Array.from(groups.values()),
    async (group) => {
      const best = await pickBestMeta(group);
      const cached = index[best.id];
      let title: string | undefined;
      let teamId: string | undefined;
      let updatedAt: number | undefined;
      if (cached) {
        title = cached.title;
        teamId = cached.teamId;
        updatedAt = cached.updatedAt;
      } else {
        indexMissing = true;
        title = await readTitleFromSessions(repo, group);
        teamId = await readTeamRefFromSession(best.id);
      }
      return { id: best.id, createdAt: best.createdAt, path: best.path, title, updatedAt, teamId };
    },
    { concurrency: LOCAL_IO_CONCURRENCY },
  );

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

async function readTeamRefFromSession(sessionId: string): Promise<string | undefined> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    return readLastCustomEntryString(await session.getEntries(), TEAM_REF_ENTRY, "teamId");
  } catch {
    return undefined;
  }
}

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
      // Ignore unreadable entries.
    }
  }
  return undefined;
}

export async function setSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  return setSessionTitleImpl(sessionId, title, getRepo);
}

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

export async function deleteSession(sessionId: string): Promise<void> {
  return deleteSessionImpl(sessionId, getRepo);
}

export async function deleteTeamSession(sessionId: string): Promise<void> {
  return deleteSessionImpl(sessionId, getTeamRepo, "team::");
}

export async function clearTeamSessions(teamId: string): Promise<string[]> {
  const sessions = await listTeamSessions().catch(() => []);
  const owned = sessions.filter((s) => s.teamId === teamId);
  await pMap(
    owned,
    (s) => deleteTeamSession(s.id),
    { concurrency: LOCAL_IO_CONCURRENCY },
  );
  await pMap(
    owned,
    (s) => deleteTeamSessionFilesDir(s.id),
    { concurrency: LOCAL_IO_CONCURRENCY },
  );
  await pMap(
    owned,
    (s) => removeTitleIndex(s.id, "team"),
    { concurrency: LOCAL_IO_CONCURRENCY },
  );
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
  sessionPromises.delete(`${cachePrefix}${sessionId}`);
}

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
