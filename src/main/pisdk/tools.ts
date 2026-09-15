// 工具装配：构建暴露给 Agent 的完整工具集。
//
// 分两类：
// - pi 内核原生四件套（bash/read/write/edit）：description 在本文件**整体覆盖**。内核自带的
//   文案偏操作说明（返回什么、怎么截断），不讲「什么时候该用它」，而模型选错工具的首要原因
//   就是缺少场景指导 —— 所以这里替换而不是追加。
// - 自建工具（grep/glob/todo/ask_user/browser/子智能体）：见 ./tools/。ask_user 与子智能体工具
//   由调用方注入（见 buildTools），浏览器工具在 buildTools 内默认装配（它们只依赖主进程单例）。
//
// 刻意不做的：持久终端、任意代码执行、插件树操作 —— 它们会引入新的权限面，超出
// 「把内核能力原样呈现 + 少量只读增强」的产品定位。
//
// 与系统提示的分工：本文件写「某个工具自身是什么、边界在哪」，
// runtime.ts 的 TOOL_GUIDANCE 写「多个工具之间怎么选」。两处都不要重复对方的内容。

import {
  type AgentHarnessTool,
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import type { BrowserAutomation } from "../browser/types";
import { ASK_TOOL_NAME } from "./tools/ask";
import { createBrowserTools } from "./tools/browser";
import { createGlobTool, createGrepTool } from "./tools/search";
import { createTodoTool, type TodoToolContext } from "./tools/todo";

/**
 * 应用级工具上下文：受路径守卫约束的执行环境 + 会话级待办状态。
 *
 * 全部工具共用同一个 context 类型（不能混用更窄的类型）：`AgentHarnessTool` 的 `execute`
 * 是函数属性，参数位逆变，`AgentHarnessTool<TodoToolContext>` 无法赋给
 * `AgentHarnessTool<ExecutionToolContext>`。所以自建工具一并泛型化到这一层。
 */
export type AppToolContext = TodoToolContext;

/** 工具名常量，供权限层与 UI 复用 */
export const TOOL_NAMES = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  todo: "todo",
  /** 向用户提问；名字取自 tools/ask.ts，避免两处各写一份字面量 */
  ask: ASK_TOOL_NAME,
  /** 浏览器工具；名字取自 shared/contracts/browser.ts（UI 图标表与权限层复用同一份） */
  ...BROWSER_TOOL_NAMES,
} as const;
const BASH_DESCRIPTION =
  "在当前工作目录执行一条 shell 命令，返回合并后的 stdout 与 stderr；超长输出只保留末尾 2000 行 / 50KB。\n\n" +
  "什么时候用：跑测试与构建、装依赖、看 git 状态（git status / git diff / git log）、执行项目脚本。\n" +
  "什么时候不要用：找文件用 glob，搜内容用 grep，读写文件用 read/write/edit —— 不要用 cat/sed/echo 去读改文件，" +
  "也不要在命令里拼 grep/find/rg，那些二进制在每台机器上不一定存在，遇到带空格的路径还会因为引号出错。";

const READ_DESCRIPTION =
  "读取一个文本文件，返回带行号的内容，可用 offset / limit 分页。\n\n" +
  "什么时候用：**修改任何文件之前先读它**；需要看完整实现或其上下文时。\n" +
  "什么时候不要用：只想定位某个符号或字符串在哪 → 用 grep；文件很大而只需要片段 → 先用 grep 拿到行号，" +
  "再带 offset/limit 读那一段；只是想确认文件存在或看目录结构 → 用 glob。";

const WRITE_DESCRIPTION =
  "把一个文件的全部内容写入磁盘，已存在则整体覆盖。\n\n" +
  "什么时候用：新建文件；或者改动幅度超过文件大半、无法用定点替换表达时。\n" +
  "什么时候不要用：只改几处 → 用 edit；想追加内容 → 也用 edit（先读文件末尾，再在末尾锚点上做替换）。" +
  "整体覆盖会丢掉你没读到的改动，所以用之前先 read。";

const EDIT_DESCRIPTION =
  "对文件做字面替换：edits 里每处 oldText 必须在文件中唯一匹配，匹配不到或匹配到多处都会失败。\n\n" +
  "什么时候用：定点修改 —— 改一个函数、一行配置、一个字符串。一次调用可以带多个 edits 批量改同一个文件。\n" +
  "什么时候不要用：不确定文件当前内容时（先 read）；需要跨多个文件大范围重构时逐个文件改。" +
  "oldText 里不要包含大段未改动的上下文 —— 只保留足以唯一定位的少量行，否则文件一动就会失配。";

/** bash 的 prepare 回调：工作目录固定为会话 ExecutionEnv.cwd，不受进程 cwd 影响 */
function prepareBash(execution: BashExecution, toolContext: ExecutionToolContext): void {
  execution.cwd = toolContext.env.cwd;
}

