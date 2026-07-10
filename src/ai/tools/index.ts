// 工具注册表 —— 装配 pi-agent 工具
// src/ai/tools/index.ts
//
// 高内聚低耦合：每个工具实现独立成文件，这里把它们登记为「真实工具目录」。
// 工具是全局的：由工具页的开关（tools-store.disabledTools）统一控制，
// 被全局关闭的工具完全不构造、不传给 AI；启用的工具对所有 Agent 可用。
// 部分工具只在特定上下文里装配，例如后台任务或项目会话。

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useToolsStore } from "@/stores/tools-store";
import { useConfigStore } from "@/stores/config-store";
import type { ToolContext } from "./tool-context";

// ===== 系统信息 =====
import { systemInfoTool } from "./system-info";

// ===== Computer Use (Windows 桌面控制) =====
import {
  windowsSnapshotTool,
  windowsAccessibilityTreeTool,
  windowsListWindowsTool,
  windowsFindTool,
  windowsElementInfoTool,
  windowsFocusTool,
  windowsInvokeTool,
  windowsSetValueTool,
  windowsActivateWindowTool,
  windowsClickTool,
  windowsDoubleClickTool,
  windowsMoveTool,
  windowsDragTool,
  windowsScrollTool,
  windowsTypeTool,
  windowsKeypressTool,
  windowsWaitTool,
  windowsBatchTool,
} from "./computeruse";

// ===== Browser Use (浏览器控制) =====
import {
  browserTabsTool,
  browserOpenTool,
  browserCloseTool,
  browserScanTool,
  browserSnapshotTool,
  browserClickTool,
  browserFillTool,
  browserDragTool,
  browserUploadTool,
  browserExecuteTool,
  browserScreenshotTool,
  browserNetworkTool,
  browserConsoleTool,
} from "./browseruse";

// ===== 任务管理 =====
import { updateTodosTool } from "./update-todos";
import { delegateTaskTool } from "./delegate-task";

// ===== 网络工具 =====
import { searchWebTool } from "./web-search";
import { readWebPageTool } from "./web-fetch";

// ===== 文件操作 =====
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  createDirectoryTool,
  listDirectoryTool,
  moveFileTool,
  copyFileTool,
  searchFilesTool,
} from "./file-operations";

// ===== 办公创作 =====
import { createOfficeDocumentTool } from "./office";

// ===== 知识库 =====
import { searchKnowledgeTool } from "./knowledge";

// ===== 项目会话 =====
import {
  listProjectConversationsTool,
  readProjectConversationTool,
} from "./project-conversations";

// ===== 长期记忆 =====
import { forgetMemoryTool, rememberMemoryTool, searchMemoryTool } from "./memory";

// ===== 图片工具 =====
import { editImageTool, generateImageTool, imageEditAvailable } from "./image-generation";

// ===== 音频工具 =====
import { speechRecognitionTool, speechSynthesisTool } from "./audio";

// ===== 开发工具 =====
import { runBashTool } from "./bash";

// ===== Widget 渲染 =====
import { renderWidgetTool } from "./widget-render";
import { scheduleTaskTool } from "./schedule-task";
import {
  deleteScheduleTaskTool,
  listScheduleTasksTool,
  updateScheduleTaskTool,
} from "./schedule-management";

// ===== MCP 集成 =====
import { buildMcpTools, mcpToolLabels } from "./mcp";

// ===== 技能系统 =====
import { listSkillsTool, readSkillFileTool, readSkillTool } from "./skills";
import { writeSkillTool } from "./skills-write";

// ===== 用户交互 =====
import { askUserTool } from "./ask-user";

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

/** 按组创建工具注册项的辅助函数 */
function reg(group: string) {
  return (
    id: string,
    name: string,
    description: string,
    factory: (ctx: ToolContext) => AgentTool<any>,
    isAvailable?: (ctx: ToolContext) => boolean,
  ): ToolEntry => ({
    id, name, description, factory, group, ...(isAvailable ? { isAvailable } : {}),
  });
}

// 按组创建注册项的快捷函数
const system = reg("system");
const cu = (
  id: string,
  name: string,
  description: string,
  factory: (ctx: ToolContext) => AgentTool<any>,
) =>
  reg("computeruse")(
    id,
    name,
    description,
    factory,
    // 仅当上下文显式标记 Computer Use 不可用时才不装配；未指定时默认可用
    (ctx) => ctx.computerUseAvailable !== false,
  );
