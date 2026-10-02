import type { PluginPermission, PluginPermissionView } from "@/shared/contracts/plugin";

export type PluginRisk = PluginPermissionView["risk"];

const RISK: Record<PluginPermission, PluginRisk> = {
  "ui.panel": "low",
  "ui.window": "low",

  "ui.modal": "low",
  "ui.theme": "low",
  notify: "low",

  storage: "low",

  "skills.contribute": "low",
  "prompts.contribute": "low",

  "subagents.contribute": "medium",

  "commands.register": "high",

  "agent.tool.register": "high",

  "shell.exec": "high",

  "net.fetch": "high",

  "mcp.server.local": "high",

  "mcp.server.remote": "medium",

  "hostHooks.register": "high",
  "clipboard.write": "medium",
};

export function assessPermissionRisk(id: string): PluginRisk {
  return (RISK as Readonly<Record<string, PluginRisk | undefined>>)[id] ?? "high";
}

export function permissionRiskTable(): Readonly<Record<string, PluginRisk>> {
  return RISK;
}
