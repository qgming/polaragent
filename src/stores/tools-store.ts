// 工具全局开关 Store
// src/stores/tools-store.ts
//
// 工具页的统一开关：工具是全局的，关闭某工具后，所有 Agent 在构建上下文时都会
// 彻底移除该工具，不再传给 AI。开关状态持久化到本地。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  allMcpRemoteToolNames,
  cloneMcpDisabledToolNames,
  cloneMcpDiscoveredTools,
  cloneMcpServer,
  deleteInstalledMcpConfig,
  detectMcpTool,
  discoverMcpToolOrThrow,
  fetchBuiltinMcpConfigs,
  listInstalledMcpConfigIds,
  mcpServerKey,
  normalizeMcpToolForSignature,
  readInstalledMcpConfig,
  uniqueMcpToolId,
  writeInstalledMcpConfig,
} from "@/lib/mcp";
import type { McpToolConfig } from "@/lib/mcp";
import { pMap, REMOTE_CONCURRENCY, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";

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
  checkingMcpIds: string[];
  // 展开的工具分组 key 列表（UI 状态，不持久化）
  expandedGroups: string[];

  // 启用/禁用某工具
  toggleBuiltinTool: (id: string, enabled: boolean) => void;
  // 启用/禁用某个 MCP server（内置 MCP 与已安装 MCP 共用，id 带 mcp: 命名空间）
  toggleMcpServer: (id: string, enabled: boolean) => void;
  // 切换分组展开/收起状态
  toggleGroupExpand: (groupKey: string) => void;
  // 启用/禁用整个工具分组
  toggleGroup: (groupKey: string, enabled: boolean, toolIds: string[]) => void;
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
  // 批量新增自定义 MCP 工具
  addCustomTools: (tools: McpToolConfig[]) => Promise<void>;
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
  // 手动检测某个 MCP server 是否可用（内置 / 已安装通用）
  checkMcpTool: (id: string) => Promise<void>;
  // 删除已安装 MCP 工具
  removeCustomTool: (id: string) => void;
}

function toolsRuntimeSignature(state: Pick<
  ToolsState,
  "disabledTools" | "builtinMcpTools" | "customTools"
>): string {
  return JSON.stringify({
    disabledTools: normalizeDisabledToolKeys(state.disabledTools),
    builtinMcpTools: [...state.builtinMcpTools]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(normalizeMcpToolForSignature),
    customTools: [...state.customTools]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(normalizeMcpToolForSignature),
  });
}

