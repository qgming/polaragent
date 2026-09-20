// MCP 工具包装：把一个外部 server 上的工具变成宿主工具，交给 AgentHarness 使用。
//
// 命名约定见 shared/contracts/mcp.ts：mcp__<serverId>__<toolName>。
// 三个必须自己做的收尾（内核只对 bash 做这些）：
// 1. 输入 schema 归一 —— MCP 给的是 JSON Schema，直接当 typebox 用（typebox 就是 JSON Schema）；
// 2. 输出截断 —— 自建工具没有内核级截断，外部 server 一次吐 200KB JSON 会直接灌爆上下文；
// 3. 失败文本化 —— 一律回 "Error: ..." 文本而不是抛异常，模型能读到原因并自行纠偏。

import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import type { McpCallResult } from "@/main/mcp/client";
import { qualifyMcpToolName } from "@/shared/contracts/mcp";

/** 单条结果的文本上限：行数与字符数任一超标都截断 */
const MAX_RESULT_LINES = 2000;
const MAX_RESULT_CHARS = 50_000;

/** 一个待包装的远程工具 */
export interface McpToolDefinition {
  serverId: string;
  /** server 的展示名，写进 description 让模型知道工具来自哪里 */
  serverName: string;
  /** server 内部的原始工具名（不含限定前缀） */
  toolName: string;
  description: string;
  /** server 给的 JSON Schema，原样透传 */
  inputSchema: unknown;
  /** annotations.readOnlyHint */
  readOnly?: boolean;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 输入 schema 归一。
 *
 * MCP 的 inputSchema 标准形态是 `{ type: "object", properties: {...} }`；
 * 少数 server 省略 type 只给 properties，这里补上。既不是对象也不是记录时给一个空对象
 * schema：宁可能力退化（模型只能靠 description 猜参数），也不要让一个坏 schema 变成工具加载失败。
 */
export function normalizeInputSchema(schema: unknown): TSchema {
  if (isRecord(schema)) {
    if (schema.type === "object") return schema as unknown as TSchema;
    if (schema.properties !== undefined && schema.type === undefined) {
      return { type: "object", ...schema } as unknown as TSchema;
    }
  }
  return { type: "object", properties: {}, additionalProperties: true } as unknown as TSchema;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/** 结果截断：保留**开头**（工具结果通常把摘要放前面），并明确告知模型被截断了 */
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

/** 工具说明：来自哪个 server + server 自己的描述 + 使用须知 */
export function buildMcpToolDescription(tool: McpToolDefinition): string {
  const remote = tool.description.trim();
  return [
    `由外部 MCP server「${tool.serverName}」提供的工具「${tool.toolName}」。`,
    remote === "" ? "该 server 未提供工具说明。" : remote,
    "参数 schema 由该 server 定义，按它给的字段名与类型传参；缺字段会导致调用失败。",
    `输出超长会被截断（最多 ${MAX_RESULT_LINES} 行 / ${MAX_RESULT_CHARS} 字符），需要更多内容时缩小查询范围。`,
    "只依据本工具的真实返回作答，不要编造执行结果。",
  ].join("\n\n");
}

/**
 * 包装成一个宿主工具。
 *
 * `parameters` 用 `Type.Unsafe` 顶掉类型推导：schema 在运行时才由 server 给出，
 * 编译期无法建模；`execute` 因此把 params 收成 unknown 再收窄。
 */
export function createMcpTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
  tool: McpToolDefinition,
  caller: McpToolCaller,
): AgentHarnessTool<TContext> {
  const qualifiedName = qualifyMcpToolName(tool.serverId, tool.toolName);
  const parameters = Type.Unsafe<Record<string, unknown>>(normalizeInputSchema(tool.inputSchema));

  return {
    name: qualifiedName,
    label: qualifiedName,
    description: buildMcpToolDescription(tool),
    parameters,
    async execute(_toolCallId, params): Promise<AgentToolResult<McpToolDetails>> {
      const args = isRecord(params) ? params : {};
      const started = Date.now();
      const details = (isError: boolean, truncated: boolean): McpToolDetails => ({
        qualifiedName,
        serverId: tool.serverId,
        toolName: tool.toolName,
        isError,
        truncated,
        durationMs: Date.now() - started,
      });
      try {
        const result = await caller.callTool(tool.serverId, tool.toolName, args);
        const clipped = truncateForModel(result.text);
        const text = result.isError ? `Error: ${clipped.text}` : clipped.text;
        return {
          content: [{ type: "text", text }],
          details: details(result.isError, clipped.truncated),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: 调用 MCP 工具失败：${message}` }],
          details: details(true, false),
        };
      }
    },
  };
}
