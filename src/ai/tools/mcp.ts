// MCP 工具适配：把已发现的 MCP tools 直接注册为 pi-agent 工具
// src/ai/tools/mcp.ts

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { mcpCallTool } from "@/lib/electron/electron-api";
import type { McpDiscoveredTool, McpToolConfig } from "@/types/config";
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
      const result = await mcpCallTool({
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
