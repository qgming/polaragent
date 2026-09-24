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
  createWriteTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import { WEB_TOOL_NAMES } from "@/shared/contracts/web";
import type { BrowserAutomation } from "../browser/types";
import type { WebService } from "../web/types";
import { ASK_TOOL_NAME } from "./tools/ask";
import { createBrowserTools } from "./tools/browser";
import { createReadToolWithLineNumbers } from "./tools/read";
import { createReadImageTool, READ_IMAGE_TOOL_NAME } from "./tools/read-image";
import { createGlobTool, createGrepTool } from "./tools/search";
import { createTodoTool, type TodoToolContext } from "./tools/todo";
import { createWebTools } from "./tools/web";

/**
 * 应用级工具上下文：受路径守卫约束的执行环境 + 会话级待办状态。
 *
 * 全部工具共用同一个 context 类型（不能混用更窄的类型）：`AgentHarnessTool` 的 `execute`
 * 是函数属性，参数位逆变，`AgentHarnessTool<TodoToolContext>` 无法赋给
 * `AgentHarnessTool<ExecutionToolContext>`。所以自建工具一并泛型化到这一层。
 */
export type AppToolContext = TodoToolContext;

/**
 * `buildTools` 的可选配置。
 *
 * 单独一个类型而不是继续加位置参数：见 buildTools 第七个参数的说明。
 */
export interface BuildToolsOptions {
  /**
   * grep / glob 的检索围栏（通常是 `sessionAllowedRoots(cwd, appPath)`）。
   *
   * **不传 = 不做围栏**。这不是"默认安全"的形状，是刻意的：单测与不关心会话边界的
   * 调用方需要旧行为。生产路径的两处调用都必须传。
   */
  searchRoots?: readonly string[];
}

/** 工具名常量，供权限层与 UI 复用 */ export const TOOL_NAMES = {
  bash: "bash",
  read: "read",
  /** 读一张图片（用户上传的 / 项目里的 / 截图工具产出的），名字取自 tools/read-image.ts */
  readImage: READ_IMAGE_TOOL_NAME,
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  todo: "todo",
  /** 向用户提问；名字取自 tools/ask.ts，避免两处各写一份字面量 */
  ask: ASK_TOOL_NAME,
  /** 浏览器工具；名字取自 shared/contracts/browser.ts（UI 图标表与权限层复用同一份） */
  ...BROWSER_TOOL_NAMES,
  /** 网络工具；名字取自 shared/contracts/web.ts（同上） */
  ...WEB_TOOL_NAMES,
} as const;
const BASH_DESCRIPTION =
  "在当前工作目录执行一条 shell 命令，返回合并后的 stdout 与 stderr；超长输出只保留末尾 2000 行 / 50KB。\n" +
  "结果末尾总会带一行 [exited with code N]：命令成没成看它，**不需要**再跑一条 echo $?。\n\n" +
  "什么时候用：跑测试与构建、装依赖、看 git 状态（git status / git diff / git log）、执行项目脚本。\n" +
  "什么时候不要用：找文件用 glob，搜内容用 grep，读写文件用 read/write/edit —— 不要用 cat/sed/echo 去读改文件，" +
  "也不要在命令里拼 grep/find/rg，那些二进制在每台机器上不一定存在，遇到带空格的路径还会因为引号出错。";

const READ_DESCRIPTION =
  "读取一个文本文件，返回带行号的内容（`行号 + Tab + 原文`，行号是文件里的真实行号），可用 offset / limit 分页。\n" +
  "行号是给你引用位置用的阅读辅助，**不是文件内容**：edit 的 oldText/newText 与 write 的正文都不要把它带上（见 edit 的说明）。\n\n" +
  "什么时候用：**修改任何文件之前先读它**；需要看完整实现或其上下文时。\n" +
  "什么时候不要用：只想定位某个符号或字符串在哪 → 用 grep；文件很大而只需要片段 → 先用 grep 拿到行号，" +
  "再带 offset/limit 读那一段；只是想确认文件存在或看目录结构 → 用 glob。\n" +
  "**要看的是一张图片（png/jpg/webp/gif）时用 read_image**：read 确实也能把图片整个读回来，" +
  "但它**没有大小上限**，一张大图会整份进上下文；read_image 有 16 MiB 守卫并返回尺寸。" +
  "SVG 不是图片而是文本，仍用 read。";

const WRITE_DESCRIPTION =
  "把一个文件的全部内容写入磁盘，已存在则整体覆盖。\n\n" +
  "什么时候用：新建文件；或者改动幅度超过文件大半、无法用定点替换表达时。\n" +
  "什么时候不要用：只改几处 → 用 edit；想追加内容 → 也用 edit（先读文件末尾，再在末尾锚点上做替换）。" +
  "整体覆盖会丢掉你没读到的改动，所以用之前先 read。";

