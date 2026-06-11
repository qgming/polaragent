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
import { listSkillsTool, readSkillFileTool, readSkillTool } from "./skills";
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
import { searchWebTool } from "./web-search";
import { readWebPageTool } from "./web-fetch";
import { editImageTool, generateImageTool, imageEditAvailable } from "./image-generation";
import { speechRecognitionTool, speechSynthesisTool } from "./audio";
import { runBashTool } from "./bash";
import { buildMcpTools, mcpToolLabels } from "./mcp";
import { searchKnowledgeTool } from "./knowledge";

export type { ToolContext } from "./tool-context";

// 真实工具登记项：每个条目对应一个可执行工具，id 与工具的 name 一致。
// 这是唯一事实来源——展示目录(BUILTIN_TOOLS)与运行时装配都从这里派生，二者不会漂移。
interface ToolEntry {
  id: string;
  name: string;
  description: string;
  factory: (ctx: ToolContext) => AgentTool<any>;
  isAvailable?: (ctx: ToolContext) => boolean;
  group?: string; // 所属分组 key（不填表示不分组，直接平铺显示）
}

// 工具分组配置（用于工具页面的分组展示）
export const TOOL_GROUPS: Record<string, { name: string; description: string; order: number }> = {
  task: { name: "任务管理", description: "维护待办清单,跟踪任务进展", order: 1 },
  network: { name: "网络工具", description: "搜索互联网信息,读取网页内容", order: 2 },
  file: { name: "文件操作", description: "读写编辑文件,管理目录结构", order: 3 },
  knowledge: { name: "知识库", description: "检索知识库文档,获取相关内容", order: 4 },
  image: { name: "图片工具", description: "生成图片并保存为会话产物", order: 5 },
  audio: { name: "音频工具", description: "语音识别与语音合成", order: 6 },
  dev: { name: "开发工具", description: "执行 shell 命令,运行项目脚本", order: 7 },
  skill: { name: "技能", description: "查看并读取当前助手可用技能", order: 8 },
  interaction: { name: "用户交互", description: "向用户请求输入,收集选择反馈", order: 9 },
  team: { name: "团队协作", description: "控制协作流程,发起和参与投票", order: 10 },
};

// 全部真实内置工具。默认可用于普通会话；带 isAvailable 的工具只在对应上下文里装配。
const TOOL_REGISTRY: ToolEntry[] = [
  {
    id: "update_todos",
    name: "更新待办",
    description: "维护当前任务的待办清单，用完整列表同步任务进度。",
    factory: updateTodosTool,
    group: "task",
  },
  {
    id: "ask_user",
    name: "询问用户",
    description: "向用户请求文本输入、单选或多选，并等待用户在模态窗中提交。",
    factory: askUserTool,
    group: "interaction",
  },
  {
    id: "list_skills",
    name: "列出技能",
    description: "列出当前助手或团队上下文可用的技能名称与适用场景。",
    factory: listSkillsTool,
    group: "skill",
  },
  {
    id: "read_skill",
    name: "读取技能",
    description: "读取当前上下文中某个可用技能的完整 SKILL.md 说明和目录树。",
    factory: readSkillTool,
    group: "skill",
  },
  {
    id: "read_skill_file",
    name: "读取技能文件",
    description: "读取可用技能目录内 references、examples 等子文件。",
    factory: readSkillFileTool,
    group: "skill",
  },
  {
    id: "control_team_flow",
    name: "控制团队流程",
    description: "团队协作中控制继续、交接、结束或标记阻塞，可附带给下一位成员的私聊提示。",
    factory: controlTeamFlowTool,
    isAvailable: (ctx) => Boolean(ctx.teamFlow),
    group: "team",
  },
  {
    id: "request_team_vote",
    name: "发起团队投票",
    description: "团队协作中发起投票决策，收集团队成员对方案、方向或是否结束的选择。",
    factory: requestTeamVoteTool,
    isAvailable: (ctx) => Boolean(ctx.teamVote),
    group: "team",
  },
  {
    id: "cast_team_vote",
    name: "提交团队投票",
    description: "团队投票收集阶段提交当前成员的投票选择。",
    factory: castTeamVoteTool,
    isAvailable: (ctx) => Boolean(ctx.teamCastVote),
    group: "team",
  },
  {
    id: "read_file",
    name: "读取文件",
    description: "读取工作目录下指定文件的文本内容。",
    factory: readFileTool,
    group: "file",
  },
  {
    id: "write_file",
    name: "写入文件",
    description: "把内容写入工作目录下的文件（覆盖写入），写入后出现在产物面板。",
    factory: writeFileTool,
    group: "file",
  },
  {
    id: "edit_file",
    name: "编辑文件",
    description: "对文件做精确替换编辑（oldString→newString），适合定点修改而非整篇重写。",
    factory: editFileTool,
    group: "file",
  },
  {
    id: "create_directory",
    name: "新建目录",
    description: "在工作目录下创建目录，会自动创建必要的父目录。",
    factory: createDirectoryTool,
    group: "file",
  },
  {
    id: "delete_file",
    name: "删除路径",
    description: "删除工作目录下的文件或目录；目录会递归删除其内部文件。",
    factory: deleteFileTool,
    group: "file",
  },
  {
    id: "list_directory",
    name: "列出目录",
    description: "列出工作目录或指定目录下的文件与子目录。",
    factory: listDirectoryTool,
    group: "file",
  },
  {
    id: "web_search",
    name: "网络搜索",
    description: "在互联网上检索信息，返回若干条结果（标题、链接、摘要）。",
    factory: searchWebTool,
    group: "network",
  },
  {
    id: "web_fetch",
    name: "网页读取",
    description: "读取网页正文并提取主要文本，支持按标题或锚点分段提取与链接、表格抽取。",
    factory: readWebPageTool,
    group: "network",
  },
  {
    id: "image_generation",
    name: "生成图片",
    description: "调用图片生成模型，根据提示词生成图片并保存到工作目录。",
    factory: generateImageTool,
    group: "image",
  },
  {
    id: "image_edit",
    name: "编辑图片",
    description: "调用图片编辑模型，基于本地源图和可选蒙版编辑图片并保存结果。",
    factory: editImageTool,
    // 仅当所选图片接口标准支持编辑时才注册（openai-chat 不支持）。
    isAvailable: () => imageEditAvailable(),
    group: "image",
  },
  {
    id: "speech_recognition",
    name: "语音识别",
    description: "将音频文件转写为文字，支持常见音频格式（mp3/wav/m4a/webm/ogg 等）。",
    factory: speechRecognitionTool,
    group: "audio",
  },
  {
    id: "speech_synthesis",
    name: "语音合成",
    description: "将文字合成为语音并保存到工作目录，登记为产物。",
    factory: speechSynthesisTool,
    group: "audio",
  },
  {
    id: "run_bash",
    name: "运行命令",
    description: "在会话工作目录下执行 shell 命令，返回标准输出与错误输出。高危命令会被拦截。",
    factory: runBashTool,
    group: "dev",
  },
  {
    id: "search_knowledge",
    name: "检索知识库",
    description: "在已启用的知识库中检索相关文档片段，获取项目文档、技术规范等上下文信息。",
    factory: searchKnowledgeTool,
    group: "knowledge",
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
  group?: string; // 所属分组 key
}

// 内置工具目录（工具页展示用）——逐个列出真实可执行的工具
export const BUILTIN_TOOLS: ToolMeta[] = TOOL_REGISTRY.map(
  ({ id, name, description, group }) => ({ id, name, description, group }),
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
