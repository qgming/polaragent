// MCP 工具适配：把已发现的 MCP tools 直接注册为 pi-agent 工具
// src/ai/tools/mcp.ts

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { callMcpTool } from "@/lib/mcp";
import type { McpDiscoveredTool, McpToolConfig } from "@/lib/mcp";
import { text, type ToolContext } from "./tool-context";

export function buildMcpTools(
  _ctx: ToolContext,
  config: McpToolConfig,
): AgentTool<any>[] {
  const disabled = new Set(config.disabledToolNames ?? []);
  return (config.discoveredTools ?? [])
    .filter((remoteTool) => !disabled.has(remoteTool.name))
    .map((remoteTool) => buildSingleMcpTool(config, remoteTool));
}

export function mcpToolLabels(config: McpToolConfig): Record<string, string> {
  const disabled = new Set(config.disabledToolNames ?? []);
  return Object.fromEntries(
    (config.discoveredTools ?? [])
      .filter((remoteTool) => !disabled.has(remoteTool.name))
      .map((remoteTool) => [
        mcpPiToolName(config.id, remoteTool.name),
        remoteTool.title || remoteTool.name,
      ]),
  );
}

function buildSingleMcpTool(
  config: McpToolConfig,
  remoteTool: McpDiscoveredTool,
): AgentTool<any> {
  const parameters = normalizeInputSchema(remoteTool.inputSchema);
  const piToolName = mcpPiToolName(config.id, remoteTool.name);

  return {
    name: piToolName,
    label: remoteTool.title || remoteTool.name,
    description:
      remoteTool.description ||
      `调用 MCP server「${config.name || config.id}」的 ${remoteTool.name} 工具。`,
    parameters,
    execute: async (_id: string, params: unknown) => {
      const argumentsObject =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};

      // 在调用远端 MCP server 前校验输入参数（会就地做 string/number 自动转换）
      const validationError = validateMcpInput(
        remoteTool.inputSchema,
        argumentsObject,
      );
      if (validationError) {
        return {
          content: text(`参数校验失败: ${validationError}。请检查参数后重试。`),
          details: {
            serverId: config.id,
            remoteToolName: remoteTool.name,
            validationError,
          },
        };
      }

      const result = await callMcpTool({
        server: config.server,
        toolName: remoteTool.name,
        arguments: argumentsObject,
      });

      const resultText = formatMcpResult(result);
      return {
        content: text(resultText),
        details: {
          serverId: config.id,
          remoteToolName: remoteTool.name,
          result,
        },
      };
    },
  };
}

/**
 * 轻量级 JSON Schema 校验器，用于 MCP 工具输入参数。
 * 支持 required、type、enum、string 长度、number 范围等常见约束。
 * 会对 string↔number 做自动类型转换，并直接修改传入的 params。
 * @returns 校验失败时返回错误信息字符串，通过则返回 null
 */
function validateMcpInput(
  schema: Record<string, any> | undefined,
  params: Record<string, any>,
): string | null {
  if (!schema || typeof schema !== "object" || !schema.properties) {
    return null; // 无 schema 时跳过校验
  }

  const errors: string[] = [];

  // 检查必填字段
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (params[key] === undefined || params[key] === null) {
        errors.push(`缺少必填参数: ${key}`);
      }
    }
  }

  // 检查各属性约束
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let value = params[key];
    if (value === undefined) continue;

    const prop = propSchema as Record<string, any>;

    // 类型检查与自动转换
    if (prop.type) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (prop.type !== actualType) {
        if (
          prop.type === "number" &&
          typeof value === "string" &&
          !isNaN(Number(value)) &&
          value.trim() !== ""
        ) {
          value = Number(value);
          params[key] = value;
        } else if (prop.type === "string" && typeof value === "number") {
          value = String(value);
          params[key] = value;
        } else {
          errors.push(`参数 ${key} 类型错误: 期望 ${prop.type}，实际 ${actualType}`);
        }
      }
    }

    // 枚举值检查
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      errors.push(`参数 ${key} 值不在允许范围内: ${JSON.stringify(prop.enum)}`);
    }

    // 字符串约束
    if (prop.type === "string" && typeof value === "string") {
      if (prop.minLength && value.length < prop.minLength) {
        errors.push(`参数 ${key} 长度不足最小值 ${prop.minLength}`);
      }
      if (prop.maxLength && value.length > prop.maxLength) {
        errors.push(`参数 ${key} 长度超过最大值 ${prop.maxLength}`);
      }
    }

    // 数值约束
    if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors.push(`参数 ${key} 小于最小值 ${prop.minimum}`);
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors.push(`参数 ${key} 超过最大值 ${prop.maximum}`);
      }
      if (prop.type === "integer" && !Number.isInteger(value)) {
        errors.push(`参数 ${key} 必须是整数`);
      }
    }
  }

  return errors.length > 0 ? errors.join("; ") : null;
}

function mcpPiToolName(serverId: string, remoteToolName: string): string {
  return `mcp_${safeToolPart(serverId)}_${safeToolPart(remoteToolName)}`;
}

function safeToolPart(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || "tool";
}

function normalizeInputSchema(schema?: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, required: [] };
  }
  return {
    type: "object",
    properties:
      schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {},
    required: Array.isArray(schema.required) ? schema.required : [],
    ...schema,
  };
}

function formatMcpResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const record = result as {
    content?: unknown;
    structuredContent?: unknown;
  };
  const blocks = Array.isArray(record.content) ? record.content : [];
  const textBlocks = blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .filter(Boolean);

  if (textBlocks.length > 0) {
    return textBlocks.join("\n");
  }
  if (record.structuredContent) {
    return JSON.stringify(record.structuredContent, null, 2);
  }
  return JSON.stringify(result, null, 2);
}
