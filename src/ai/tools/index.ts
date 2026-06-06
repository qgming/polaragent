// 工具注册表 —— 装配 pi-agent 工具
// src/ai/tools/index.ts
//
// 高内聚低耦合：每个工具实现独立成文件，这里把它们登记为「真实工具目录」。
// 工具是全局的：由工具页的开关（tools-store.disabledTools）统一控制，
// 被全局关闭的工具完全不构造、不传给 AI；启用的工具对所有 Agent 可用。
// 部分工具只在特定上下文里装配，例如团队流程、团队投票收集阶段。

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useToolsStore } from "@/stores/tools-store";
import type { ToolContext } from "./tool-context";
import { updateTodosTool } from "./update-todos";
import { askUserTool } from "./ask-user";
import { controlTeamFlowTool } from "./team-control";
import { castTeamVoteTool, requestTeamVoteTool } from "./team-vote";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  createDirectoryTool,
  listDirectoryTool,
} from "./file-operations";
import { searchWebTool, readWebTool } from "./web-search";
import { buildMcpTools, mcpToolLabels } from "./mcp";

export type { ToolContext } from "./tool-context";

// 真实工具登记项：每个条目对应一个可执行工具，id 与工具的 name 一致。
// 这是唯一事实来源——展示目录(BUILTIN_TOOLS)与运行时装配都从这里派生，二者不会漂移。
interface ToolEntry {
  id: string;
  name: string;
  description: string;
  factory: (ctx: ToolContext) => AgentTool<any>;
  isAvailable?: (ctx: ToolContext) => boolean;
}

// 全部真实内置工具。默认可用于普通会话；带 isAvailable 的工具只在对应上下文里装配。
const TOOL_REGISTRY: ToolEntry[] = [
  {
    id: "update_todos",
    name: "更新待办",
    description: "维护当前任务的待办清单，用完整列表同步任务进度。",
    factory: updateTodosTool,
  },
  {
    id: "ask_user",
    name: "询问用户",
    description: "向用户请求文本输入、单选或多选，并等待用户在模态窗中提交。",
    factory: askUserTool,
  },
  {
    id: "control_team_flow",
    name: "控制团队流程",
    description: "团队协作中控制继续、交接、结束或标记阻塞，可附带给下一位成员的私聊提示。",
    factory: controlTeamFlowTool,
    isAvailable: (ctx) => Boolean(ctx.teamFlow),
  },
  {
    id: "request_team_vote",
    name: "发起团队投票",
    description: "团队协作中发起投票决策，收集团队成员对方案、方向或是否结束的选择。",
    factory: requestTeamVoteTool,
    isAvailable: (ctx) => Boolean(ctx.teamVote),
  },
  {
    id: "cast_team_vote",
    name: "提交团队投票",
    description: "团队投票收集阶段提交当前成员的投票选择。",
    factory: castTeamVoteTool,
    isAvailable: (ctx) => Boolean(ctx.teamCastVote),
  },
  {
    id: "read_file",
    name: "读取文件",
    description: "读取工作目录下指定文件的文本内容。",
    factory: readFileTool,
  },
  {
    id: "write_file",
    name: "写入文件",
    description: "把内容写入工作目录下的文件（覆盖写入），写入后出现在产物面板。",
    factory: writeFileTool,
  },
  {
    id: "edit_file",
    name: "编辑文件",
    description: "对文件做精确替换编辑（oldString→newString），适合定点修改而非整篇重写。",
    factory: editFileTool,
  },
  {
    id: "create_directory",
    name: "新建目录",
    description: "在工作目录下创建目录，会自动创建必要的父目录。",
    factory: createDirectoryTool,
  },
  {
    id: "delete_file",
    name: "删除路径",
    description: "删除工作目录下的文件或目录；目录会递归删除其内部文件。",
    factory: deleteFileTool,
  },
  {
    id: "list_directory",
    name: "列出目录",
    description: "列出工作目录或指定目录下的文件与子目录。",
    factory: listDirectoryTool,
  },
  {
    id: "search_web",
    name: "网络搜索",
    description: "通过 SearXNG 检索互联网信息，返回标题、链接与摘要。",
    factory: searchWebTool,
  },
  {
    id: "read_web",
    name: "读取网页",
    description: "读取指定网页的正文内容（转为 Markdown），用于核实与引用。",
    factory: readWebTool,
  },
];

// 工具名 -> 中文展示标签（供监控面板与步骤轨迹复用）
export const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_REGISTRY.map((tool) => [tool.id, tool.name]),
);

export function toolDisplayName(toolName: string): string {
  const { builtinMcpTools, customTools } = useToolsStore.getState();
  const dynamicMcpLabels = Object.assign(
    {},
    ...builtinMcpTools.map((tool) => mcpToolLabels(tool)),
    ...customTools.map((tool) => mcpToolLabels(tool)),
  );
  return TOOL_LABELS[toolName] ?? dynamicMcpLabels[toolName] ?? toolName;
}

// 工具元数据（供工具页面展示）
export interface ToolMeta {
  id: string;
  name: string;
  description: string;
}

// 内置工具目录（工具页展示用）——逐个列出真实可执行的工具
export const BUILTIN_TOOLS: ToolMeta[] = TOOL_REGISTRY.map(
  ({ id, name, description }) => ({ id, name, description }),
);

/**
 * 为某个会话构建工具集。
 * 工具是全局的：内置工具和 MCP 都由工具页开关控制；上下文专用工具只在可用上下文中装配。
 * 被全局关闭的工具完全不构造，不会出现在传给 AI 的工具列表里。
 */
export function buildAgentTools(ctx: ToolContext): AgentTool<any>[] {
  const {
    builtinMcpTools,
    customTools,
    isBuiltinToolEnabled,
    isMcpServerEnabled,
  } = useToolsStore.getState();

  if (ctx.teamCastVote) {
    const castVoteTool = TOOL_REGISTRY.find((tool) => tool.id === "cast_team_vote");
    if (!castVoteTool || !isBuiltinToolEnabled(castVoteTool.id)) return [];
    return [castVoteTool.factory(ctx)];
  }

  const tools: AgentTool<any>[] = [];

  for (const entry of TOOL_REGISTRY) {
    if (!isBuiltinToolEnabled(entry.id)) continue;
    if (entry.isAvailable && !entry.isAvailable(ctx)) continue;
    tools.push(entry.factory(ctx));
  }

  for (const mcpTool of builtinMcpTools) {
    if (!isMcpServerEnabled(mcpTool.id)) continue;
    tools.push(...buildMcpTools(ctx, mcpTool));
  }

  for (const mcpTool of customTools) {
    if (!isMcpServerEnabled(mcpTool.id)) continue;
    tools.push(...buildMcpTools(ctx, mcpTool));
  }

  return tools;
}
