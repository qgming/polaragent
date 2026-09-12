// permissions 单测：风险评估常量表与 always_allow 规则库，全部走临时目录，不发起网络请求。
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessToolRisk,
  createPermissionRuleStore,
  matchesPermissionRule,
  type PermissionRule,
} from "./permissions";

describe("assessToolRisk", () => {
  it("read 低风险，write/edit 高风险", () => {
    expect(assessToolRisk("read", { path: "a.ts" })).toBe("low");
    expect(assessToolRisk("write", { path: "a.ts" })).toBe("high");
    expect(assessToolRisk("edit", { path: "a.ts" })).toBe("high");
  });

  it("bash 按命令黑名单判定", () => {
    expect(assessToolRisk("bash", { command: "ls -la" })).toBe("low");
    expect(assessToolRisk("bash", { command: "git status" })).toBe("low");
    expect(assessToolRisk("bash", { command: "rm -rf /" })).toBe("high");
  });

  it("未知工具默认高风险", () => {
    expect(assessToolRisk("unknown_tool", {})).toBe("high");
    expect(assessToolRisk("bash", {})).toBe("low");
  });

  it("MCP 外部工具一律高风险（名字与行为都由 server 决定）", () => {
    expect(assessToolRisk("mcp__mcp-a__read_file", { path: "a.ts" })).toBe("high");
    expect(assessToolRisk("mcp__mcp-a__anything", {})).toBe("high");
  });
});

describe("matchesPermissionRule", () => {
  const scoped: PermissionRule = { toolName: "bash", pattern: "git", createdAt: 1 };

  it("无 pattern 时该工具全局匹配", () => {
    const global: PermissionRule = { toolName: "read", createdAt: 1 };
    expect(matchesPermissionRule(global, "read", "{}")).toBe(true);
    expect(matchesPermissionRule(global, "write", "{}")).toBe(false);
  });

  it("带 pattern 时按 argsText 包含匹配", () => {
    expect(matchesPermissionRule(scoped, "bash", '{"command":"git status"}')).toBe(true);
    expect(matchesPermissionRule(scoped, "bash", '{"command":"rm -rf /"}')).toBe(false);
    expect(matchesPermissionRule(scoped, "write", '{"path":"git"}')).toBe(false);
  });

  it("以 * 结尾的规则前缀匹配：mcp__<server>__* 覆盖该 server 的全部工具", () => {
    const serverRule: PermissionRule = { toolName: "mcp__mcp-a__*", createdAt: 1 };
    expect(matchesPermissionRule(serverRule, "mcp__mcp-a__read_file", "{}")).toBe(true);
    expect(matchesPermissionRule(serverRule, "mcp__mcp-a__write_file", "{}")).toBe(true);
    // 不能越界到别的 server，也不能匹配内置工具
    expect(matchesPermissionRule(serverRule, "mcp__mcp-b__read_file", "{}")).toBe(false);
    expect(matchesPermissionRule(serverRule, "read", "{}")).toBe(false);
  });

  it("前缀规则同样受 pattern 约束；空前缀（单独的 *）不匹配任何工具", () => {
    const scopedRule: PermissionRule = {
      toolName: "mcp__mcp-a__*",
      pattern: "safe",
      createdAt: 1,
    };
    expect(matchesPermissionRule(scopedRule, "mcp__mcp-a__read", '{"q":"safe"}')).toBe(true);
    expect(matchesPermissionRule(scopedRule, "mcp__mcp-a__read", '{"q":"unsafe"}')).toBe(true);
    expect(matchesPermissionRule(scopedRule, "mcp__mcp-a__read", '{"q":"other"}')).toBe(false);

    const wildcardOnly: PermissionRule = { toolName: "*", createdAt: 1 };
    expect(matchesPermissionRule(wildcardOnly, "read", "{}")).toBe(false);
  });
});

describe("createPermissionRuleStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "oint-rules-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("add 后匹配生效并持久化，重开 store 仍可读到", async () => {
    const store = createPermissionRuleStore(baseDir);
    expect(await store.matches("bash", '{"command":"git status"}')).toBe(false);

    await store.add({ toolName: "bash", pattern: "git", createdAt: 1 });
    expect(await store.matches("bash", '{"command":"git status"}')).toBe(true);
    expect(await store.matches("bash", '{"command":"npm install"}')).toBe(false);

    const reopened = createPermissionRuleStore(baseDir);
    expect(await reopened.list()).toEqual([{ toolName: "bash", pattern: "git", createdAt: 1 }]);
    expect(await reopened.matches("bash", '{"command":"git log"}')).toBe(true);
  });

  it("文件缺失时返回空列表；重复 add 不重复落盘", async () => {
    const store = createPermissionRuleStore(baseDir);
    expect(await store.list()).toEqual([]);

    const rule: PermissionRule = { toolName: "write", createdAt: 1 };
    await store.add(rule);
    await store.add({ ...rule, createdAt: 2 });
    expect(await store.list()).toEqual([rule]);
  });
});
