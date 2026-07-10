import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  getRepo,
  getScheduleRepo,
  sessionPromises,
} from "./session-repo";
import {
  pickBestMeta,
  type SessionMeta,
} from "./meta-selection";
import { isScheduleThreadId } from "@/lib/schedule/runtime-ids";
import { readTitleIndex, rebuildTitleIndex } from "./title-index";
import { getSessionProjectId } from "./preferences";
import { deleteSessionFilesDir } from "./files";
import { pMap, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";

const SUBAGENT_SESSION_MARKER = "__sub_";

/** 打开已存在的会话；若不存在则按给定 id 新建。 */
export async function openOrCreateSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getRepo);
}

/** 定时任务后台会话版：打开/创建 schedule 会话（存于 schedule/conversations 下的独立 repo）。 */
export async function openOrCreateScheduleSession(
  sessionId: string,
): Promise<Session> {
  return openOrCreateSessionImpl(sessionId, getScheduleRepo, "schedule::");
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
  Array<{ id: string; createdAt: string; path: string; title?: string; updatedAt?: number; projectId?: string }>
> {
  const repo = await getRepo();
  const metas = (await repo.list().catch(() => [])).filter(
    (meta) => !isScheduleThreadId(meta.id) && !isSubagentSessionId(meta.id),
  );
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
      let projectId: string | undefined;
      if (cached) {
        title = cached.title;
        updatedAt = cached.updatedAt;
        projectId = cached.projectId;
      } else {
        indexMissing = true;
        title = await readTitleFromSessions(repo, group);
        projectId = await getSessionProjectId(best.id);
      }
      return { id: best.id, createdAt: best.createdAt, path: best.path, title, updatedAt, projectId };
    },
    { concurrency: LOCAL_IO_CONCURRENCY },
  );

  if (indexMissing) {
    void rebuildTitleIndex(
      result.map((item) => ({
        id: item.id,
        title: item.title || "新对话",
        updatedAt: Date.parse(item.createdAt) || 0,
        projectId: item.projectId,
      })),
    );
  }

  return result;
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
  return deleteSessionImpl(sessionId, getRepo, "", { includeSubagents: true });
}

export async function deleteScheduleSession(sessionId: string): Promise<void> {
  return deleteSessionImpl(sessionId, getScheduleRepo, "schedule::");
}

async function deleteSessionImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  cachePrefix = "",
  options?: { includeSubagents?: boolean },
): Promise<void> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);
  const childPrefix = `${sessionId}${SUBAGENT_SESSION_MARKER}`;
  const hits = metas.filter(
    (meta) =>
      meta.id === sessionId ||
      (options?.includeSubagents === true && meta.id.startsWith(childPrefix)),
  );
  const deletedIds = new Set<string>();
  for (const hit of hits) {
    await repo.delete(hit).catch((error) => {
      console.error(`删除会话文件失败 ${hit.id}:`, error);
    });
    deletedIds.add(hit.id);
  }
  for (const deletedId of deletedIds) {
    sessionPromises.delete(`${cachePrefix}${deletedId}`);
  }

  if (options?.includeSubagents === true) {
    const childIds = Array.from(deletedIds).filter((id) => id !== sessionId);
    await pMap(childIds, (id) => deleteSessionFilesDir(id), {
      concurrency: LOCAL_IO_CONCURRENCY,
    });
  }
}

function isSubagentSessionId(sessionId: string): boolean {
  return sessionId.includes(SUBAGENT_SESSION_MARKER);
}
