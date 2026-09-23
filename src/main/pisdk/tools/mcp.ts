// MCP 结果处理的公共件：截断规则、调用通道与 details 形状。
//
// 远端工具现在**只经由聚合工具**暴露（`mcp__<serverId>__call`，见 tools/mcp-gateway.ts），
// 所以这里不再有「一个远端工具 = 一个宿主工具」的包装器 —— 那套代码随暴露策略一起删掉了。
// 留下的是聚合工具与 `mcp_tools` 都要用的三样东西。

import type { McpCallResult } from "@/main/mcp/client";

/** 单条结果的文本上限：行数与字符数任一超标都截断 */
const MAX_RESULT_LINES = 2000;
const MAX_RESULT_CHARS = 50_000;

/** 调用通道：由 mcp-servers.ts 提供（它才知道哪个 server 对应哪条连接） */
export interface McpToolCaller {
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
}

/** details：给日志与 UI 回填用，字段都是原始类型（要能过 IPC 的结构化克隆） */
export interface McpToolDetails {
  qualifiedName: string;
  serverId: string;
  toolName: string;
  /** server 自己标记的失败 */
  isError: boolean;
  /** 输出是否被截断 */
  truncated: boolean;
  durationMs: number;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * 结果截断：保留**开头**（工具结果通常把摘要放前面），并明确告知模型被截断了。
 *
 * 自建工具没有内核级截断，外部 server 一次吐 200KB JSON 会直接灌爆上下文 ——
 * 这是 MCP 这条路上最容易出的事故，所以截断是必需的而不是可选的。
 */
export function truncateForModel(text: string): TruncatedText {
  const lines = text.split("\n");
  let truncated = false;
  let kept = lines;
  if (lines.length > MAX_RESULT_LINES) {
    kept = lines.slice(0, MAX_RESULT_LINES);
    truncated = true;
  }
  let joined = kept.join("\n");
  if (joined.length > MAX_RESULT_CHARS) {
    joined = joined.slice(0, MAX_RESULT_CHARS);
    truncated = true;
  }
  if (!truncated) return { text, truncated: false };
  return {
    text: `${joined}\n\n[结果过长已截断：仅保留前 ${MAX_RESULT_LINES} 行 / ${MAX_RESULT_CHARS} 字符，请缩小范围或分次调用]`,
    truncated: true,
  };
}
