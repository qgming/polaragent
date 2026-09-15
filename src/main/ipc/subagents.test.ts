/**
 * 子智能体 IPC 通道的测试：定义目录（list / write / remove / reveal）与运行记录转发（runs / stop）。
 *
 * 钉住三件事：
 * - `enabled` 由设置现算（总开关 + 禁用名单）：已禁用的定义也要出现在列表里，否则面板没法重新启用；
 * - 内置定义没有磁盘文件：写入 / 删除按名字拦下，reveal 找不到文件时返回 { ok: false } 而不是抛错；
 * - runs / stop 只做转发：父会话 id 与 delegationId 原样交给 subagent-runner。
 *
 * 目录解析走真实实现（dataDir 指向每个用例自己的临时目录），只有设置、exec env 与 runner 被 mock ——
 * 本测试不碰真实用户数据目录，也不启动任何子智能体。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SUBAGENTS, subagentFilePath } from "@/main/pisdk/subagent-catalog";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { Settings } from "@/shared/contracts/settings";
import type {
  SubagentCatalog,
  SubagentInfo,
  SubagentRun,
  SubagentWriteRequest,
} from "@/shared/contracts/subagent";
import { registerSubagentsIpc } from "./subagents";

type IpcListener = (event: unknown, request?: unknown) => unknown;

// vi.mock 工厂先于 import 执行，用 hoisted 容器接住 handler 与可注入的替身
const registered = vi.hoisted(() => ({ handlers: new Map<string, IpcListener>() }));
const paths = vi.hoisted(() => ({ data: "" }));
const runner = vi.hoisted(() => ({
  reconcileSubagentRuns: vi.fn(),
  stopSubagentRun: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: IpcListener) => {
      registered.handlers.set(channel, listener);
    },
  },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock("@/main/app/paths", () => ({ dataDir: () => paths.data }));
vi.mock("@/main/settings/store", () => ({ loadSettings: vi.fn() }));
// runner 内部维护真实运行注册表：本文件只验证转发，整体替身
vi.mock("@/main/pisdk/subagent-runner", () => ({
  reconcileSubagentRuns: runner.reconcileSubagentRuns,
  stopSubagentRun: runner.stopSubagentRun,
}));

const BASE_SETTINGS: Settings = {
  theme: "system",
  language: "zh-CN",
  density: "comfortable",
  chatFont: "",
  chatFontSize: 14,
  defaultWorkingDir: null,
  services: [],
  defaultModel: null,
  thinkingLevel: "medium",
  permissionMode: "default",
  skillDirs: [],
  disabledSkillNames: [],
  skillsEnabled: true,
  promptTemplateDirs: [],
  subagentsEnabled: true,
  disabledSubagentNames: [],
  mcpServers: [],
};

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...patch };
}

/** 一次运行的最小记录：runs / stop 只转发，不解释内容 */
function runFixture(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s-parent",
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "explorer",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "看 src/retry.ts",
    status: "running",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    maxTurns: 30,
    tools: ["read", "grep", "glob"],
    turns: 1,
    toolCalls: 2,
    ...patch,
  };
}

/** 面板保存定义时的请求体；每个用例只改名字 */
function writeRequest(patch: Partial<SubagentWriteRequest> = {}): SubagentWriteRequest {
  return {
    name: "changelog-writer",
    description: "写 CHANGELOG",
    prompt: "你是子智能体。",
    tools: ["read", "write"],
    model: null,
    thinkingLevel: null,
    maxTurns: null,
    ...patch,
  };
}