/**
 * 构建本应用暴露给 Agent 的完整工具集。
 *
 * 「调用方才知道的东西」都从这里注入，本文件保持「静态装配」的角色，
 * 不反向依赖连接管理器或提问服务（会话创建与 MCP 热替换都走这一个入口）：
 * - extraTools：运行时才知道名字的工具（当前只有 MCP：mcp__<server>__<tool>），
 *   由调用方从 pisdk/mcp-servers.ts 取当前快照后传进来；
 * - askTool：ask_user 需要会话级的提问服务实例（见 tools/ask.ts），由 runtime 按会话创建；
 * - jobTools：四个后台作业工具（见 tools/jobs.ts），它们需要会话 id 与作业服务，
 *   同样由 runtime 按会话创建；
 * - browserAutomation：浏览器自动化实现（见 browser/types.ts）。生产环境传主进程单例，
 *   测试传假实现；**不传就完全不装配浏览器工具** —— 于是单测里 buildTools() 的结果
 *   与加这个参数之前完全一致；
 * - subagentTools：四个子智能体工具（见 tools/subagent.ts）。它们必须由 runtime 注入而不是
 *   在这里装配：需要**父会话 id**、聊天运行时（子会话的 prompt 走 getChatRuntime().send）与
 *   运行管理器，这三样只有 runtime.ts 拿得到。位置固定在 jobTools 之后、extraTools 之前 ——
 *   `extraTools` 是「谁都可以塞」的扩展位，子智能体工具是产品内置的一组，不该混在扩展位后面。
 *
 * 注意前四个参数都是**可选**的：不传就没有对应的工具。会话创建
 * （runtime 的 tools: ...）与 MCP 热替换（applyMcpTools 的 harness.setTools）两条路径
 * 都必须把它们带上，否则热替换之后这些工具会凭空消失（ask_user 踩过同一个坑）。
 */
export function buildTools(
  extraTools: AgentHarnessTool<AppToolContext>[] = [],
  askTool?: AgentHarnessTool<AppToolContext>,
  jobTools: AgentHarnessTool<AppToolContext>[] = [],
  browserAutomation?: BrowserAutomation,
  subagentTools: AgentHarnessTool<AppToolContext>[] = [],
): AgentHarnessTool<AppToolContext>[] {
  return [
    { ...createBashTool<AppToolContext>({ prepare: prepareBash }), description: BASH_DESCRIPTION },
    { ...createReadTool<AppToolContext>(), description: READ_DESCRIPTION },
    { ...createWriteTool<AppToolContext>(), description: WRITE_DESCRIPTION },
    { ...createEditTool<AppToolContext>(), description: EDIT_DESCRIPTION },
    createGrepTool<AppToolContext>(),
    createGlobTool<AppToolContext>(),
    createTodoTool(),
    // 浏览器工具：操作的是主进程持有的 guest，与本会话的工作目录无关（见 tools/browser.ts）
    ...(browserAutomation === undefined
      ? []
      : (createBrowserTools(browserAutomation) as AgentHarnessTool<AppToolContext>[])),
    // 子智能体（子 lane）上线时**不要**把这些工具注入子 lane：子智能体不能自己卡住等用户
    // （ask_user），也不该自己起后台进程（作业工具），更不该操作用户正盯着的浏览器 ——
    // 它要把结果写进最终回复，由主 lane 统一提问与调度（见 tools/ask.ts 顶部注释）
    ...(askTool === undefined ? [] : [askTool]),
    ...jobTools,
    // 子智能体工具：只有主会话装配，且只对主会话可见（子智能体不允许再委派）
    ...subagentTools,
    ...extraTools,
  ];
}

/**
 * 按允许名单过滤工具集（子会话装配时用：它的 tools 是定义里写的那几个）。
 *
 * 为什么是「同一批工具对象上做过滤」而不是再造一套：子智能体的 `tools` 列表是**同一份**工具表上的
 * 允许名单 —— 于是「设置里允许了 bash」与「子智能体实际拿到的是 bash」永远不可能漂移
 * （参考实现里两套工厂函数各写一遍，名字或行为对不上时没有任何地方会报错）。
 *
 * `allowed` 为空时**原样返回**：契约里空数组表示「没有指定」而不是「什么都不给」，
 * 真的什么都不给会让子智能体连 read 都没有，等于跑不起来。
 */
export function restrictTools(
  tools: AgentHarnessTool<AppToolContext>[],
  allowed: readonly string[],
): AgentHarnessTool<AppToolContext>[] {
  if (allowed.length === 0) return tools;
  const names = new Set(allowed);
  return tools.filter((tool) => names.has(tool.name));
}
