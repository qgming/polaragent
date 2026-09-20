// 权限规则 IPC 的写入校验。
//
// **这个文件存在的理由**：一条「无 pattern 的内置工具规则」等于把该工具**永久全局放行**
//（`matchesPermissionRule` 对空 pattern 直接返回 true）。写入方是渲染层，
// 而渲染层的输入又可能来自模型生成的内容 —— 让这条路能写宽规则，审批门的价值
// 就只取决于渲染层有多可信。
//
// MCP 的 `mcp__<server>__*` 前缀规则是**刻意允许**的例外：它天然没有 pattern，
// 但只覆盖第三方 server 的工具，不覆盖内置工具。
//
// 规则库是模块级单例（首次调用即固定 baseDir，且内存里带缓存），所以每个用例都
// `vi.resetModules()` 后重新 import —— 否则前一个用例写下的规则会留在后一个用例里。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const registered = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
let root: string;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Handler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

vi.mock("@/main/app/paths", () => ({ dataDir: () => root }));

import { IPC } from "@/shared/contracts/ipc";
import type { PermissionRuleView } from "@/shared/contracts/permissions";

function invoke<T>(channel: string, request?: unknown): Promise<T> {
  const handler = registered.handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler 未注册`);
  return handler({}, request) as Promise<T>;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-perm-ipc-"));
});

beforeEach(async () => {
  // 单例 + 内存缓存都在模块作用域里：重置模块注册表才能拿到干净的规则库；
  // 落盘的那份也要删掉，否则上一个用例写的规则会被重新读进来
  vi.resetModules();
  registered.handlers.clear();
  await rm(path.join(root, "permission-rules.json"), { force: true });
  const { registerPermissionsIpc } = await import("./permissions");
  registerPermissionsIpc();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("permissions addRule 的写入校验", () => {
  it("拒绝无 pattern 的内置工具规则（那等于永久全局放行）", async () => {
    await expect(
      invoke(IPC.permissions.addRule, { toolName: "bash", createdAt: Date.now() }),
    ).rejects.toThrow(/无匹配模式/);
    await expect(
      invoke(IPC.permissions.addRule, { toolName: "write", createdAt: Date.now() }),
    ).rejects.toThrow(/无匹配模式/);
    // 空串与纯空白同样算「没有模式」
    await expect(
      invoke(IPC.permissions.addRule, { toolName: "bash", pattern: "  ", createdAt: Date.now() }),
    ).rejects.toThrow(/无匹配模式/);

    expect(await invoke<PermissionRuleView[]>(IPC.permissions.listRules)).toEqual([]);
  });

  it("缺少工具名时拒绝", async () => {
    await expect(invoke(IPC.permissions.addRule, { pattern: "git" })).rejects.toThrow(/工具名/);
  });

  /**
   * 前缀规则只能用于 MCP。
   *
   * 实测确认过的漏洞：原来只判 `endsWith("*")`，而前缀匹配是 `startsWith` ——
   * `bash*` 于是放行了 bash 与 bash_background（含 `rm -rf /`），
   * `w*` 放行了 write（可写 `~/.ssh/authorized_keys`）。
   */
  it("拒绝通配内置工具的前缀规则（bash* / w* / b* 都不行）", async () => {
    for (const toolName of ["bash*", "bash_background*", "w*", "b*", "write*", "*"]) {
      await expect(
        invoke(IPC.permissions.addRule, { toolName, createdAt: Date.now() }),
      ).rejects.toThrow(/MCP 形态的前缀规则/);
    }
    expect(await invoke<PermissionRuleView[]>(IPC.permissions.listRules)).toEqual([]);
  });

  it("MCP 形态的前缀规则仍然允许（那是它的必需形态）", async () => {
    await invoke(IPC.permissions.addRule, { toolName: "mcp__mcp-a__*", createdAt: Date.now() });
    const rules = await invoke<PermissionRuleView[]>(IPC.permissions.listRules);
    expect(rules.map((rule) => rule.toolName)).toEqual(["mcp__mcp-a__*"]);
  });

  it("带 pattern 的规则正常写入", async () => {
    await invoke(IPC.permissions.addRule, {
      toolName: "bash",
      pattern: "git",
      createdAt: Date.now(),
    });
    const rules = await invoke<PermissionRuleView[]>(IPC.permissions.listRules);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ toolName: "bash", pattern: "git" });
  });
});
