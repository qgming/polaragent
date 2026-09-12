// MCP（Model Context Protocol）契约：server 配置、连接状态、工具清单与命名约定。
//
// 命名约定（对齐 dsh 的 mcp-client）：外部工具以 `mcp__<serverId>__<toolName>` 暴露给模型。
// 限定名同时是权限门的依据 —— 按 server 批量授权靠 `mcp__<serverId>__*` 前缀规则，
// 所以 serverId 必须落在 [a-z0-9_-] 内且不含双下划线，否则解析不出 server 与工具的边界。
//
// 这里是纯类型 + 纯函数，主进程与渲染进程共用；任何 I/O 都放在 src/main/mcp 下。

/** 限定名前缀 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 限定名里的分隔符（前缀之后第一个双下划线就是 server 与工具的分界） */
export const MCP_NAME_SEPARATOR = "__";

/** serverId 允许的字符集：字母数字加 `_` / `-`，不以分隔符开头；双下划线在 isValidMcpServerId 里单独排除 */
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** 传输方式：stdio = 本地子进程；http = 远端 streamable-http 端点 */
export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio：可执行文件（Windows 下 shell 解析，npx / uvx 可直接写） */
  command: string;
  /** stdio：命令行参数，逐项传递 */
  args: string[];
  /** stdio：追加到子进程环境变量上（同名覆盖）；值含密钥，明文落盘 */
  env: Record<string, string>;
  /** stdio：子进程工作目录，空串表示继承主进程 */
  cwd: string;
  /** http：MCP 端点 URL */
  url: string;
  /** http：请求头（可放 Authorization）；值含密钥，明文落盘 */
  headers: Record<string, string>;
  createdAt: number;
}

/** 连接状态：idle = 未连接（关闭或尚未启动）；connecting / ready / error 是连接过程的三态 */
export type McpConnectionStatus = "idle" | "connecting" | "ready" | "error";

export interface McpToolInfo {
  /** server 内部的原始工具名 */
  name: string;
  /** 暴露给模型的限定名 mcp__<serverId>__<toolName> */
  qualifiedName: string;
  description: string;
  /** server 声明的只读提示（annotations.readOnlyHint）；缺省表示未声明 */
  readOnly?: boolean;
}

export interface McpServerState {
  status: McpConnectionStatus;
  /** 失败原因（status === "error" 时有值） */
  error?: string;
  /** 握手返回的 server 名称与协议版本 */
  serverName?: string;
  protocolVersion?: string;
  tools: McpToolInfo[];
  /** 最近一次连接成功的时间戳 */
  connectedAt?: number;
}

/** 设置面板要的一行：配置 + 运行时状态（配置来自 settings，状态来自连接管理器） */
export interface McpServerView {
  config: McpServerConfig;
  state: McpServerState;
}

/** 试连结果：不回抛异常，失败时给人类可读原因（对齐 services:fetch-models 的判别联合） */
export type McpProbeResult =
  | { ok: true; serverName: string; protocolVersion: string; tools: McpToolInfo[] }
  | { ok: false; reason: string };

/**
 * serverId 是否合法：字符集之外还必须**不含双下划线**。
 *
 * parseMcpToolName 只按第一个 `__` 切分，所以 `my__server` 这种 id 会让
 * 「限定名里的 server 边界」与「权限规则 mcp__<id>__* 的边界」对不上：
 * 工具能跑，但批量授权会写成另一台 server 的前缀。这里直接判非法（归一化时丢弃该条配置）。
 */
export function isValidMcpServerId(id: string): boolean {
  return SERVER_ID_PATTERN.test(id) && !id.includes(MCP_NAME_SEPARATOR);
}

/** 生成一个新的 serverId：`mcp-` + 8 位随机十六进制，天然满足字符集约束 */
export function createMcpServerId(): string {
  return `mcp-${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** server 内的工具名 → 暴露给模型的限定名 */
export function qualifyMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}${MCP_NAME_SEPARATOR}${toolName}`;
}

/** 限定名是否属于 MCP（权限门与 UI 用它区分外部工具与内置工具） */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * 限定名 → { serverId, toolName }；不是 MCP 工具名或格式非法时返回 null。
 *
 * 只按**第一个**分隔符切分：工具名自身可以带双下划线（例如 `git__log`），
 * serverId 不允许带，所以边界唯一。
 */
export function parseMcpToolName(
  qualifiedName: string,
): { serverId: string; toolName: string } | null {
  if (!isMcpToolName(qualifiedName)) return null;
  const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
  const index = rest.indexOf(MCP_NAME_SEPARATOR);
  if (index <= 0) return null;
  const serverId = rest.slice(0, index);
  const toolName = rest.slice(index + MCP_NAME_SEPARATOR.length);
  if (toolName === "") return null;
  return { serverId, toolName };
}

/**
 * 按 server 批量授权的规则名（尾随 `*` 表示前缀匹配，见 permissions.ts 的 matchesPermissionRule）。
 *
 * 「始终允许」在 MCP 工具上写的是这条规则，而不是单个工具名：MCP 工具名由 server 决定、
 * 数量不可预知，逐工具放行等于每次调用都要点一次审批卡。
 */
export function mcpServerRuleName(serverId: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}${MCP_NAME_SEPARATOR}*`;
}

/** 展示用的服务器标题：没起名字时回落到 id */
export function mcpServerLabel(config: Pick<McpServerConfig, "id" | "name">): string {
  const name = config.name.trim();
  return name === "" ? config.id : name;
}
