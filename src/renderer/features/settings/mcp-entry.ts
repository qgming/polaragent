// MCP 服务器草稿：面板编辑态 ↔ 落盘配置之间的纯转换。
//
// 单独成文件的理由与 model-entry.ts 相同：这些解析（每行一个参数、KEY=VALUE、KEY: VALUE）
// 是纯逻辑，值得直接单测，不该埋在 700 行的面板组件里。
//
// 面板用多行文本编辑 args / env / headers：这三者都是「一组字符串对」，
// 用单个输入框比一堆动态行更省事，也不会在增删行时丢焦点。

import {
  createMcpServerId,
  isValidMcpServerId,
  type McpServerConfig,
  type McpTransport,
} from "@/shared/contracts/mcp";

export interface McpServerDraft {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  /** 每行一个参数（含空格的行按整行处理，不拆分） */
  argsText: string;
  /** 每行 KEY=VALUE */
  envText: string;
  cwd: string;
  url: string;
  /** 每行 KEY: VALUE */
  headersText: string;
}

/** 新建草稿：id 立刻生成，保证「试连」与保存用的是同一个 id */
export function createMcpDraft(): McpServerDraft {
  return {
    id: createMcpServerId(),
    name: "",
    enabled: true,
    transport: "stdio",
    command: "",
    argsText: "",
    envText: "",
    cwd: "",
    url: "",
    headersText: "",
  };
}

export function toMcpDraft(config: McpServerConfig): McpServerDraft {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
    command: config.command,
    argsText: config.args.join("\n"),
    envText: formatKeyValueLines(config.env, "="),
    cwd: config.cwd,
    url: config.url,
    headersText: formatKeyValueLines(config.headers, ":"),
  };
}

/** 空行与注释行（# 开头）跳过：配置里常临时注释掉一项 */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** 每行一个参数；行首行尾空白被去掉，行内空格原样保留（有的参数本身含空格） */
export function parseArgLines(text: string): string[] {
  return contentLines(text);
}

/** `KEY=VALUE`（环境变量）；值里可以有 `=`，只按**第一个** `=` 切分 */
export function parseEnvLines(text: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of contentLines(text)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key === "") continue;
    record[key] = line.slice(index + 1).trim();
  }
  return record;
}

/** `KEY: VALUE`（请求头）；值里可以有 `:`，只按**第一个** `:` 切分 */
export function parseHeaderLines(text: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of contentLines(text)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key === "") continue;
    record[key] = line.slice(index + 1).trim();
  }
  return record;
}

/** 键值表 → 多行文本（与 parse 互为逆运算，保证「打开编辑器再保存」不改数据） */
export function formatKeyValueLines(record: Record<string, string>, separator: "=" | ":"): string {
  return Object.entries(record)
    .map(([key, value]) => (separator === "=" ? `${key}=${value}` : `${key}: ${value}`))
    .join("\n");
}

/**
 * 草稿 → 落盘配置。
 *
 * 只写当前 transport 用到的字段，另一侧的字段清空：切换传输方式是一个明确的动作，
 * 留着上一次的命令行/URL 只会让「到底是哪个配置在生效」变得说不清。
 */
export function toMcpConfig(draft: McpServerDraft, createdAt: number): McpServerConfig {
  const stdio = draft.transport === "stdio";
  return {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    command: stdio ? draft.command.trim() : "",
    args: stdio ? parseArgLines(draft.argsText) : [],
    env: stdio ? parseEnvLines(draft.envText) : {},
    cwd: stdio ? draft.cwd.trim() : "",
    url: stdio ? "" : draft.url.trim(),
    headers: stdio ? {} : parseHeaderLines(draft.headersText),
    createdAt,
  };
}

/** 能否保存 / 试连：id 合法，且当前传输方式的关键字段填了 */
export function isMcpDraftReady(draft: McpServerDraft): boolean {
  if (!isValidMcpServerId(draft.id)) return false;
  return draft.transport === "stdio" ? draft.command.trim() !== "" : draft.url.trim() !== "";
}
