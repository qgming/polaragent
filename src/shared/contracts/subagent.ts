// 子智能体（subagent）契约：定义、目录、运行记录与事件。
//
// 与技能（skills）的分工：技能是「给主代理看的说明书」，子智能体是「替主代理干活的另一条会话」。
// 因此本文件的类型要同时服务三处消费者，三处必须看到同一份形状：
//   1. 设置面板（列出 / 编辑 / 启用禁用定义）；
//   2. 主进程运行时的 Task 工具（按定义装配子会话）；
//   3. 渲染层的执行详情面板与主会话里的嵌套组件（按运行记录关联父会话）。
//
// 存储模型（对齐参考实现 PI-Desktop 的取舍）：
// - 定义有两种来源：代码里的 `builtin` 预设，以及用户在数据目录 `subagents/*.md` 里的 `user` 定义；
// - 主 AI 还可以在委派时**临时**定义一个子智能体（`temp`）—— 只活在本次运行里，不落盘、不进设置列表；
// - 「运行记录」不单独建库：子智能体有自己的（隐藏）会话承载转录，
//   运行记录本身**落在那个子会话的索引条目上**（见 session-store 的 saveSubagentRun）——
//   父会话转录里那次 Task 调用的 `details` 只在派发时写一次、此后无法更新，重启后读不到结局。

import type { ModelRef, ThinkingLevel } from "./common";

/** 子智能体定义来源：内置预设 / 用户 .md 定义 / 主 AI 临时创建 */
export type SubagentSource = "builtin" | "user" | "temp";

/**
 * 允许分配给子智能体的工具名。
 *
 * 用**应用自己的小写工具名**（与 src/main/pisdk/tools.ts 的 TOOL_NAMES 同一套），
 * 不是内核的 Read/Glob/Grep —— 面板里显示的字面量必须和权限层、图标表里的键一致，
 * 否则「设置里允许了 bash」与「实际注入的是 bash」会悄悄对不上。
 *
 * 刻意**不在**列表里的：ask_user（子智能体不能卡住等用户）、作业三件套（子智能体不该自己起
 * 后台进程）、浏览器工具（不该操作用户正盯着的页面）、Task 系列（不允许嵌套委派）。
 * 这条约束在 tools.ts 的 buildTools 注释里已有对应说明，两处不要漂移。
 */
export const SUBAGENT_ASSIGNABLE_TOOLS = [
  "read",
  "grep",
  "glob",
  "bash",
  "edit",
  "write",
  "todo",
] as const;

export type SubagentToolName = (typeof SUBAGENT_ASSIGNABLE_TOOLS)[number];

/** 没有显式指定工具时的默认集合：只读三件套（最安全的那一档） */
export const DEFAULT_SUBAGENT_TOOLS: readonly SubagentToolName[] = ["read", "grep", "glob"];

/** 带写权限的工具：用于决定子智能体系统提示里那句「你可以改文件」是否成立 */
export const SUBAGENT_MUTATING_TOOLS: readonly SubagentToolName[] = ["bash", "edit", "write"];

export function subagentCanMutate(tools: readonly string[]): boolean {
  return tools.some((tool) => (SUBAGENT_MUTATING_TOOLS as readonly string[]).includes(tool));
}

/** maxTurns 的上限：防止一个定义把子智能体设成无限轮次把自己跑爆 */
export const MAX_SUBAGENT_MAX_TURNS = 80;
/** maxTurns 缺省值：够完成一次调研或一次小改动，又不至于失控 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
/** 目录里最多合并多少个定义（含内置）；超出部分被丢弃并在 diagnostics 里说明 */
export const MAX_SUBAGENT_DEFINITIONS = 16;
/** 单个定义的 prompt 正文上限，防止把整个上下文塞进系统提示 */
export const MAX_SUBAGENT_PROMPT_CHARS = 20_000;
/** 同一次主会话里最多并行多少个委派（超出则 Task 直接拒绝，而不是排队等暗坑） */
export const MAX_CONCURRENT_SUBAGENT_RUNS = 4;

/** 名字规则：小写字母/数字开头，允许中间短横线，≤40 字符（与文件名一一对应） */
export const SUBAGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 把任意输入规范成合法子智能体名：取 basename、去 .md、小写、空格与下划线转短横线 */
export function normalizeSubagentName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? raw;
  return base
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** 一个完整的子智能体定义（运行时的输入） */
export interface SubagentDefinition {
  name: string;
  /** 一句话说明「什么时候该派给它」—— 这是主模型唯一的挑选依据，必填 */
  description: string;
  /** 子智能体的系统提示正文（markdown） */
  prompt: string;
  tools: string[];
  /** 固定使用的模型；null / 缺省 = 继承父会话 */
  model?: ModelRef | null;
  /** 思考档位；缺省 = 继承父会话 */
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  source: SubagentSource;
  /** user 定义的落盘路径（builtin / temp 没有） */
  filePath?: string;
}

