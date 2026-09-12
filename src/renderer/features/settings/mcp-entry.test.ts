import { describe, expect, it } from "vitest";
import { isValidMcpServerId, type McpServerConfig } from "@/shared/contracts/mcp";
import {
  createMcpDraft,
  formatKeyValueLines,
  isMcpDraftReady,
  parseArgLines,
  parseEnvLines,
  parseHeaderLines,
  toMcpConfig,
  toMcpDraft,
} from "./mcp-entry";

const CONFIG: McpServerConfig = {
  id: "mcp-abc12345",
  name: "本地文件",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work dir"],
  env: { GITHUB_TOKEN: "t0ken", BASE: "https://x/y" },
  cwd: "C:\\work dir",
  url: "",
  headers: {},
  createdAt: 7,
};

describe("parseEnvLines / parseHeaderLines", () => {
  it("环境变量按第一个 = 切分，跳过空行与注释", () => {
    expect(parseEnvLines("A=1\n\n# 注释\nB=x=y\nC=")).toEqual({ A: "1", B: "x=y", C: "" });
  });

  it("没有 = 的行被忽略", () => {
    expect(parseEnvLines("JUST_A_KEY")).toEqual({});
  });

  it("请求头按第一个 : 切分，值里的冒号保留", () => {
    expect(parseHeaderLines("Authorization: Bearer abc\nX-Trace: a:b")).toEqual({
      Authorization: "Bearer abc",
      "X-Trace": "a:b",
    });
  });

  it("formatKeyValueLines 与 parse 互为逆运算", () => {
    const record = { TOKEN: "t", URL: "https://x/y" };
    expect(parseEnvLines(formatKeyValueLines(record, "="))).toEqual(record);
    expect(parseHeaderLines(formatKeyValueLines(record, ":"))).toEqual(record);
  });
});

describe("parseArgLines", () => {
  it("每行一个参数，去掉行首尾空白，忽略注释行", () => {
    expect(parseArgLines("  -y \n@scope/pkg\n# 注释\n\nC:\\work dir")).toEqual([
      "-y",
      "@scope/pkg",
      "C:\\work dir",
    ]);
  });
});

describe("createMcpDraft", () => {
  it("生成的 id 立即可用（符合限定名约束）", () => {
    const draft = createMcpDraft();
    expect(isValidMcpServerId(draft.id)).toBe(true);
    expect(draft.transport).toBe("stdio");
    expect(isMcpDraftReady(draft)).toBe(false);
  });
});

describe("toMcpConfig", () => {
  it("草稿与配置可来回转换（不改数据、不改创建时间）", () => {
    expect(toMcpConfig(toMcpDraft(CONFIG), CONFIG.createdAt)).toEqual(CONFIG);
  });

  it("stdio 只写 stdio 字段，http 只写 http 字段", () => {
    const draft = {
      ...toMcpDraft(CONFIG),
      transport: "http" as const,
      url: " https://example.com/mcp ",
      headersText: "Authorization: Bearer t",
    };
    const config = toMcpConfig(draft, 1);
    expect(config.transport).toBe("http");
    expect(config.url).toBe("https://example.com/mcp");
    expect(config.headers).toEqual({ Authorization: "Bearer t" });
    // 另一侧的字段清空：避免「到底是哪个配置在生效」说不清
    expect(config.command).toBe("");
    expect(config.args).toEqual([]);
    expect(config.env).toEqual({});
    expect(config.cwd).toBe("");
  });
});

describe("isMcpDraftReady", () => {
  it("stdio 要有命令，http 要有地址", () => {
    const draft = createMcpDraft();
    expect(isMcpDraftReady({ ...draft, command: "npx" })).toBe(true);
    expect(isMcpDraftReady({ ...draft, transport: "http" })).toBe(false);
    expect(isMcpDraftReady({ ...draft, transport: "http", url: "https://x" })).toBe(true);
  });

  it("id 非法（含双下划线）时不允许保存", () => {
    expect(isMcpDraftReady({ ...createMcpDraft(), id: "mcp__bad", command: "npx" })).toBe(false);
  });
});
