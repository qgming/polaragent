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
 * ## 子智能体的工具：**全部可用，唯一例外是不能继续委派**
 *
 * 早先每个定义带一份「禁用清单」（黑名单制，另有更早的白名单），面板上是一排勾选框。
 * 那套东西**整体删除**了，理由有三条：
 *
 * 1. **它天然与能力脱节**：内置预设一律禁掉 bash/edit/write 以求"安全"，于是
 *    `code-reviewer` 连跑一次测试都做不到，只能把结论建立在"看起来像"上；
 * 2. **它要用户替模型做决定**：勾选框问的是「这个子智能体该不该有网络/写文件」，
 *    而真正该判断这件事的是主代理（它有任务上下文，用户没有）；
 * 3. **它把 MCP 与新工具挡在门外**：白名单是硬编码的工具名列表，后来加的 MCP 工具、
 *    浏览器工具、作业工具全都进不去 —— 子智能体因此永远比主代理"少一半手艺"。
 *
 * 现在子智能体拿到的是**主代理同一批工具**（bash / read / write / edit / grep / glob / todo /
 * read_image / 作业四件套 / web / browser / **MCP**），唯一被摘掉的是 Task 系列（见下）。
 *
 * ### 两个刻意的例外
 *
 * - **Task / TaskWait / TaskList / TaskStop 不给子智能体**（`subagentTools` 只在主会话装配）：
 *   不允许嵌套委派 —— 报告要交回主代理，由主代理统一调度，否则并发与验收都没了边界；
 * - **ask_user 不给子智能体**：它跑在一条**隐藏会话**里（不进左侧栏、不是当前会话），
 *   提问卡没有任何地方会渲染出来，模型会永远等一个没人看得见的问题。
 *   这不是能力限制而是「这个工具在隐藏会话里结构上不可用」—— 需要用户拍板的问题，
 *   由子智能体写进最终报告，主代理来问（见 tools/ask.ts 顶部注释）。
 *
 * 权限面没有因此变大：子智能体用的仍是**同一套审批门与路径守卫**（browser / MCP / 作业
 * 各自的边界也照旧），区别只在「它手里有哪些工具」。
 */

/**
 * 目录里最多合并多少个定义（含内置）；超出部分被丢弃并在 diagnostics 里说明。
 *
 * 内置 7 个 + 用户 9 个是常见上限；再多的定义也只会让系统提示里的
 * `<available_subagents>` 索引变长，而索引是每轮都付 token 的。
 */
export const MAX_SUBAGENT_DEFINITIONS = 16;
/** 单个定义的 prompt 正文上限，防止把整个上下文塞进系统提示 */
export const MAX_SUBAGENT_PROMPT_CHARS = 20_000;
/** 同一次主会话里最多并行多少个委派（超出则 Task 直接拒绝，而不是排队等暗坑） */
export const MAX_CONCURRENT_SUBAGENT_RUNS = 6;

/**
 * **没有轮次上限。**
 *
 * 早先这里有一对 `MAX_SUBAGENT_MAX_TURNS` / `DEFAULT_SUBAGENT_MAX_TURNS`（80 / 30），
 * 现在**整体删除**。原因是那个机制的定位错了：它被用来「发现子智能体出异常」
 * （幻觉导致反复做同一件事），但**轮次是资源消耗，不是行为特征** ——
 * 调低了误伤正当的长任务，调高了发现异常太晚（第 1000 轮才知道）。
 *
 * 现在由两层接管：
 * 1. **重复调用守卫**（`main/pisdk/repeat-guard.ts`）：同名同参数的连续调用
 *    第 3 次注入纠正消息、第 5 次终止运行 —— 检测的是行为，所以发现得早；
 * 2. **并发上限**（`MAX_CONCURRENT_SUBAGENT_RUNS`）与**用户随时能停**（`TaskStop`）：
 *    兜住成本失控。
 *
 * 生态对照：opencode / Claude Code / Codex / Copilot 都不设轮次上限；
 * Goose 的 1000 与 OpenHands 的 500 是宽松兜底。**Oint 选择不设，
 * 但比它们多一个行为级的检测器**（Codex 连检测器都没有，只有成本预算）。
 */

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
  /**
   * **工具白名单 —— 只对主 AI 临时定义（`source: "temp"`）生效。**
   *
   * 内置预设与用户 `.md` 定义**不带**这个字段：它们拿到的就是主代理同一批工具
   * （唯一例外是不能继续委派，见文件顶部那段说明）。白名单只留给一种场合：
   * **主代理在派发时临时定义一个帮手，并且明确知道这次只需要哪几件工具**
   *（例如「只读地扫一遍这几个目录」→ `["read", "grep", "glob"]`）。
   *
   * 为什么交给主代理而不是做成设置项：该不该有某个工具是**任务上下文**里的判断 ——
   * 主代理知道这次要干什么，用户不知道；而一个固定的勾选框既挡不住误用，
   * 又会让 90% 的场合被迫维护一份没人看的工具清单。
   *
   * 语义：`undefined` = 不限制（给全部工具）；数组 = **只给列出的这些**。
   * 名字用应用自己的工具名（`read` / `bash` / `web_search` / …），
   * 且必须真实存在 —— 派发时逐个校验，写错哪个会带着可用清单报错（见 tools/subagent.ts）。
   */
  tools?: string[];
  /** 固定使用的模型；null / 缺省 = 继承父会话 */
  model?: ModelRef | null;
  /** 思考档位；缺省 = 继承父会话 */
  thinkingLevel?: ThinkingLevel;
  source: SubagentSource;
  /** user 定义的落盘路径（builtin / temp 没有） */
  filePath?: string;
}

/** 设置面板里的一行：定义 + 是否启用（启用状态存在 settings，不写进 .md） */
export interface SubagentInfo {
  name: string;
  description: string;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
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
  /**
   * 触到了 maxTurns，报告可能不完整。
   *
   * **已不再产生**（maxTurns 字段整体删除，见下方关于轮次上限的注释）——
   * 但**状态定义必须保留**：磁盘上的历史运行记录里有这个值，
   * 删掉会让旧会话的记录读不出来。`report-delivery.ts` 的 `describeOutcome`
   * 同理保留它的文案分支。
   *
   * 这是「删字段可以硬删（读了也没用），删状态必须向后兼容（历史数据里有）」的差别。
   */
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
  /**
   * 这次运行实际被限定的工具白名单（只有临时定义会有）；缺省 = 全部工具（不含委派）。
   *
   * 面板把它显示出来，用户才知道「这个临时帮手能干什么」。
   */
  tools?: string[];
  /**
   * 已经跑过的轮次与工具调用次数。
   *
   * **`turns` 现在纯粹是进度显示**（面板与 TaskList 看它），
   * 不再有任何上限拿它做判定 —— 见文件上方关于轮次上限的注释。
   */
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
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface SubagentReadResult {
  name: string;
  /** 磁盘上的原文（含 frontmatter），直接喂给编辑框 */
  content: string;
}
