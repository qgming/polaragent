// 工具全局开关 Store
// src/stores/tools-store.ts
//
// 工具页的统一开关：工具是全局的，关闭某工具后，所有 Agent 在构建上下文时都会
// 彻底移除该工具，不再传给 AI。开关状态持久化到本地。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  deleteMcpConfig,
  fetchBuiltinMcpConfigs,
  listMcpConfigs,
  mcpListTools,
  readMcpConfig,
  writeMcpConfig,
} from "@/lib/electron/electron-api";
import type { McpServerConfig, McpToolConfig } from "@/types/config";

interface ToolsState {
  // 工具运行时签名。工具目录真实变化时改变，用于让已打开会话下次发送前重建 AgentHarness。
  runtimeSignature: string;
  // 被全局禁用的工具 id 列表（默认空 = 全部启用）
  disabledTools: string[];
  // 内置 MCP 下被禁用的远端工具名，按 server id 存储。
  builtinMcpDisabledToolNames: Record<string, string[]>;
  // 内置 MCP 工具配置（来自 {dataDir}/mcp/builtin，不归入已安装）
  builtinMcpTools: McpToolConfig[];
  // 用户已安装 / 自定义的 MCP 工具配置
  customTools: McpToolConfig[];
  isInstalledLoading: boolean;

  // 启用/禁用某工具
  toggleBuiltinTool: (id: string, enabled: boolean) => void;
  // 启用/禁用某个 MCP server（内置 MCP 与已安装 MCP 共用，id 带 mcp: 命名空间）
  toggleMcpServer: (id: string, enabled: boolean) => void;
  // 该工具是否处于全局启用状态
  isBuiltinToolEnabled: (id: string) => boolean;
  // 该 MCP server 是否处于全局启用状态
  isMcpServerEnabled: (id: string) => boolean;
  // 该 MCP server 下的远端工具是否启用
  isMcpRemoteToolEnabled: (serverId: string, remoteToolName: string) => boolean;
  // 从 {dataDir}/mcp/builtin 加载内置 MCP
  loadBuiltinMcpTools: () => Promise<void>;
  // 从 {dataDir}/mcp 加载已安装 MCP
  loadInstalledMcpTools: () => Promise<void>;
  // 新增自定义 MCP 工具
  addCustomTool: (tool: McpToolConfig) => Promise<void>;
  // 更新 MCP 工具配置
  updateCustomTool: (oldId: string, tool: McpToolConfig) => Promise<void>;
  // 启用/禁用某个 MCP server 下的远端工具
  toggleMcpRemoteTool: (
    serverId: string,
    remoteToolName: string,
    enabled: boolean,
  ) => Promise<void>;
  // 刷新已安装 MCP 的远端工具 schema，供 AI 运行时同步装配
  refreshInstalledMcpTools: () => Promise<void>;
  // 刷新内置 MCP 的远端工具 schema，供 AI 运行时同步装配
  refreshBuiltinMcpTools: () => Promise<void>;
  // 删除已安装 MCP 工具
  removeCustomTool: (id: string) => void;
}

function uniqueToolId(baseId: string, existingIds: Set<string>): string {
  const clean =
    baseId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "mcp-tool";
  let id = clean;
  let suffix = 1;
  while (existingIds.has(id)) {
    id = `${clean}-${suffix++}`;
  }
  return id;
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  return {
    transport: server.transport,
    command: server.command ?? "",
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    url: server.url ?? "",
    headers: { ...(server.headers ?? {}) },
  };
}

async function discoverMcpTools(tool: McpToolConfig): Promise<McpToolConfig> {
  const discoveredTools = await mcpListTools(tool.server);
  if (discoveredTools.length === 0) {
    throw new Error(`MCP server「${tool.name}」没有返回任何可用工具。`);
  }
  return { ...tool, discoveredTools };
}

function cloneDiscoveredTools(tool: McpToolConfig): McpToolConfig["discoveredTools"] {
  return (tool.discoveredTools ?? []).map((item) => ({
    ...item,
    inputSchema: item.inputSchema ? { ...item.inputSchema } : undefined,
  }));
}

