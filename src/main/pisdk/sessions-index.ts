import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import type { AgentMode, ModelRef } from "@/shared/contracts/common";
import type { SessionUsageRecord } from "@/shared/contracts/session";

/**
 * 会话索引条目：补齐 pi 元数据缺失的应用层字段。
 * cwd 也放这里——SQLite 后端的 create 不接受 cwd，无法写进 pi 元数据。
 */
export interface SessionIndexEntry {
  title?: string;
  archived?: boolean;
  /** 置顶是应用层状态，pi 元数据里没有 */
  pinned?: boolean;
  updatedAt?: number;
  messageCount?: number;
  cwd?: string;
  /** 该会话自己指定的模型；null = 跟随设置里的默认模型（写 null 即清除绑定） */
  model?: ModelRef | null;
  /**
   * 该会话自己指定的智能体模式；null / 缺省 = 跟随设置里的默认模式。
   *
   * 与 model 一样落在索引里（不进 pi 会话元数据）：它是应用层的展示与装配选择，
   * 内核不需要、也不该进模型上下文。
   */
  agentMode?: AgentMode | null;
  /**
   * 随会话持久化的用量快照（会话统计 / Token 合计 / 上下文分解）。
   *
   * 为什么落在索引而不是 pi 会话里：这三样都是**应用层的展示派生数据**，
   * 内核不需要、也不该进模型上下文；而索引本就按会话 id 存储应用层字段，
   * 读一次列表就能把侧栏与底栏一起喂饱。
   */
  usage?: SessionUsageRecord;
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
    await writeFileAtomic(filePath, payload);
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
