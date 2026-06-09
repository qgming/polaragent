import type { McpToolConfig } from "./types";

function api() {
  if (!window.polaragent) throw new Error("Electron preload API 未初始化");
  return window.polaragent;
}

export async function fetchBuiltinMcpConfigs(): Promise<McpToolConfig[]> {
  return JSON.parse(await api().config.fetchBuiltinMcpConfigs()) as McpToolConfig[];
}

export const listInstalledMcpConfigIds = (): Promise<string[]> => api().config.listMcp();

export async function readInstalledMcpConfig<T = McpToolConfig>(mcpId: string): Promise<T> {
  return JSON.parse(await api().config.readMcp(mcpId)) as T;
}

export const writeInstalledMcpConfig = (mcpId: string, content: McpToolConfig) =>
  api().config.writeMcp(mcpId, JSON.stringify(content, null, 2));

export const deleteInstalledMcpConfig = (mcpId: string) => api().config.deleteMcp(mcpId);
