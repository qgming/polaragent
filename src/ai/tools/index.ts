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
import { createOfficeDocumentTool } from "./office";
import { runBashTool } from "./bash";
import { buildMcpTools, mcpToolLabels } from "./mcp";
import { searchKnowledgeTool } from "./knowledge";
import { forgetMemoryTool, rememberMemoryTool, searchMemoryTool } from "./memory";
import { systemInfoTool } from "./system-info";
import {
  windowsSnapshotTool,
  windowsClickTool,
  windowsTypeTool,
  windowsKeypressTool,
  windowsFindTool,
  windowsScrollTool,
  windowsDoubleClickTool,
  windowsMoveTool,
  windowsListWindowsTool,
  windowsAccessibilityTreeTool,
  windowsElementInfoTool,
  windowsFocusTool,
  windowsInvokeTool,
  windowsSetValueTool,
  windowsActivateWindowTool,
  windowsWaitTool,
  windowsDragTool,
  windowsBatchTool,
} from "./computeruse";
import {
  browserTabsTool,
  browserOpenTool,
  browserCloseTool,
  browserScanTool,
  browserSnapshotTool,
  browserClickTool,
  browserFillTool,
  browserExecuteTool,
  browserScreenshotTool,
  browserNetworkTool,
  browserConsoleTool,
} from "./browseruse";

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
  system: { name: "系统信息", description: "获取时间、位置、硬件、网络等系统信息", order: 0 },
  computeruse: { name: "Computer Use", description: "控制 Windows 桌面应用程序", order: 1 },
  browseruse: { name: "Browser Use", description: "控制 Chrome 浏览器,操作网页", order: 2 },
  task: { name: "任务管理", description: "维护待办清单,跟踪任务进展", order: 3 },
  network: { name: "网络工具", description: "搜索互联网信息,读取网页内容", order: 4 },
  file: { name: "文件操作", description: "读写编辑文件,管理目录结构", order: 5 },
  office: { name: "办公创作", description: "生成 Word、PPT、PDF 办公文件", order: 6 },
  knowledge: { name: "知识库", description: "检索知识库文档,获取相关内容", order: 7 },
  memory: { name: "长期记忆", description: "检索、写入和遗忘用户偏好与项目上下文", order: 8 },
  image: { name: "图片工具", description: "生成图片并保存为会话产物", order: 9 },
  audio: { name: "音频工具", description: "语音识别与语音合成", order: 10 },
  dev: { name: "开发工具", description: "执行 shell 命令,运行项目脚本", order: 11 },
  skill: { name: "技能", description: "查看并读取当前助手可用技能", order: 12 },
  interaction: { name: "用户交互", description: "向用户请求输入,收集选择反馈", order: 13 },
  team: { name: "团队协作", description: "控制协作流程,发起和参与投票", order: 14 },
};