function cloneDisabledToolNames(tool: McpToolConfig): string[] | undefined {
  return tool.disabledToolNames ? [...tool.disabledToolNames] : undefined;
}

function sortedRecord(record?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {})
      .filter(([key, value]) => key.trim() !== "" && value.trim() !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeToolForSignature(tool: McpToolConfig) {
  return {
    id: tool.id,
    origin: tool.origin,
    server: {
      transport: tool.server.transport,
      command: tool.server.command ?? "",
      args: [...(tool.server.args ?? [])],
      env: sortedRecord(tool.server.env),
      url: tool.server.url ?? "",
      headers: sortedRecord(tool.server.headers),
    },
    disabledToolNames: [...(tool.disabledToolNames ?? [])].sort(),
    discoveredTools: (tool.discoveredTools ?? [])
      .map((item) => ({
        name: item.name,
        title: item.title ?? "",
        description: item.description ?? "",
        inputSchema: item.inputSchema ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function toolsRuntimeSignature(state: Pick<
  ToolsState,
  "disabledTools" | "builtinMcpTools" | "customTools"
>): string {
  return JSON.stringify({
    disabledTools: normalizeDisabledToolKeys(state.disabledTools),
    builtinMcpTools: [...state.builtinMcpTools]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(normalizeToolForSignature),
    customTools: [...state.customTools]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(normalizeToolForSignature),
  });
}

function builtinToolKey(id: string): string {
  return `builtin:${id}`;
}

function mcpServerKey(id: string): string {
  return `mcp:${id}`;
}

function normalizeDisabledToolKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean))).sort();
}

function isDisabled(keys: string[], key: string): boolean {
  return keys.includes(key);
}

function updateDisabledKey(keys: string[], key: string, enabled: boolean): string[] {
  const set = new Set(normalizeDisabledToolKeys(keys));
  if (enabled) {
    set.delete(key);
  } else {
    set.add(key);
  }
  return Array.from(set).sort();
}

function allRemoteToolNames(tool: McpToolConfig): string[] {
  return (tool.discoveredTools ?? []).map((item) => item.name).sort();
}

function withRuntimeSignature<T extends Partial<ToolsState>>(
  state: ToolsState,
  patch: T,
): T & Pick<ToolsState, "runtimeSignature"> {
  const nextState = { ...state, ...patch };
  return {
    ...patch,
    runtimeSignature: toolsRuntimeSignature(nextState),
  };
}

export const useToolsStore = create<ToolsState>()(
  persist(
    (set, get) => ({
      disabledTools: [],
      runtimeSignature: toolsRuntimeSignature({
        disabledTools: [],
        builtinMcpTools: [],
        customTools: [],
      }),
      builtinMcpDisabledToolNames: {},
      builtinMcpTools: [],
      customTools: [],
      isInstalledLoading: false,

      toggleBuiltinTool: (id, enabled) => {
        set((state) => {
          return withRuntimeSignature(state, {
            disabledTools: updateDisabledKey(
              state.disabledTools,
              builtinToolKey(id),
              enabled,
            ),
          });
        });
      },

      toggleMcpServer: (id, enabled) => {
        const builtinTarget = get().builtinMcpTools.find((tool) => tool.id === id);
        const customTarget = get().customTools.find((tool) => tool.id === id);
        const target = builtinTarget ?? customTarget;
        const nextDisabledToolNames = enabled
          ? []
          : target
            ? allRemoteToolNames(target)
            : undefined;

        set((state) => {
          const patch: Partial<ToolsState> = {
            disabledTools: updateDisabledKey(
              state.disabledTools,
              mcpServerKey(id),
              enabled,
            ),
          };

          if (nextDisabledToolNames && builtinTarget) {
            patch.builtinMcpDisabledToolNames = enabled
              ? Object.fromEntries(
                  Object.entries(state.builtinMcpDisabledToolNames).filter(
                    ([serverId]) => serverId !== id,
                  ),
                )
              : {
                  ...state.builtinMcpDisabledToolNames,
                  [id]: nextDisabledToolNames,
                };
            patch.builtinMcpTools = state.builtinMcpTools.map((tool) =>
              tool.id === id
                ? { ...tool, disabledToolNames: nextDisabledToolNames }
                : tool,
            );
          }

          if (nextDisabledToolNames && customTarget) {
            patch.customTools = state.customTools.map((tool) =>
              tool.id === id
                ? { ...tool, disabledToolNames: nextDisabledToolNames }
                : tool,
            );
          }

          return withRuntimeSignature(state, patch);
        });

        const installed = get().customTools.find((tool) => tool.id === id);
        if (installed && nextDisabledToolNames) {
          const updated = { ...installed, disabledToolNames: nextDisabledToolNames };
          void writeMcpConfig(updated.id, updated).catch((error) => {
            console.error(`写入 MCP 总开关失败: ${updated.name}`, error);
          });
        }
      },

      isBuiltinToolEnabled: (id) =>
        !isDisabled(get().disabledTools, builtinToolKey(id)),

      isMcpServerEnabled: (id) =>
        !isDisabled(get().disabledTools, mcpServerKey(id)),

      isMcpRemoteToolEnabled: (serverId, remoteToolName) => {
        if (!get().isMcpServerEnabled(serverId)) return false;
        const target = [...get().builtinMcpTools, ...get().customTools].find(
          (tool) => tool.id === serverId,
        );
        return !(target?.disabledToolNames ?? []).includes(remoteToolName);
      },

      loadBuiltinMcpTools: async () => {
        try {
          const tools = await fetchBuiltinMcpConfigs();
          const disabledByServer = get().builtinMcpDisabledToolNames;
          set((state) => withRuntimeSignature(state, {
            builtinMcpTools: tools.map((tool) => ({
              ...tool,
              origin: "builtin",
              disabledToolNames: disabledByServer[tool.id] ?? tool.disabledToolNames,
            })),
          }));
        } catch (error) {
          console.error("加载内置 MCP 失败:", error);
          set({ builtinMcpTools: [] });
        }
      },

      loadInstalledMcpTools: async () => {
        set({ isInstalledLoading: true });
        try {
          const ids = await listMcpConfigs();
          const loaded = await Promise.all(
            ids.map((id) => readMcpConfig<McpToolConfig>(id)),
          );
          set((state) => withRuntimeSignature(state, {
            customTools: loaded,
            isInstalledLoading: false,
          }));
        } catch (error) {
          console.error("加载已安装 MCP 失败:", error);
          set({ customTools: [], isInstalledLoading: false });
        }
      },

      addCustomTool: async (tool) => {
        const discovered = await discoverMcpTools(tool);
        const existingIds = new Set(get().customTools.map((item) => item.id));
        const id = uniqueToolId(discovered.id || discovered.name, existingIds);
        const installed: McpToolConfig = {
          ...discovered,
          id,
          type: "mcp",
          origin: "custom",
          server: cloneServer(discovered.server),
          discoveredTools: cloneDiscoveredTools(discovered),
          disabledToolNames: cloneDisabledToolNames(discovered),
        };
        await writeMcpConfig(id, installed);
        set((state) => withRuntimeSignature(state, {
          customTools: [...state.customTools, installed],
        }));
      },

      updateCustomTool: async (oldId, tool) => {
        const discovered = await discoverMcpTools(tool);
        const previous = get().customTools.find((item) => item.id === oldId);
        const discoveredNames = new Set(
          (discovered.discoveredTools ?? []).map((item) => item.name),
        );
        const disabledToolNames = (previous?.disabledToolNames ?? []).filter((name) =>
          discoveredNames.has(name),
        );
        const updated: McpToolConfig = {
          ...discovered,
          type: "mcp",
          server: cloneServer(discovered.server),
          discoveredTools: cloneDiscoveredTools(discovered),
          disabledToolNames,
        };
        await writeMcpConfig(updated.id, updated);
        if (oldId !== updated.id) {
          await deleteMcpConfig(oldId);
        }
        set((state) => withRuntimeSignature(state, {
          customTools: state.customTools.map((item) =>
            item.id === oldId
              ? updated
              : item,
          ),
        }));
      },

      toggleMcpRemoteTool: async (serverId, remoteToolName, enabled) => {
        const builtinTarget = get().builtinMcpTools.find((tool) => tool.id === serverId);
        if (builtinTarget) {
          const disabled = new Set(builtinTarget.disabledToolNames ?? []);
          if (enabled) {
            disabled.delete(remoteToolName);
          } else {
            disabled.add(remoteToolName);
          }
          const updated: McpToolConfig = {
            ...builtinTarget,
            server: cloneServer(builtinTarget.server),
            discoveredTools: cloneDiscoveredTools(builtinTarget),
            disabledToolNames: Array.from(disabled).sort(),
          };
          set((state) => withRuntimeSignature(state, {
            builtinMcpDisabledToolNames: {
              ...state.builtinMcpDisabledToolNames,
              [serverId]: updated.disabledToolNames ?? [],
            },
            builtinMcpTools: state.builtinMcpTools.map((tool) =>
              tool.id === serverId ? updated : tool,
            ),
          }));
          return;
        }

        const target = get().customTools.find((tool) => tool.id === serverId);
        if (!target) return;

        const disabled = new Set(target.disabledToolNames ?? []);
        if (enabled) {
          disabled.delete(remoteToolName);
        } else {
          disabled.add(remoteToolName);
        }

        const updated: McpToolConfig = {
          ...target,
          server: cloneServer(target.server),
          discoveredTools: cloneDiscoveredTools(target),
          disabledToolNames: Array.from(disabled).sort(),
        };

        await writeMcpConfig(updated.id, updated);
        set((state) => withRuntimeSignature(state, {
          customTools: state.customTools.map((tool) =>
            tool.id === serverId ? updated : tool,
          ),
        }));
      },

      refreshInstalledMcpTools: async () => {
        const tools = get().customTools;
        if (tools.length === 0) return;

        const refreshed = await Promise.all(
          tools.map(async (tool) => {
            try {
              const discovered = await discoverMcpTools(tool);
              const refreshedTool = {
                ...discovered,
                type: "mcp" as const,
                server: cloneServer(discovered.server),
                discoveredTools: cloneDiscoveredTools(discovered),
                disabledToolNames: cloneDisabledToolNames(discovered),
              };
              await writeMcpConfig(refreshedTool.id, refreshedTool);
              return refreshedTool;
            } catch (error) {
              console.error(`刷新 MCP 工具失败: ${tool.name}`, error);
              return tool;
            }
          }),
        );

        set((state) => withRuntimeSignature(state, { customTools: refreshed }));
      },

      refreshBuiltinMcpTools: async () => {
        const tools = get().builtinMcpTools;
        if (tools.length === 0) return;

        const refreshed = await Promise.all(
          tools.map(async (tool) => {
            try {
              const discovered = await discoverMcpTools(tool);
              const disabledToolNames = get().builtinMcpDisabledToolNames[tool.id]
                ?? cloneDisabledToolNames(discovered);
              return {
                ...discovered,
                type: "mcp" as const,
                origin: "builtin" as const,
                server: cloneServer(discovered.server),
                discoveredTools: cloneDiscoveredTools(discovered),
                disabledToolNames,
              };
            } catch (error) {
              console.error(`刷新内置 MCP 工具失败: ${tool.name}`, error);
              return tool;
            }
          }),
        );

        set((state) => withRuntimeSignature(state, { builtinMcpTools: refreshed }));
      },

      removeCustomTool: (id) => {
        set((state) => withRuntimeSignature(state, {
          customTools: state.customTools.filter((item) => item.id !== id),
          disabledTools: state.disabledTools.filter(
            (item) => item !== id && item !== mcpServerKey(id),
          ),
        }));
        void deleteMcpConfig(id);
      },
    }),
    {
      name: "polaragent-tools",
      partialize: (state) => ({
        disabledTools: state.disabledTools,
        builtinMcpDisabledToolNames: state.builtinMcpDisabledToolNames,
      }),
    },
  ),
);