const bu = (
  id: string,
  name: string,
  description: string,
  factory: (ctx: ToolContext) => AgentTool<any>,
) =>
  reg("browseruse")(
    id,
    name,
    description,
    factory,
    // 仅当上下文显式标记浏览器扩展未连接时不装配；未指定时默认可用
    (ctx) => ctx.browserExtensionConnected !== false,
  );
const task = reg("task");
const network = reg("network");
const file = reg("file");
const office = reg("office");
const project = reg("project");
const knowledge = reg("knowledge");
const memory = reg("memory");
const image = reg("image");
const audio = reg("audio");
const dev = reg("dev");
const skill = reg("skill");
const interaction = reg("interaction");
const widget = reg("widget");
const schedule = reg("task");

// ASR 接口是否已配置（provider、apiKey、model 齐全）
function asrAvailable(): boolean {
  const settings = useConfigStore.getState().settings.audio;
  const asrConfig = settings?.asr;
  if (!asrConfig?.provider) return false;
  const activeConfig = asrConfig.provider === "audio" ? asrConfig.audio : asrConfig.chat;
  return Boolean(activeConfig?.apiKey?.trim() && activeConfig?.model?.trim());
}

// TTS 接口是否已配置（provider、apiKey、model、voices 齐全）
function ttsAvailable(): boolean {
  const settings = useConfigStore.getState().settings.audio;
  const ttsConfig = settings?.tts;
  if (!ttsConfig?.provider) return false;
  const activeConfig = ttsConfig.provider === "audio" ? ttsConfig.audio : ttsConfig.chat;
  return Boolean(
    activeConfig?.apiKey?.trim() &&
      activeConfig?.model?.trim() &&
      activeConfig?.voices &&
      activeConfig.voices.length > 0,
  );
}

// 图片生成接口是否已配置（当前所选标准必填项齐全）
function imageGenerationAvailable(): boolean {
  const config = useConfigStore.getState().settings.imageGeneration;
  if (!config?.provider) return false;
  if (config.provider === "gemini") {
    return Boolean(config.gemini?.apiKey?.trim() && config.gemini?.model?.trim());
  }
  if (config.provider === "openai-chat") {
    return Boolean(config.openaiChat?.apiKey?.trim() && config.openaiChat?.model?.trim());
  }
  return Boolean(config.openaiImages?.apiKey?.trim() && config.openaiImages?.model?.trim());
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
  project: { name: "项目", description: "列出和读取当前项目中的历史会话", order: 7 },
  knowledge: { name: "知识库", description: "检索知识库文档,获取相关内容", order: 8 },
  memory: { name: "长期记忆", description: "检索、写入和遗忘用户偏好与项目上下文", order: 9 },
  image: { name: "图片工具", description: "生成图片并保存为会话产物", order: 10 },
  audio: { name: "音频工具", description: "语音识别与语音合成", order: 11 },
  dev: { name: "开发工具", description: "执行 shell 命令,运行项目脚本", order: 12 },
  skill: { name: "技能", description: "查看并读取当前助手可用技能", order: 13 },
  widget: { name: "Widget", description: "渲染交互式 UI Widget（图表、表单、表格等）", order: 14 },
  interaction: { name: "用户交互", description: "向用户请求输入,收集选择反馈", order: 15 },
};