function builtinToolKey(id: string): string {
  return `builtin:${id}`;
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
      checkingMcpIds: [],
      expandedGroups: [], // 默认全部收起

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

      toggleGroupExpand: (groupKey) => {
        set((state) => ({
          expandedGroups: state.expandedGroups.includes(groupKey)
            ? state.expandedGroups.filter((key) => key !== groupKey)
            : [...state.expandedGroups, groupKey],
        }));
      },

      toggleGroup: (_groupKey, enabled, toolIds) => {
        set((state) => {
          const nextDisabledTools = [...state.disabledTools];
          toolIds.forEach((id) => {
            const key = builtinToolKey(id);
            if (enabled) {
              const index = nextDisabledTools.indexOf(key);
              if (index >= 0) nextDisabledTools.splice(index, 1);
            } else {
              if (!nextDisabledTools.includes(key)) {
                nextDisabledTools.push(key);
              }
            }
          });
          return withRuntimeSignature(state, {
            disabledTools: normalizeDisabledToolKeys(nextDisabledTools),
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
            ? allMcpRemoteToolNames(target)
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
          void writeInstalledMcpConfig(updated.id, updated).catch((error) => {
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
          const ids = await listInstalledMcpConfigIds();
          const loaded = await pMap(
            ids,
            (id) => readInstalledMcpConfig<McpToolConfig>(id),
            { concurrency: LOCAL_IO_CONCURRENCY },
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
        const discovered = await discoverMcpToolOrThrow(tool);
        const existingIds = new Set(get().customTools.map((item) => item.id));
        const id = uniqueMcpToolId(discovered.id || discovered.name, existingIds);
        const installed: McpToolConfig = {
          ...discovered,
          id,
          type: "mcp",
          origin: "custom",
          server: cloneMcpServer(discovered.server),
          discoveredTools: cloneMcpDiscoveredTools(discovered),
          disabledToolNames: cloneMcpDisabledToolNames(discovered),
        };
        await writeInstalledMcpConfig(id, installed);
        set((state) => withRuntimeSignature(state, {
          customTools: [...state.customTools, installed],
        }));
      },

      addCustomTools: async (tools) => {
        if (tools.length === 0) return;
        const existingIds = new Set(get().customTools.map((item) => item.id));
        const installedTools: McpToolConfig[] = [];

        for (const tool of tools) {
          const discovered = await discoverMcpToolOrThrow(tool);
          const id = uniqueMcpToolId(discovered.id || discovered.name, existingIds);
          existingIds.add(id);
          const installed: McpToolConfig = {
            ...discovered,
            id,
            type: "mcp",
            origin: "custom",
            server: cloneMcpServer(discovered.server),
            discoveredTools: cloneMcpDiscoveredTools(discovered),
            disabledToolNames: cloneMcpDisabledToolNames(discovered),
          };
          await writeInstalledMcpConfig(id, installed);
          installedTools.push(installed);
        }

        set((state) => withRuntimeSignature(state, {
          customTools: [...state.customTools, ...installedTools],
        }));
      },

      updateCustomTool: async (oldId, tool) => {
        const discovered = await discoverMcpToolOrThrow(tool);
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
          server: cloneMcpServer(discovered.server),
          discoveredTools: cloneMcpDiscoveredTools(discovered),
          disabledToolNames,
        };
        await writeInstalledMcpConfig(updated.id, updated);
        if (oldId !== updated.id) {
          await deleteInstalledMcpConfig(oldId);
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
            server: cloneMcpServer(builtinTarget.server),
            discoveredTools: cloneMcpDiscoveredTools(builtinTarget),
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
          server: cloneMcpServer(target.server),
          discoveredTools: cloneMcpDiscoveredTools(target),
          disabledToolNames: Array.from(disabled).sort(),
        };

        await writeInstalledMcpConfig(updated.id, updated);
        set((state) => withRuntimeSignature(state, {
          customTools: state.customTools.map((tool) =>
            tool.id === serverId ? updated : tool,
          ),
        }));
      },

      refreshInstalledMcpTools: async () => {
        const tools = get().customTools;
        if (tools.length === 0) return;

        const refreshed = await pMap(
          tools,
          async (tool) => {
            try {
              const discovered = await detectMcpTool(tool);
              if (discovered.installCheck?.status !== "installed") return discovered;
              const refreshedTool = {
                ...discovered,
                type: "mcp" as const,
                server: cloneMcpServer(discovered.server),
                discoveredTools: cloneMcpDiscoveredTools(discovered),
                disabledToolNames: cloneMcpDisabledToolNames(discovered),
              };
              await writeInstalledMcpConfig(refreshedTool.id, refreshedTool);
              return refreshedTool;
            } catch (error) {
              console.error(`刷新 MCP 工具失败: ${tool.name}`, error);
              return tool;
            }
          },
          { concurrency: REMOTE_CONCURRENCY },
        );

        set((state) => withRuntimeSignature(state, { customTools: refreshed }));
      },

      refreshBuiltinMcpTools: async () => {
        const tools = get().builtinMcpTools;
        if (tools.length === 0) return;

        const refreshed = await pMap(
          tools,
          async (tool) => {
            try {
              const discovered = await detectMcpTool(tool);
              const disabledToolNames = get().builtinMcpDisabledToolNames[tool.id]
                ?? cloneMcpDisabledToolNames(discovered);
              return {
                ...discovered,
                type: "mcp" as const,
                origin: "builtin" as const,
                server: cloneMcpServer(discovered.server),
                discoveredTools: cloneMcpDiscoveredTools(discovered),
                disabledToolNames,
              };
            } catch (error) {
              console.error(`刷新内置 MCP 工具失败: ${tool.name}`, error);
              return tool;
            }
          },
          { concurrency: REMOTE_CONCURRENCY },
        );

        set((state) => withRuntimeSignature(state, { builtinMcpTools: refreshed }));
      },

      checkMcpTool: async (id) => {
        const target = [...get().builtinMcpTools, ...get().customTools].find(
          (tool) => tool.id === id,
        );
        if (!target) return;

        set((state) => ({
          checkingMcpIds: Array.from(new Set([...state.checkingMcpIds, id])),
          builtinMcpTools: state.builtinMcpTools.map((tool) =>
            tool.id === id
              ? { ...tool, installCheck: { ...tool.installCheck, status: "checking" } }
              : tool,
          ),
          customTools: state.customTools.map((tool) =>
            tool.id === id
              ? { ...tool, installCheck: { ...tool.installCheck, status: "checking" } }
              : tool,
          ),
        }));

        const detected = await detectMcpTool(target);
        const updated: McpToolConfig = {
          ...detected,
          server: cloneMcpServer(detected.server),
          discoveredTools: cloneMcpDiscoveredTools(detected),
          disabledToolNames: cloneMcpDisabledToolNames(detected),
        };

        if (target.origin !== "builtin") {
          await writeInstalledMcpConfig(updated.id, updated).catch((error) => {
            console.error(`写入 MCP 检测结果失败: ${updated.name}`, error);
          });
        }

        set((state) => withRuntimeSignature(state, {
          checkingMcpIds: state.checkingMcpIds.filter((item) => item !== id),
          builtinMcpTools: state.builtinMcpTools.map((tool) =>
            tool.id === id ? { ...updated, origin: "builtin" as const } : tool,
          ),
          customTools: state.customTools.map((tool) =>
            tool.id === id ? updated : tool,
          ),
        }));
      },

      removeCustomTool: (id) => {
        set((state) => withRuntimeSignature(state, {
          customTools: state.customTools.filter((item) => item.id !== id),
          disabledTools: state.disabledTools.filter(
            (item) => item !== id && item !== mcpServerKey(id),
          ),
        }));
        void deleteInstalledMcpConfig(id);
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
