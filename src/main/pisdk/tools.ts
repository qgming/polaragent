// 工具装配：构建暴露给 Agent 的完整工具集。
//
// 分两类：
// - pi 内核原生四件套（bash/read/write/edit）：description 在本文件**整体覆盖**。内核自带的
//   文案偏操作说明（返回什么、怎么截断），不讲「什么时候该用它」，而模型选错工具的首要原因
//   就是缺少场景指导 —— 所以这里替换而不是追加。
// - 自建只读工具（grep/glob/todo）：见 ./tools/。
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

/** 构建本应用暴露给 Agent 的完整工具集 */
export function buildTools(): AgentHarnessTool<AppToolContext>[] {
  return [
    { ...createBashTool<AppToolContext>({ prepare: prepareBash }), description: BASH_DESCRIPTION },
    { ...createReadTool<AppToolContext>(), description: READ_DESCRIPTION },
    { ...createWriteTool<AppToolContext>(), description: WRITE_DESCRIPTION },
    { ...createEditTool<AppToolContext>(), description: EDIT_DESCRIPTION },
    createGrepTool<AppToolContext>(),
    createGlobTool<AppToolContext>(),
    createTodoTool(),
  ];
}
