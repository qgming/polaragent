// 文件面板 IPC 的安全边界回归测试。
//
// **这个文件存在的理由**：早先的实现让渲染层传 root，主进程用
// `validatePathAccess(root, [root])` 校验它 —— 而「路径在它自己内部」恒为真，
// 等于没有校验。渲染层只要传 `{root:"C:\\"}` 就能读任意文件。
//
// 所以这里钉住的不变量是：**root 只能来自会话索引，渲染层给不了**。
// 单测不便模拟「渲染层直接调 IPC」，改为从契约形状上验证：
//   1. 请求里带 root 也不起作用（它被忽略，真正的根来自会话索引）；
//   2. 会话索引给出的 cwd 之外的路径一律被拒；
//   3. 会话不存在 / 未绑定工作目录时直接拒绝，不退化成进程当前目录。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const registered = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
/** 会话索引的替身：只回一个受控的 cwd，用来证明 root 的来源是它而不是请求体 */
const session = vi.hoisted(() => ({ cwd: null as string | null }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Handler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

vi.mock("@/main/pisdk/session-store", () => ({
  getSessionStore: () => ({
    readCwd: async (id: string) => (id === "known-session" ? session.cwd : null),
  }),
}));

import { normalizePath } from "@/main/security/path-guard";
import type { DirectoryListing, FileContent } from "@/shared/contracts/files";
import { IPC } from "@/shared/contracts/ipc";
import { registerFilesIpc } from "./files";

function invoke<T>(channel: string, request?: unknown): Promise<T> {
  const handler = registered.handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler 未注册`);
  return handler({}, request) as Promise<T>;
}

let root: string;
/** 会话工作目录的兄弟目录：位于 root 之外，用来验证越界被拒 */
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "oint-files-ipc-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "inside.txt"), "inside\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");

  session.cwd = root;
  registered.handlers.clear();
  registerFilesIpc();
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe("files IPC 的根来源", () => {
  it("渲染层传 root 不生效：根取会话索引，伪造的 root 被忽略", async () => {
    // 第一条：请求体里塞一个越界的 root，但仍然列出会话自己的工作目录。
    // 若 root 还能由请求体决定，这个 listing.root 就会是 outside。
    const listing = await invoke<DirectoryListing>(IPC.files.listDirectory, {
      sessionId: "known-session",
      root: outside,
    });
    // 回传的路径是归一化后的（Windows 盘符小写），与守卫的输出口径一致
    expect(listing.root).toBe(normalizePath(root));
    expect(listing.entries.map((entry) => entry.name)).toContain("inside.txt");
    expect(listing.entries.map((entry) => entry.name)).not.toContain("secret.txt");

    // 第二条：用伪造的 root 去读它下面的文件 —— 越界被拒，而不是回落到请求体给的 root
    await expect(
      invoke(IPC.files.readFile, {
        sessionId: "known-session",
        root: outside,
        path: path.join(outside, "secret.txt"),
      }),
    ).rejects.toThrow(/不在允许的工作目录内/);

    // 第三条：即使靠相对路径从会话目录爬到兄弟目录，也读不到
    await expect(
      invoke(IPC.files.readFile, {
        sessionId: "known-session",
        path: path.join(root, "..", "outside", "secret.txt"),
      }),
    ).rejects.toThrow(/不在允许的工作目录内/);
  });

  it("会话工作目录内的正常读写仍然可用", async () => {
    const listing = await invoke<DirectoryListing>(IPC.files.listDirectory, {
      sessionId: "known-session",
    });
    expect(listing.path).toBe(normalizePath(root));
    expect(listing.entries.map((entry) => entry.name)).toContain("inside.txt");

    const file = await invoke<FileContent>(IPC.files.readFile, {
      sessionId: "known-session",
      path: path.join(root, "inside.txt"),
    });
    expect(file.text).toBe("inside\n");
  });

  it("会话不存在 / 未绑定工作目录时拒绝，不退化成进程当前目录", async () => {
    await expect(
      invoke(IPC.files.listDirectory, { sessionId: "unknown-session" }),
    ).rejects.toThrow();

    session.cwd = null;
    await expect(invoke(IPC.files.listDirectory, { sessionId: "known-session" })).rejects.toThrow();
  });

  it("缺少 sessionId 时拒绝", async () => {
    await expect(invoke(IPC.files.listDirectory, {})).rejects.toThrow();
    await expect(invoke(IPC.files.readFile, { path: "x.txt" })).rejects.toThrow();
  });

  it("相对路径逃逸（..）被拒", async () => {
    await expect(
      invoke(IPC.files.readFile, {
        sessionId: "known-session",
        path: path.join(root, "..", "outside", "secret.txt"),
      }),
    ).rejects.toThrow();
  });
});

/**
 * P0-2 修复的**残留缺口**（已知，需产品决策，不是本次修复引入的）。
 *
 * 本次修复把 root 从「渲染层直接传」改成「主进程按 sessionId 从会话索引解析」，
 * 这消掉了「一个请求就能读任意路径」的原语。但 root 的**来源**仍是渲染层可控的：
 *
 *   sessions:create({ cwd: "/" })  →  索引里的 cwd = "/"
 *   files:read-file({ sessionId }) →  root = "/"
 *
 * 也就是说渲染层只要多走一步（先建一个 cwd 指向目标的会话），仍能读到那个目录。
 * 相比修复前它确实变难了（多一次调用、且会在侧栏留下一个可见的会话），
 * 但**不是一道完整的边界**。
 *
 * 彻底收口需要把「选哪个目录」这件事变成主进程独有（例如由主进程弹目录选择器、
 * 只把不透明 id 交给渲染层），那是一次设计改动，超出本次修复范围。
 *
 * 这个用例记录的是**当前真实行为**，不是期望行为 —— 它存在的目的是让缺口可见，
 * 而不是假装它已被堵上。改写它之前请先做上面那个产品决策。
 */
describe("[已知缺口] files 的 root 仍间接受渲染层影响", () => {
  it("渲染层可以先把会话 cwd 指到某目录，再通过该会话读到它", async () => {
    session.cwd = outside;

    const listing = await invoke<DirectoryListing>(IPC.files.listDirectory, {
      sessionId: "known-session",
    });

    // 记录现状：root 跟着 cwd 走了
    expect(listing.root).toBe(normalizePath(outside));
  });
});