// 全部真实内置工具。默认可用于普通会话；带 isAvailable 的工具只在对应上下文里装配。
const TOOL_REGISTRY: ToolEntry[] = [
  system("system_info", "系统信息", "获取电脑的系统信息，包括当前时间、时区、位置、硬件配置、网络状态等。", systemInfoTool),
  cu("windows_snapshot", "Windows 截图", "获取 Windows 活动窗口或桌面的截图和 UI 树结构，包含可点击元素的位置和信息。", windowsSnapshotTool),
  cu("windows_accessibility_tree", "获取 UI 树", "获取 UI Automation 树结构（无截图），比 snapshot 更快，适合频繁读取 UI 状态。", windowsAccessibilityTreeTool),
  cu("windows_list_windows", "列出窗口", "列出所有顶级桌面窗口，返回窗口标题、进程ID、窗口句柄等信息。", windowsListWindowsTool),
  cu("windows_find", "Windows 查找", "在 Windows 应用中查找 UI 元素。", windowsFindTool),
  cu("windows_element_info", "元素信息", "获取指定 UI 元素或坐标处元素的详细信息。", windowsElementInfoTool),
  cu("windows_focus", "聚焦元素", "使用 UI Automation 将焦点移动到指定元素。", windowsFocusTool),
  cu("windows_invoke", "调用元素", "优先使用 UIA Pattern 操作元素，必要时回退点击。", windowsInvokeTool),
  cu("windows_set_value", "设置元素值", "优先使用 UIA ValuePattern 设置输入框值。", windowsSetValueTool),
  cu("windows_activate_window", "激活窗口", "按标题、进程 ID 或 HWND 激活目标窗口。", windowsActivateWindowTool),
  cu("windows_click", "Windows 点击", "在 Windows 应用中点击指定坐标或 UI 元素。", windowsClickTool),
  cu("windows_double_click", "Windows 双击", "在 Windows 应用中双击指定坐标或 UI 元素，用于打开文件、展开树节点等。", windowsDoubleClickTool),
  cu("windows_move", "移动鼠标", "移动鼠标指针到指定坐标或 UI 元素中心。", windowsMoveTool),
  cu("windows_drag", "Windows 拖拽", "按路径执行鼠标拖拽。", windowsDragTool),
  cu("windows_scroll", "Windows 滚动", "在 Windows 应用中滚动内容。", windowsScrollTool),
  cu("windows_type", "Windows 输入", "在 Windows 应用的当前焦点控件中输入文本。", windowsTypeTool),
  cu("windows_keypress", "Windows 按键", "在 Windows 应用中按下键盘按键或组合键。", windowsKeypressTool),
  cu("windows_wait", "Windows 等待", "等待窗口动画、加载或焦点变化完成。", windowsWaitTool),
  cu("windows_batch", "Windows 批量操作", "按顺序执行多个 Computer Use 动作，减少多轮调用开销。", windowsBatchTool),
  bu("browser_tabs", "列出标签页", "列出当前所有浏览器标签页。", browserTabsTool),
  bu("browser_open", "打开标签页", "打开新的浏览器标签页。", browserOpenTool),
  bu("browser_close", "关闭标签页", "关闭指定的浏览器标签页。", browserCloseTool),
  bu("browser_scan", "扫描页面", "扫描页面内容,获取文本或结构化信息。", browserScanTool),
  bu("browser_snapshot", "页面快照", "获取页面可操作元素快照,生成 @e 引用用于后续点击或填充。", browserSnapshotTool),
  bu("browser_click", "点击元素", "点击页面元素,支持 CSS 选择器或 @e 引用。可通过 action 指定单击、双击、右键菜单、鼠标按下/释放。", browserClickTool),
  bu("browser_fill", "填充表单", "填充表单输入框；目标为 <select> 下拉框时可按 value、text 或 index 选择选项。", browserFillTool),
  bu("browser_drag", "拖拽元素", "在页面中模拟拖拽操作，将源元素拖动到目标元素。", browserDragTool),
  bu("browser_upload", "上传文件", "通过 input[type=file] 元素上传本地文件。", browserUploadTool),
  bu("browser_execute", "执行脚本", "在页面中执行 JavaScript 代码，也可模拟键盘组合键等操作。", browserExecuteTool),
  bu("browser_screenshot", "浏览器截图", "截取页面截图。", browserScreenshotTool),
  bu("browser_network", "网络监控", "监控网络请求。", browserNetworkTool),
  bu("browser_console", "控制台日志", "监听并读取页面 console 与异常日志。", browserConsoleTool),
  task("update_todos", "更新待办", "维护当前任务的待办清单，用完整列表同步任务进度。", updateTodosTool),
  task("delegate_task", "调用子代理", "调用另一个助手作为子代理完成明确子任务，并把结果返回给当前助手整合。", delegateTaskTool, (ctx) => !ctx.isSubagent && !ctx.isBackground),
  schedule("schedule_task", "创建定时任务", "创建后台定时任务，让 Agent 在指定时间自动执行一次性、周期性或 Cron 指令。", scheduleTaskTool),
  schedule("list_schedule_tasks", "列出定时任务", "列出当前已有的后台定时任务，返回 taskId、名称、启用状态、下次执行时间等信息。", listScheduleTasksTool),
  schedule("update_schedule_task", "编辑定时任务", "按 taskId 或名称修改已有定时任务，可更新启用状态、调度方式和执行内容。", updateScheduleTaskTool),
  schedule("delete_schedule_task", "删除定时任务", "按 taskId 或名称删除已有定时任务；删除前必须 confirm=true。", deleteScheduleTaskTool),
  interaction("ask_user", "询问用户", "向用户请求 input 输入、single 单选或 multiple 多选；问题支持 Markdown，选项模式自动追加自定义输入项。", askUserTool),
  skill("list_skills", "列出技能", "列出当前助手可用的技能名称与适用场景。", listSkillsTool),
  skill("read_skill", "读取技能", "读取当前上下文中某个可用技能的完整 SKILL.md 说明和目录树。", readSkillTool),
  skill("read_skill_file", "读取技能文件", "读取可用技能目录内 references、examples 等子文件。", readSkillFileTool),
  skill("write_skill", "写入技能", "创建、编辑、精确替换或删除 dataDir/skills/custom 目录下的技能。create 创建新技能目录和 SKILL.md；edit 全量替换 SKILL.md；patch 精确定位 old_string 替换为 new_string；delete 删除整个技能目录（需 confirm=true）。每次修改前会自动备份（保留最多 10 个版本）。", writeSkillTool),
  file("read_file", "读取文件", "读取工作目录下指定文件的文本内容。", readFileTool),
  file("write_file", "写入文件", "把内容写入工作目录下的文件（覆盖写入），写入后出现在产物面板。", writeFileTool),
  file("edit_file", "编辑文件", "对文件做精确替换编辑（oldString→newString），适合定点修改而非整篇重写。", editFileTool),
  file("create_directory", "新建目录", "在工作目录下创建目录，会自动创建必要的父目录。", createDirectoryTool),
  file("delete_file", "删除路径", "删除工作目录下的文件或目录；目录会递归删除其内部文件。", deleteFileTool),
  file("list_directory", "列出目录", "列出工作目录或指定目录下的文件与子目录。", listDirectoryTool),
  file("move_file", "移动/重命名", "移动或重命名文件/目录，支持跨目录移动和同目录重命名。", moveFileTool),
  file("copy_file", "复制文件", "复制文件或目录到指定位置。", copyFileTool),
  file("search_files", "搜索文件", "使用 Glob 模式搜索文件与目录。", searchFilesTool),
  office("create_office_document", "创建办公文档", "生成 Word、PPT 或 PDF 文件，保存后出现在产物面板并可用独立预览窗口打开。", createOfficeDocumentTool),
  project("list_project_conversations", "列出项目会话", "列出当前项目中的其他会话，返回标题、ID 和更新时间。", listProjectConversationsTool, (ctx) => Boolean(ctx.projectId)),
  project("read_project_conversation", "读取项目会话", "读取当前项目中指定历史会话的最近消息。", readProjectConversationTool, (ctx) => Boolean(ctx.projectId)),
  network("web_search", "网络搜索", "在互联网上检索信息，返回若干条结果（标题、链接、摘要）。", searchWebTool),
  network("web_fetch", "网页读取", "读取网页正文并提取主要文本，支持按标题或锚点分段提取与链接、表格抽取。", readWebPageTool),
  image("image_generation", "生成图片", "调用图片生成模型，根据提示词生成图片并保存到工作目录。", generateImageTool, () => imageGenerationAvailable()),
  // 仅当所选图片接口标准支持编辑时才注册（openai-chat 不支持）。
  image("image_edit", "编辑图片", "调用图片编辑模型，基于本地源图和可选蒙版编辑图片并保存结果。", editImageTool, () => imageEditAvailable()),
  audio("speech_recognition", "语音识别", "将音频文件转写为文字，支持常见音频格式（mp3/wav/m4a/webm/ogg 等）。", speechRecognitionTool, () => asrAvailable()),
  audio("speech_synthesis", "语音合成", "将文字合成为语音并保存到工作目录，登记为产物。", speechSynthesisTool, () => ttsAvailable()),
  dev("run_bash", "运行命令", "在会话工作目录下执行 shell 命令，返回标准输出与错误输出。高危命令会被拦截。", runBashTool),
  knowledge("search_knowledge", "检索知识库", "在已启用的知识库中检索相关文档片段，获取项目文档、技术规范等上下文信息。", searchKnowledgeTool),
  memory("search_memory", "检索记忆", "检索长期记忆，获取用户偏好、身份画像、历史纠正和项目上下文。", searchMemoryTool),
  memory("remember_memory", "写入记忆", "在用户明确要求记住或需要修正长期偏好/项目约定时写入记忆。", rememberMemoryTool),
  memory("forget_memory", "忘记记忆", "关闭或删除长期记忆，适合用户要求忘记某个偏好、画像或项目约定时使用。", forgetMemoryTool),
  widget("render_widget", "渲染 Widget", "在对话中渲染交互式 UI Widget，支持内联 HTML 或 skills 目录下 .html 模板。", renderWidgetTool),
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

  const tools: AgentTool<any>[] = [];

  for (const entry of TOOL_REGISTRY) {
    if (!isBuiltinToolEnabled(entry.id)) continue;
    if (ctx.isBackground && entry.id === "ask_user") continue;
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