const EDIT_DESCRIPTION =
  "对文件做字面替换：edits 里每处 oldText 必须在文件中唯一匹配，匹配不到或匹配到多处都会失败。\n" +
  "**read 的输出带行号，但 oldText / newText 必须是文件原文**：匹配是逐字符的，" +
  "把行号（含后面那个 Tab）复制进来会直接失配；newText 里混入行号则会把它写进文件。\n\n" +
  "什么时候用：定点修改 —— 改一个函数、一行配置、一个字符串。一次调用可以带多个 edits 批量改同一个文件。\n" +
  "什么时候不要用：不确定文件当前内容时（先 read）；需要跨多个文件大范围重构时逐个文件改。" +
  "oldText 里不要包含大段未改动的上下文 —— 只保留足以唯一定位的少量行，否则文件一动就会失配。";

/** bash 的 prepare 回调：工作目录固定为会话 ExecutionEnv.cwd，不受进程 cwd 影响 */
function prepareBash(execution: BashExecution, toolContext: ExecutionToolContext): void {
  execution.cwd = toolContext.env.cwd;
}

/**
 * 内核 bash 非零退出时抛出的错误文本：`<输出>\n\nCommand exited with code N`（见内核 harness/tools/bash.js）。
 *
 * 为什么靠文案解析：内核只在**异常**里带退出码，成功时什么都不给（ToolResult 没有退出码字段），
 * 而包装层拿不到它内部那次 env.exec 的结果 —— 除了这句固定文案没有别的来源。
 */
const BASH_EXIT_ERROR_PATTERN = /^([\s\S]*?)(?:\n\n)?Command exited with code (-?\d+)$/;

/** 退出码统一成结果末尾的一行；输出自带的换行先收掉，别把退出码隔出两个空行 */
function exitCodeLine(output: string, exitCode: number): string {
  const body = output.replace(/\n+$/, "");
  return body === ""
    ? `[exited with code ${exitCode}]`
    : `${body}\n\n[exited with code ${exitCode}]`;
}

/**
 * 给 bash 结果补上退出码。
 *
 * 内核 bash 只在非 0 退出时用异常带出退出码，成功时只回输出 —— 模型想确认「命令到底成没成」
 * 就得再跑一条 echo $?（多一次往返，而且 $? 是上一条命令的，很容易被夹在中间的命令吃掉）。
 * 这里把退出码统一成结果文本的最后一行，非 0 时保持「抛错」：失败仍然以 isError 进入转录，
 * 只是错误文本里也有同样的 [exited with code N] 行（词汇与作业工具的 exited / exit code 一致）。
 *
 * 超时、中止、起不来这些异常原样抛出：它们没有退出码，内核对它们的文案就是既有行为
 *（如 "Command timed out after N seconds"），不能改写。合并 stderr 到 stdout 由内核负责，这里不碰。
 */
