// 提示模板的写 / 读 / 删 IPC 单测：走真实文件系统（dataDir 指向临时目录），
// 只 mock Electron 的 ipcMain 与数据目录解析。列表扫描用的内核是真实现，顺带验序列化格式。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const registered = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
/** 数据目录由用例改写：写/读/删都落在这个临时目录里 */
const state = vi.hoisted(() => ({ dataRoot: "" }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Handler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

vi.mock("@/main/app/paths", () => ({ dataDir: () => state.dataRoot }));

import { IPC } from "@/shared/contracts/ipc";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import { registerPromptsIpc } from "./prompts";

function invoke<T>(channel: string, request?: unknown): Promise<T> {
  const handler = registered.handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler 未注册`);
  return handler({}, request) as Promise<T>;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-prompts-"));
  state.dataRoot = root;
  registered.handlers.clear();
  registerPromptsIpc();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("prompts write/read/remove", () => {
  it("写入落盘为 <名称>.md：描述进 frontmatter，正文跟在后面", async () => {
    const saved = await invoke<PromptTemplateInfo>(IPC.prompts.write, {
      name: "Translate Me",
      description: "翻译 $1",
      content: "把下面这段翻译成 $1：\n\n$ARGUMENTS",
    });

    // 名称被规范成小写短横线；返回的是内核重新解析出来的那一行
    expect(saved).toMatchObject({
      name: "translate-me",
      description: "翻译 $1",
      source: "user",
    });
    const raw = await readFile(path.join(root, "prompts", "translate-me.md"), "utf8");
    expect(raw).toBe('---\ndescription: "翻译 $1"\n---\n\n把下面这段翻译成 $1：\n\n$ARGUMENTS\n');
  });

  it("重命名：写新文件并删掉旧文件", async () => {
    await invoke(IPC.prompts.write, { name: "old", description: "", content: "正文" });
    await invoke(IPC.prompts.write, {
      originalName: "old",
      name: "new",
      description: "",
      content: "正文",
    });

    await expect(readFile(path.join(root, "prompts", "old.md"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(root, "prompts", "new.md"), "utf8")).toBe("正文\n");
  });

  it("名称为空或正文为空时拒绝写入", async () => {
    await expect(
      invoke(IPC.prompts.write, { name: "   ", description: "", content: "正文" }),
    ).rejects.toThrow("非法的魔法提示名");
    await expect(
      invoke(IPC.prompts.write, { name: "ok", description: "", content: "   " }),
    ).rejects.toThrow("正文不能为空");
  });

  it("删除不存在的模板给出明确错误", async () => {
    await expect(invoke(IPC.prompts.remove, { name: "missing" })).rejects.toThrow("魔法提示不存在");
  });

  it("删除成功后再列列表就看不到它", async () => {
    await invoke(IPC.prompts.write, { name: "temp", description: "", content: "正文" });
    const before = await invoke<PromptTemplateInfo[]>(IPC.prompts.list);
    expect(before.map((item) => item.name)).toEqual(["temp"]);

    await invoke(IPC.prompts.remove, { name: "temp" });

    const after = await invoke<PromptTemplateInfo[]>(IPC.prompts.list);
    expect(after).toEqual([]);
  });

  it("列表只认目录直接子级的 .md：随手丢的其它文件不进列表", async () => {
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts", "note.txt"), "x");

    const list = await invoke<PromptTemplateInfo[]>(IPC.prompts.list);
    expect(list).toEqual([]);
  });
});
