// 项目列表：侧栏「项目」分组的持久化。
//
// 绑定关系只存一份路径列表——会话归属由 cwd 反推（见 shared/contracts/project.ts），
// 所以这里没有会话侧状态，增删项目都只动这一个文件。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import type { Project } from "@/shared/contracts/project";

export interface ProjectsStore {
  list(): Promise<Project[]>;
  /** 绑定一个目录；已绑定同一路径时直接返回已有项目（不重复建） */
  add(path: string): Promise<Project>;
  remove(id: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 非空字符串校验：空白值不算有效内容，避免界面出现空名字/空路径 */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

/**
 * 逐条容错解析：字段缺失或非法的条目丢弃。
 * 是「丢坏条目」而不是「整份丢弃」——一条脏数据不该清空用户的全部项目。
 */
function sanitizeProject(value: unknown): Project | undefined {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id);
  const name = asNonEmptyString(value.name);
  const target = asNonEmptyString(value.path);
  if (id === undefined || name === undefined || target === undefined) return undefined;
  return {
    id,
    name,
    path: target,
    // createdAt 非有限数时回退 0：项目仍然可用，只是时间未知
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
  };
}

/**
 * 路径比较键：Windows 下大小写不敏感且分隔符统一（D:\Work\app 与 d:/work/app/ 是同一目录），
 * 其余平台按 resolve 后的结果原样比较。
 */
function normalizeKey(target: string): string {
  const resolved = path.resolve(target);
  if (process.platform !== "win32") return resolved;
  return path.normalize(resolved).replace(/\\/g, "/").toLowerCase();
}

/** 项目列表存储；测试可注入临时目录 */
export function createProjectsStore(baseDir: string): ProjectsStore {
  const filePath = path.join(baseDir, "projects.json");
  // 串行化读-改-写：并发 add/remove 若各读一份再写回，会互相覆盖
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<Project[]> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => sanitizeProject(item))
        .filter((item): item is Project => item !== undefined);
    } catch (error) {
      // 文件缺失是正常情况；损坏也回退空列表，读取绝不抛错
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`读取项目列表失败，已回退空列表: ${String(error)}`);
      }
      return [];
    }
  }

  async function write(projects: Project[]): Promise<void> {
    const payload = `${JSON.stringify(projects, null, 2)}\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，避免中断时留下半截 JSON
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function add(rawPath: string): Promise<Project> {
    const trimmed = rawPath.trim();
    if (trimmed === "") throw new Error("项目路径不能为空");
    // resolve 得到绝对路径并去掉尾部分隔符（盘根除外），后续比较都基于它
    const resolved = path.resolve(trimmed);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`项目目录不存在或不是目录：${resolved}`);

    return enqueue(async () => {
      const projects = await read();
      const key = normalizeKey(resolved);
      // 去重按归一化路径：同一目录的 ./ 写法、尾部分隔符、Windows 大小写差异都算同一项目
      const existing = projects.find((project) => normalizeKey(project.path) === key);
      // 命中时原样返回已有项目：不新增、也不更新 createdAt，保证列表稳定且 id 不变
      if (existing) return existing;

      const project: Project = {
        id: randomUUID(),
        // 目录名作展示名；盘根（如 D:\）没有目录名，回退整条路径
        name: path.basename(resolved) || resolved,
        path: resolved,
        createdAt: Date.now(),
      };
      // 追加到尾部：界面按添加顺序稳定排列
      projects.push(project);
      await write(projects);
      return project;
    });
  }

  async function remove(id: string): Promise<void> {
    await enqueue(async () => {
      const projects = await read();
      // 不存在时静默返回：重复解绑不报错，调用方无需先查再删
      const kept = projects.filter((project) => project.id !== id);
      if (kept.length === projects.length) return;
      await write(kept);
    });
  }

  return {
    list: async () => [...(await read())],
    add,
    remove,
  };
}

let defaultStore: ProjectsStore | null = null;

/** 默认单例：项目列表位于数据根下的 projects.json（~/.oint 或 OINT_HOME 指定的目录） */
export function getProjectsStore(): ProjectsStore {
  defaultStore ??= createProjectsStore(dataDir());
  return defaultStore;
}