// 全部真实内置工具。默认可用于普通会话；带 isAvailable 的工具只在对应上下文里装配。
const TOOL_REGISTRY: ToolEntry[] = [
  {
    id: "system_info",
    name: "系统信息",
    description: "获取电脑的系统信息，包括当前时间、时区、位置、硬件配置、网络状态等。",
    factory: systemInfoTool,
    group: "system",
  },
  {
    id: "windows_snapshot",
    name: "Windows 截图",
    description: "获取 Windows 活动窗口或桌面的截图和 UI 树结构，包含可点击元素的位置和信息。",
    factory: windowsSnapshotTool,
    group: "computeruse",
  },
  {
    id: "windows_accessibility_tree",
    name: "获取 UI 树",
    description: "获取 UI Automation 树结构（无截图），比 snapshot 更快，适合频繁读取 UI 状态。",
    factory: windowsAccessibilityTreeTool,
    group: "computeruse",
  },
  {
    id: "windows_list_windows",
    name: "列出窗口",
    description: "列出所有顶级桌面窗口，返回窗口标题、进程ID、窗口句柄等信息。",
    factory: windowsListWindowsTool,
    group: "computeruse",
  },
  {
    id: "windows_find",
    name: "Windows 查找",
    description: "在 Windows 应用中查找 UI 元素。",
    factory: windowsFindTool,
    group: "computeruse",
  },
  {
    id: "windows_element_info",
    name: "元素信息",
    description: "获取指定 UI 元素或坐标处元素的详细信息。",
    factory: windowsElementInfoTool,
    group: "computeruse",
  },
  {
    id: "windows_focus",
    name: "聚焦元素",
    description: "使用 UI Automation 将焦点移动到指定元素。",
    factory: windowsFocusTool,
    group: "computeruse",
  },
  {
    id: "windows_invoke",
    name: "调用元素",
    description: "优先使用 UIA Pattern 操作元素，必要时回退点击。",
    factory: windowsInvokeTool,
    group: "computeruse",
  },
  {
    id: "windows_set_value",
    name: "设置元素值",
    description: "优先使用 UIA ValuePattern 设置输入框值。",
    factory: windowsSetValueTool,
    group: "computeruse",
  },
  {
    id: "windows_activate_window",
    name: "激活窗口",
    description: "按标题、进程 ID 或 HWND 激活目标窗口。",
    factory: windowsActivateWindowTool,
    group: "computeruse",
  },
  {
    id: "windows_click",
    name: "Windows 点击",
    description: "在 Windows 应用中点击指定坐标或 UI 元素。",
    factory: windowsClickTool,
    group: "computeruse",
  },
  {
    id: "windows_double_click",
    name: "Windows 双击",
    description: "在 Windows 应用中双击指定坐标或 UI 元素，用于打开文件、展开树节点等。",
    factory: windowsDoubleClickTool,
    group: "computeruse",
  },
  {
    id: "windows_move",
    name: "移动鼠标",
    description: "移动鼠标指针到指定坐标或 UI 元素中心。",
    factory: windowsMoveTool,
    group: "computeruse",
  },
  {
    id: "windows_drag",
    name: "Windows 拖拽",
    description: "按路径执行鼠标拖拽。",
    factory: windowsDragTool,
    group: "computeruse",
  },
  {
    id: "windows_scroll",
    name: "Windows 滚动",
    description: "在 Windows 应用中滚动内容。",
    factory: windowsScrollTool,
    group: "computeruse",
  },
  {
    id: "windows_type",
    name: "Windows 输入",
    description: "在 Windows 应用的当前焦点控件中输入文本。",
    factory: windowsTypeTool,
    group: "computeruse",
  },
  {
    id: "windows_keypress",
    name: "Windows 按键",
    description: "在 Windows 应用中按下键盘按键或组合键。",
    factory: windowsKeypressTool,
    group: "computeruse",
  },
  {
    id: "windows_wait",
    name: "Windows 等待",
    description: "等待窗口动画、加载或焦点变化完成。",
    factory: windowsWaitTool,
    group: "computeruse",
  },
  {
    id: "windows_batch",
    name: "Windows 批量操作",
    description: "按顺序执行多个 Computer Use 动作，减少多轮调用开销。",
    factory: windowsBatchTool,
    group: "computeruse",
  },
  {
    id: "browser_tabs",
    name: "列出标签页",
    description: "列出当前所有浏览器标签页。",
    factory: browserTabsTool,
    group: "browseruse",
  },
  {
    id: "browser_open",
    name: "打开标签页",
    description: "打开新的浏览器标签页。",
    factory: browserOpenTool,
    group: "browseruse",
  },
  {
    id: "browser_close",
    name: "关闭标签页",
    description: "关闭指定的浏览器标签页。",
    factory: browserCloseTool,
    group: "browseruse",
  },
  {
    id: "browser_scan",
    name: "扫描页面",
    description: "扫描页面内容,获取文本或结构化信息。",
    factory: browserScanTool,
    group: "browseruse",
  },
  {
    id: "browser_snapshot",
    name: "页面快照",
    description: "获取页面可操作元素快照,生成 @e 引用用于后续点击或填充。",
    factory: browserSnapshotTool,
    group: "browseruse",
  },
  {
    id: "browser_click",
    name: "点击元素",
    description: "点击页面元素,支持 CSS 选择器或 @e 引用。",
    factory: browserClickTool,
    group: "browseruse",
  },
  {
    id: "browser_fill",
    name: "填充表单",
    description: "填充表单输入框。",
    factory: browserFillTool,
    group: "browseruse",
  },
  {
    id: "browser_execute",
    name: "执行脚本",
    description: "在页面中执行 JavaScript 代码。",
    factory: browserExecuteTool,
    group: "browseruse",
  },
  {
    id: "browser_screenshot",
    name: "浏览器截图",
    description: "截取页面截图。",
    factory: browserScreenshotTool,
    group: "browseruse",
  },
  {
    id: "browser_network",
    name: "网络监控",
    description: "监控网络请求。",
    factory: browserNetworkTool,
    group: "browseruse",
  },
  {
    id: "browser_console",
    name: "控制台日志",
    description: "监听并读取页面 console 与异常日志。",
    factory: browserConsoleTool,
    group: "browseruse",
  },
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
    id: "create_office_document",
    name: "创建办公文档",
    description: "生成 Word、PPT 或 PDF 文件，保存后出现在产物面板并可用独立预览窗口打开。",
    factory: createOfficeDocumentTool,
    group: "office",
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
  {
    id: "search_memory",
    name: "检索记忆",
    description: "检索长期记忆，获取用户偏好、身份画像、历史纠正和项目上下文。",
    factory: searchMemoryTool,
    group: "memory",
  },
  {
    id: "remember_memory",
    name: "写入记忆",
    description: "在用户明确要求记住或需要修正长期偏好/项目约定时写入记忆。",
    factory: rememberMemoryTool,
    group: "memory",
  },
  {
    id: "forget_memory",
    name: "忘记记忆",
    description: "关闭或删除长期记忆，适合用户要求忘记某个偏好、画像或项目约定时使用。",
    factory: forgetMemoryTool,
    group: "memory",
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