function withBashExitCode(
  tool: AgentHarnessTool<AppToolContext>,
): AgentHarnessTool<AppToolContext> {
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, onUpdate, toolContext, invocation, context) {
      try {
        const result = await inner(toolCallId, params, onUpdate, toolContext, invocation, context);
        const only = result.content.length === 1 ? result.content[0] : undefined;
        if (only === undefined || only.type !== "text") return result;
        return { ...result, content: [{ ...only, text: exitCodeLine(only.text, 0) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        const match = message === undefined ? null : BASH_EXIT_ERROR_PATTERN.exec(message);
        if (match === null || match[1] === undefined || match[2] === undefined) throw error;
        throw new Error(exitCodeLine(match[1], Number(match[2])), { cause: error });
      }
    },
  };
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
 *   `extraTools` 是「谁都可以塞」的扩展位，子智能体工具是产品内置的一组，不该混在扩展位后面；
 * - webService：网络工具（见 tools/web.ts）。与 browserAutomation 同款：
 *   **不传就完全不装配**，于是单测里 buildTools() 的结果与加这个参数之前完全一致。
 *   它由 runtime 经 RuntimeDeps 注入（同 browser 的理由：实现依赖 node:https 与设置存储，
 *   在这里 import 会把它们拖进 runtime 的 node 单测）。
 *
 * 注意前四个参数都是**可选**的：不传就没有对应的工具。会话创建
 * （runtime 的 tools: ...）与 MCP 热替换（applyMcpTools 的 harness.setTools）两条路径
 * 都必须把它们带上，否则热替换之后这些工具会凭空消失（ask_user 踩过同一个坑）。
 *
 * ⚠️ **web 工具要一并带进子智能体的那条路径**：与 browser 不同，子智能体**应该**能联网
 * （它们不需要用户眼前的 UI，也不会卡住等人）。是否真的拿到取决于 restrictTools 的
 * 白名单 —— 见 shared/contracts/subagent.ts 的 SUBAGENT_ASSIGNABLE_TOOLS。
 */
export function buildTools(
  extraTools: AgentHarnessTool<AppToolContext>[] = [],
  askTool?: AgentHarnessTool<AppToolContext>,
  jobTools: AgentHarnessTool<AppToolContext>[] = [],
  browserAutomation?: BrowserAutomation,
  subagentTools: AgentHarnessTool<AppToolContext>[] = [],
  webService?: WebService,
  /**
   * 第七个参数是**对象**而不是又一个位置参数：前六个已经排满，再加一个是纯粹的
   * 「填 undefined 才能到第七位」。将来的选项（插件工具、配额…）都往这里放。
   *
   * `searchRoots` 是 grep / glob 的围栏（见 tools/search.ts 的 resolveSearchRoot）。
   * **不传 = 不做围栏** —— 单测与不关心会话边界的调用方走这条；runtime 的两处调用
   * 都必须传 `sessionAllowedRoots(cwd, appPath)`，否则那两个工具又变成零确认越界读。
   */
  options: BuildToolsOptions = {},
): AgentHarnessTool<AppToolContext>[] {
  return [
    {
      ...withBashExitCode(createBashTool<AppToolContext>({ prepare: prepareBash })),
      description: BASH_DESCRIPTION,
    },
    { ...createReadToolWithLineNumbers<AppToolContext>(), description: READ_DESCRIPTION },
    /**
     * read_image 紧挨着 read：两者是同一个问题的两条路（读文件），只是结果形态不同
     *（文本 vs 图片）。放在一起，模型在「这个路径该用哪个」上的选择最短。
     *
     * 它**无条件装配**（不像 browser / web 需要注入实现）：只依赖 ExecutionEnv，
     * 而那个所有会话都有。图片能力本身由**模型**决定 —— 不支持的模型会在收到
     * image 块时报错，工具说明里已经写明了这条前提。
     */
    createReadImageTool<AppToolContext>(),
    { ...createWriteTool<AppToolContext>(), description: WRITE_DESCRIPTION },
    { ...createEditTool<AppToolContext>(), description: EDIT_DESCRIPTION },
    createGrepTool<AppToolContext>({ allowedRoots: options.searchRoots }),
    createGlobTool<AppToolContext>({ allowedRoots: options.searchRoots }),
    createTodoTool(),
    // 浏览器工具：操作的是主进程持有的 guest，与本会话的工作目录无关（见 tools/browser.ts）
    ...(browserAutomation === undefined
      ? []
      : (createBrowserTools(browserAutomation) as AgentHarnessTool<AppToolContext>[])),
    // 网络工具：同样是主进程单例（WebService），与工作目录无关（见 tools/web.ts）
    ...(webService === undefined
      ? []
      : (createWebTools(webService) as AgentHarnessTool<AppToolContext>[])),
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
 * 按白名单过滤工具集 —— **只给主 AI 临时定义的那个子智能体用**
 *（`definition.source === "temp" && definition.tools !== undefined`，见 contracts/subagent.ts）。
 *
 * 内置预设与用户 `.md` 定义不走这里：它们拿到的就是主代理同一批工具。所以这个函数只有一个调用点，
 * 而那些"定义里的工具"曾经带来的漂移（显示一套、注入另一套）也不复存在 ——
 * 白名单来自主代理**这次派发**时写下的东西，注入的就是它，中间没有第二个真相。
 *
 * 为什么是「同一批工具对象上做过滤」而不是再造一套：过滤发生在**已经装配好的那份工具表**上，
 * 于是 `bash` 到底有没有被权限门挡住、MCP 工具叫什么名字，这些都已经定型，
 * 白名单只是把其中一部分摘出来 —— 不可能出现「白名单里的名字与真实工具名对不上」。
 *
 * 调用方保证 `allowed` 每一项都**真实存在**（派发时逐个校验过，见 tools/subagent.ts），
 * 所以这里不需要兜底：匹配不上就是不该给。
 */
export function restrictTools(
  tools: AgentHarnessTool<AppToolContext>[],
  allowed: readonly string[],
): AgentHarnessTool<AppToolContext>[] {
  const names = new Set(allowed);
  return tools.filter((tool) => names.has(tool.name));
}
