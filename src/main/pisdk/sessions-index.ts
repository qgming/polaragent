import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 会话索引条目：补齐 pi 元数据缺失的应用层字段。
 * cwd 也放这里——SQLite 后端的 create 不接受 cwd，无法写进 pi 元数据。
 */
export interface SessionIndexEntry {
  title?: string;
  archived?: boolean;
  updatedAt?: number;
  messageCount?: number;
  cwd?: string;
}

export interface SessionsIndex {
  [sessionId: string]: SessionIndexEntry;
}

export interface SessionsIndexStore {
  read(): Promise<SessionsIndex>;
  update(id: string, patch: SessionIndexEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 轻量索引文件：位于 {baseDir}/sessions-index.json（baseDir 即数据根 ~/.oint） */
export function createSessionsIndex(baseDir: string): SessionsIndexStore {
  const filePath = path.join(baseDir, "sessions-index.json");
  // 串行化读-改-写，避免并发 update 互相覆盖
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<SessionsIndex> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
      return raw as SessionsIndex;
    } catch (error) {
      // 文件缺失是正常情况；其余读取/解析失败也返回空索引，绝不抛错
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`读取会话索引失败，已回退空索引: ${String(error)}`);
      }
      return {};
    }
  }

  async function write(index: SessionsIndex): Promise<void> {
    const payload = `${JSON.stringify(index, null, 2)}\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，避免中断时留下半截 JSON
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function update(id: string, patch: SessionIndexEntry): Promise<void> {
    return enqueue(async () => {
      const index = await read();
      index[id] = { ...(index[id] ?? {}), ...patch };
      await write(index);
    });
  }

  function remove(id: string): Promise<void> {
    return enqueue(async () => {
      const index = await read();
      if (index[id] === undefined) return;
      delete index[id];
      await write(index);
    });
  }

  return { read, update, remove };
}