/** 取回注册好的 handler（去掉 IPC event 参数） */
function invoke<TResponse>(channel: string, request?: unknown): Promise<TResponse> {
  const handler = registered.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} handler 未注册`);
  return handler({}, request) as Promise<TResponse>;
}

let root = "";
/** 会话工作目录：项目级定义固定落在 `${cwd}/.pi/subagents`，给一个绝不存在的路径 */
let cwd = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-subagent-ipc-"));
  paths.data = root;
  cwd = path.join(root, "project");
  vi.clearAllMocks();
  registered.handlers.clear();
  vi.mocked(loadSettings).mockResolvedValue(settingsWith());
  runner.reconcileSubagentRuns.mockResolvedValue([]);
  runner.stopSubagentRun.mockResolvedValue(undefined);
  registerSubagentsIpc();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("subagents:list", () => {
  it("返回目录形状；enabled 默认由设置算成全开", async () => {
    const catalog = await invoke<SubagentCatalog>(IPC.subagents.list, { workingDir: cwd });

    // 目录解析不抛错、也不产生诊断：首次使用是正常状态
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.subagents.map((info) => info.name)).toEqual(
      BUILTIN_SUBAGENTS.map((def) => def.name),
    );
    expect(catalog.subagents.every((info) => info.enabled)).toBe(true);
    expect(catalog.subagents[0]).toMatchObject({
      name: "explorer",
      source: "builtin",
      model: null,
      thinkingLevel: null,
      maxTurns: 30,
      tools: ["read", "grep", "glob"],
      enabled: true,
    });
    expect(catalog.subagents[0]?.promptPreview).not.toBe("");
    // 定义目录是固定的两处（数据目录 + 会话目录下的 .pi/subagents），读取走普通 fs：
    // 这里不再有 ExecutionEnv 可断言 —— 「数据目录里的用户定义能被列出来」由上面的 filePath 覆盖
  });

  it("subagentsEnabled: false 时全部 enabled=false，但定义照常列出", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settingsWith({ subagentsEnabled: false }));

    const catalog = await invoke<SubagentCatalog>(IPC.subagents.list, { workingDir: cwd });

    expect(catalog.subagents).toHaveLength(BUILTIN_SUBAGENTS.length);
    expect(catalog.subagents.every((info) => info.enabled === false)).toBe(true);
  });

  it("disabledSubagentNames 只影响名单里的那一行", async () => {
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWith({ disabledSubagentNames: ["explorer"] }),
    );

    const catalog = await invoke<SubagentCatalog>(IPC.subagents.list, { workingDir: cwd });

    expect(catalog.subagents.find((info) => info.name === "explorer")?.enabled).toBe(false);
    expect(
      catalog.subagents.filter((info) => info.name !== "explorer").every((info) => info.enabled),
    ).toBe(true);
  });
});

describe("subagents:write / subagents:remove", () => {
  it("内置名不可覆盖：写入被拒绝", async () => {
    await expect(invoke(IPC.subagents.write, writeRequest({ name: "explorer" }))).rejects.toThrow();
  });

  it("非法 slug 被拒绝（规范化后仍不符合命名规则）", async () => {
    await expect(invoke(IPC.subagents.write, writeRequest({ name: "日本語" }))).rejects.toThrow();
  });

  it("普通名字正常落盘：返回的行 source=user，内容可在数据目录读回", async () => {
    const info = await invoke<SubagentInfo>(IPC.subagents.write, writeRequest());

    expect(info).toMatchObject({ name: "changelog-writer", source: "user", enabled: true });
    await expect(readFile(subagentFilePath("changelog-writer"), "utf8")).resolves.toContain(
      "description: 写 CHANGELOG",
    );
  });

  it("内置名不可删除", async () => {
    await expect(invoke(IPC.subagents.remove, { name: "explorer" })).rejects.toThrow();
  });
});

describe("subagents:runs / subagents:stop", () => {
  it("runs 按父会话转交 runner 的对账入口，并把合并后的结果原样返回", async () => {
    const runs = [runFixture()];
    runner.reconcileSubagentRuns.mockResolvedValue(runs);

    const result = await invoke<SubagentRun[]>(IPC.subagents.runs, { sessionId: "s-parent" });

    expect(result).toEqual(runs);
    expect(runner.reconcileSubagentRuns).toHaveBeenCalledWith("s-parent");
  });

  it("stop 带上父会话与 delegationId 转交 runner", async () => {
    const stopped = runFixture({ status: "aborted", endedAt: 2_000 });
    runner.stopSubagentRun.mockResolvedValue(stopped);

    const result = await invoke<SubagentRun>(IPC.subagents.stop, {
      sessionId: "s-parent",
      delegationId: "d-1",
    });

    expect(result).toEqual(stopped);
    expect(runner.stopSubagentRun).toHaveBeenCalledWith("s-parent", "d-1");
  });

  it("stop 遇到不在本进程运行中的记录（例如已有的 interrupted 行）：返回 undefined 而不是抛错", async () => {
    runner.stopSubagentRun.mockResolvedValue(undefined);

    const result = await invoke<SubagentRun | undefined>(IPC.subagents.stop, {
      sessionId: "s-parent",
      delegationId: "d-interrupted",
    });

    expect(result).toBeUndefined();
    expect(runner.stopSubagentRun).toHaveBeenCalledWith("s-parent", "d-interrupted");
  });
});

describe("subagents:reveal", () => {
  it("文件不存在时不打开文件夹，返回 { ok: false } 而不是抛错", async () => {
    const result = await invoke<{ ok: boolean }>(IPC.subagents.reveal, { name: "ghost" });

    expect(result).toEqual({ ok: false });
    expect(vi.mocked(shell.showItemInFolder)).not.toHaveBeenCalled();
  });

  it("文件存在时打开所在文件夹并返回 { ok: true }", async () => {
    await mkdir(path.join(root, "subagents"), { recursive: true });
    await writeFile(subagentFilePath("saved"), "---\ndescription: d\n---\n正文\n", "utf8");

    const result = await invoke<{ ok: boolean }>(IPC.subagents.reveal, { name: "saved" });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(shell.showItemInFolder)).toHaveBeenCalledWith(subagentFilePath("saved"));
  });
});