/** 设置面板里的一行：定义 + 是否启用（启用状态存在 settings，不写进 .md） */
export interface SubagentInfo {
  name: string;
  description: string;
  tools: string[];
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  maxTurns: number;
  source: SubagentSource;
  enabled: boolean;
  filePath?: string;
  /** prompt 正文的预览（前若干字符），面板列表不展开全文 */
  promptPreview: string;
}

/** 目录读取结果：列表 + 诊断信息（解析失败的定义要能被看见，而不是静默消失） */
export interface SubagentCatalog {
  subagents: SubagentInfo[];
  /** 解析/读取过程中遇到的问题（文件路径 + 原因），直接显示给用户 */
  diagnostics: string[];
}

export type SubagentRunStatus =
  /** 正在跑 */
  | "running"
  /** 正常跑完（拿到了最终报告） */
  | "completed"
  /** 报告在，但触到了 maxTurns，可能不完整 */
  | "truncated"
  /** 运行中报错 */
  | "failed"
  /** 用户 / 新一轮对话把它停了 */
  | "aborted"
  /** 定义不存在、模型解析不出来等「起不来」的失败 */
  | "denied"
  /**
   * 意外终止：拥有这次运行的进程没写下终态就没了（崩溃 / 被强杀 / 断电），结果未知。
   *
   * 刻意**不**并进 aborted（没有人叫它停）也不并进 failed（我们没有任何错误信息）：
   * 这个状态要说的正是「我们不知道它是成了还是没成」，
   * 于是要不要重派这件事得留给主代理判断（见 tools/subagent.ts 的 resumeOf）。
   */
  | "interrupted";

export type SubagentRunFinishedStatus = Exclude<SubagentRunStatus, "running">;

export function isSubagentRunFinished(status: SubagentRunStatus): boolean {
  // interrupted 也是终态：它不会再有任何推进（推进它的进程已经不在了），
  // 面板与等待方都必须把它当「结束了」，否则重启后的每一行都会永远停在「还在跑」
  return status !== "running";
}

/**
 * 一次委派的运行记录。
 *
 * `delegationId` **就是**派发它的那次 Task 调用的 toolCallId —— 故意让两者相等，
 * 因为渲染层要按「主会话里那个工具调用」去找「这条运行记录」，
 * 中间再插一个映射表就多一处会对不上的地方（参考实现取的是 delegationId ?? toolCallId ?? id，
 * 这里直接规定相等，把兜底逻辑消掉）。
 */
export interface SubagentRun {
  delegationId: string;
  /** 父（主）会话 id */
  sessionId: string;
  /** 派发它的那次 Task 调用的 id，与本记录的 delegationId 相同 */
  parentToolCallId: string;
  /** 承载转录的子会话 id（隐藏会话，不进左侧栏列表） */
  childSessionId: string;
  agentName: string;
  agentSource: SubagentSource;
  /** 主模型给的短描述，用于在主会话里显示「它在干什么」 */
  description: string;
  /** 派发给子智能体的任务全文 */
  task: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  model: ModelRef | null;
  /** 实际使用的模型 id（面板上显示用） */
  modelId: string;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
  tools: string[];
  /** 已经跑过的轮次与工具调用次数（进度指标） */
  turns: number;
  toolCalls: number;
  /** 最终报告（子智能体最后一条助手消息的正文） */
  report?: string;
  error?: string;
  /** 这条记录最近一次落盘的时间 —— 也是「我们最后一次见到它还活着」的时间（对账时用它推意外终止的时刻） */
  updatedAt?: number;
  /** 重派时它接续的那次委派 id：主代理对一次 interrupted 运行重新派发时写下（见 Task 的 resumeOf） */
  resumedFrom?: string;
}

/** 主进程 → 渲染进程的运行事件；信封见 SubagentEventEnvelope */
export type SubagentEvent =
  | { type: "run-started"; run: SubagentRun }
  /** 同一次运行的状态推进（进度、状态变化、收尾报告） */
  | { type: "run-updated"; run: SubagentRun };

/** 事件信封：与 chat:event 同构，sessionId 是**父**会话 —— 渲染层据此过滤 */
export interface SubagentEventEnvelope {
  /** 父会话 id */
  sessionId: string;
  event: SubagentEvent;
}

/** 新建 / 更新用户定义时的请求体 */
export interface SubagentWriteRequest {
  /** 原名（重命名时用来定位旧文件）；新建时省略 */
  originalName?: string;
  name: string;
  description: string;
  /** markdown 正文（prompt） */
  prompt: string;
  tools: string[];
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  maxTurns: number | null;
}

export interface SubagentReadResult {
  name: string;
  /** 磁盘上的原文（含 frontmatter），直接喂给编辑框 */
  content: string;
}
