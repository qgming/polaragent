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
//   3. 会话不存在时拒绝；**没绑过工作目录的会话拿到一个临时目录**，
//      而不是进程当前目录（那会让边界随启动方式漂移）。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const registered = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
/**
 * 会话索引的替身：只回一个受控的 cwd，用来证明 root 的来源是它而不是请求体。
 *
 * `workspace` 是 `ensureCwd` 在「没绑过工作目录」时会现建的那个临时目录 ——
 * 真实实现里它由会话 id 算出来（`<数据根>/workspaces/<会话 id>`）。
 */
const session = vi.hoisted(() => ({ cwd: null as string | null, workspace: "" }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Handler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

vi.mock("@/main/pisdk/session-store", () => ({
  getSessionStore: () => ({
    // 真实实现里 ensureCwd 对不存在的会话抛错、对没绑定的会话建临时目录
    ensureCwd: async (id: string) => {
      if (id !== "known-session") throw new Error(`会话不存在：${id}`);
      return session.cwd ?? session.workspace;
    },
  }),
}));

import { normalizePath } from "@/main/security/path-guard";
import type { DirectoryListing, FileContent, FileWriteResult } from "@/shared/contracts/files";
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
  session.workspace = path.join(base, "workspaces", "known-session");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(session.workspace, { recursive: true });
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

  it("会话不存在时拒绝；没绑过工作目录时用本会话的临时目录", async () => {
    // 会话不存在：拒绝，且不为这个拼错的 id 建目录（真实实现里 ensureCwd 会抛）
    await expect(
      invoke(IPC.files.listDirectory, { sessionId: "unknown-session" }),
    ).rejects.toThrow();

    // 没绑过工作目录：根是主进程现补的临时目录 —— 面板因此能打开模型写过的文件，
    // 而**不是**退化成进程当前目录（那会让能访问哪些文件随启动方式漂移）
    session.cwd = null;
    await writeFile(path.join(session.workspace, "written.md"), "hello\n", "utf8");

    const listing = await invoke<DirectoryListing>(IPC.files.listDirectory, {
      sessionId: "known-session",
    });
    expect(listing.root).toBe(normalizePath(session.workspace));
    expect(listing.entries.map((entry) => entry.name)).toContain("written.md");
    expect(listing.root).not.toBe(normalizePath(process.cwd()));

    // 临时目录里的文件能读，临时目录之外仍然被拒（边界没有因为「现补根」而松开）
    const file = await invoke<FileContent>(IPC.files.readFile, {
      sessionId: "known-session",
      path: path.join(session.workspace, "written.md"),
    });
    expect(file.text).toBe("hello\n");
    await expect(
      invoke(IPC.files.readFile, {
        sessionId: "known-session",
        path: path.join(outside, "secret.txt"),
      }),
    ).rejects.toThrow(/不在允许的工作目录内/);
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
 * 写通道（files:write-file）：`files` 域里**唯一会改盘**的通道，所以单独钉两组不变量 ——
 * root 只能来自会话索引（与三条读通道同口径），以及越界路径必须被拒。
 *
 * 守卫是 realpath 版，理由在 main/files/service.ts 的 writeFileContent 上；
 * 符号链接逃逸、二进制、超上限、原子写失败这些细节用例在 main/files/service.write.test.ts。
 */
describe("files:write-file", () => {
  it("正常写回：改的确实是会话工作目录里的文件", async () => {
    const target = path.join(root, "inside.txt");
    const result = await invoke<FileWriteResult>(IPC.files.writeFile, {
      sessionId: "known-session",
      path: target,
      text: "改过了\n",
    });

    expect(result.path).toBe(normalizePath(target));
    expect(result.bytes).toBe(Buffer.byteLength("改过了\n", "utf8"));
    expect(await readFile(target, "utf8")).toBe("改过了\n");
  });

  it("越界路径被拒：请求体里伪造 root 不起作用，且目标文件未被改动", async () => {
    const victim = path.join(outside, "secret.txt");

    await expect(
      invoke(IPC.files.writeFile, {
        sessionId: "known-session",
        root: outside,
        path: victim,
        text: "pwned",
      }),
    ).rejects.toThrow(/不在允许的工作目录内/);

    expect(await readFile(victim, "utf8")).toBe("secret\n");
  });

  it("缺少 sessionId 时拒绝", async () => {
    await expect(
      invoke(IPC.files.writeFile, { path: path.join(root, "inside.txt"), text: "x" }),
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
