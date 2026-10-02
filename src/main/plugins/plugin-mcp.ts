import { createHash } from "node:crypto";
import {
  isValidMcpServerId,
  MCP_NAME_SEPARATOR,
  type McpServerConfig,
} from "@/shared/contracts/mcp";
import type { PluginPackage, PluginPermission } from "@/shared/contracts/plugin";

export interface PluginMcpServer {
  config: McpServerConfig;

  pluginId: string;

  memberName: string;
}

export interface PluginMcpIssue {
  pluginId: string;
  memberName: string;
  message: string;
}

export interface PluginMcpResult {
  servers: PluginMcpServer[];
  issues: PluginMcpIssue[];
}

const MAX_SERVER_ID = 40;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+/, "");
}

export function pluginServerId(pluginId: string, memberName: string): string {
  const full = `p_${slug(pluginId)}_${slug(memberName)}`.replace(/_+/g, "_");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([pluginId, memberName]))
    .digest("hex")
    .slice(0, 12);
  return `${full.slice(0, MAX_SERVER_ID - fingerprint.length - 1).replace(/_+$/, "")}_${fingerprint}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export function buildPluginMcpServers(
  manifest: PluginPackage,
  raw: Record<string, unknown>,
): PluginMcpResult {
  const servers: PluginMcpServer[] = [];
  const issues: PluginMcpIssue[] = [];
  const granted = new Set<PluginPermission>(manifest.permissions);

  for (const [memberName, value] of Object.entries(raw)) {
    const fail = (message: string): void => {
      issues.push({ pluginId: manifest.id, memberName, message });
    };

    if (!isRecord(value)) {
      fail("必须是一个对象");
      continue;
    }

    const url = typeof value.url === "string" ? value.url.trim() : "";
    const command = typeof value.command === "string" ? value.command.trim() : "";

    if (url === "" && command === "") {
      fail("必须给出 command（本地）或 url（远端）之一");
      continue;
    }
    if (url !== "" && command !== "") {
      fail("不能同时给出 command 与 url");
      continue;
    }

    const remote = url !== "";
    const needed: PluginPermission = remote ? "mcp.server.remote" : "mcp.server.local";
    if (!granted.has(needed)) {
      fail(`提供了 ${remote ? "远端" : "本地"} server 却没有申请 "${needed}" 权限`);
      continue;
    }

    const id = pluginServerId(manifest.id, memberName);
    if (!isValidMcpServerId(id)) {
      fail(`生成的 server id 不合法：${id}`);
      continue;
    }
    if (id.includes(MCP_NAME_SEPARATOR)) {
      fail(`生成的 server id 含 ${MCP_NAME_SEPARATOR}：${id}`);
      continue;
    }

    servers.push({
      pluginId: manifest.id,
      memberName,
      config: {
        id,
        name: `${memberName}（${manifest.name}）`,
        enabled: true,
        transport: remote ? "http" : "stdio",
        command,
        args: Array.isArray(value.args)
          ? value.args.filter((entry): entry is string => typeof entry === "string")
          : [],
        env: stringRecord(value.env),
        cwd: typeof value.cwd === "string" ? value.cwd : "",
        url,
        headers: stringRecord(value.headers),
        createdAt: 0,
      },
    });
  }

  return { servers, issues };
}
