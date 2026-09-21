/**
 * 工具调用的纯逻辑层：参数、输出、补丁 → 官方 Elements 组件的入参。
 * 工具调用的纯逻辑层：参数、输出、补丁 → 官方 Elements 组件的入参。
 *
 * 与渲染分开是为了能测：本仓库的 vitest 是 node 环境且只收 `*.test.ts`，
 * 组件渲染没有测试设施，这里把容易出错的部分（补丁映射、行数截断）留在可测的纯函数里。
 * 需要 i18n 的部分（省略提示、动词）留在 ToolParts.tsx。
 */

import type { DiffLine } from "@/renderer/components/assistant-ui/elements/code-diff";
import type { TodoItem } from "@/renderer/components/assistant-ui/elements/todo-list";
import { parsePatch } from "@/renderer/components/ui/diff-viewer";
import {
  parseSubagentRun,
  SUBAGENT_TOOL_NAMES,
  subagentRunsFromDetails,
} from "@/renderer/stores/subagent-store";
import type { JobInfo } from "@/shared/contracts/job";
import {
  isSubagentRunFinished,
  type SubagentRun,
  type SubagentRunStatus,
  type SubagentSource,
} from "@/shared/contracts/subagent";
import { WEB_TOOL_NAMES, type WebSource } from "@/shared/contracts/web";

/**
 * 后台作业四件套在渲染层的名字表。
 *
 * 刻意**不复用主进程的 BACKGROUND_JOB_TOOL_NAMES**：渲染层至今没有任何一处 import
 * `@/main/**`（主进程模块依赖 Node / Electron 运行时，拉进渲染包会把边界搅浑）。
 * 这四个字符串是工具名，与主进程那份一一对应；改名时两边都要动。
 */
export const JOB_TOOL_NAMES = ["bash_background", "job_output", "job_list", "job_kill"];

/** chip 里主参数的展示上限：完整请求在展开面板里，这里只做客串 */
export const CHIP_LIMIT = 64;

/** bash 只留末尾这么多行：关键结论（报错、统计、列表）通常在结尾 */
export const BASH_TAIL_LINES = 30;

/** diff 展示上限，超出只留前段 */
export const DIFF_MAX_LINES = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 路径截断保留末级（要看的正是文件名）。
 *
 * 末级只在路径确实有层级时才有意义：`a/b` 这种只有两段的短路径，
 * 保留末级等于把整串磨成 `…/b`，不如按普通长串截断开头。
 * 同理末级为空（路径以分隔符结尾）时也退回截断开头。
 */
export function shortenPath(value: string): string {
  if (value.length <= CHIP_LIMIT) return value;
  const segments = value.split(/[\\/]/);
  const last = segments.at(-1);
  if (segments.length > 2 && last !== undefined && last !== "") return `…/${last}`;
  return `${value.slice(0, CHIP_LIMIT)}…`;
}

/**
 * 命令截断保留开头。
 *
 * 命令里的斜杠只是普通字符（`cd /foo && …`），不是路径层级，
 * 套路径规则会把它截成 `…/web` 这种只剩尾巴的样子，正好丢掉要看的部分。
 */
function shortenCommand(value: string): string {
  return value.length <= CHIP_LIMIT ? value : `${value.slice(0, CHIP_LIMIT)}…`;
}

/**
 * 主参数：命令取 command，文件路径取 path，清单取 todo 的进度；都没有时退到第一个字符串参数。
 *
 * 截断策略由**命中的参数键**决定，不靠调用方传工具名：bash 的参数是 command，
 * read/write/edit 是 path，两者在参数结构上就分得开；漏传工具名也不会截错。
 * todo 的主参数是清单数组（没有字符串可截），改给「已完成/总数」当进度。
 */
export function toolChip(args: unknown): string {
  if (!isRecord(args)) return "";

  const command = args.command;
  if (typeof command === "string" && command !== "") return shortenCommand(command);

  for (const key of ["path", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return shortenPath(value);
  }

  // todo 的清单：进度比条目文本更适合做客串；空清单不占位，与「没有字符串参数」同一个结果
  const todos = args.todos;
  if (Array.isArray(todos) && todos.length > 0) {
    const done = todos.filter((item) => isRecord(item) && item.status === "done").length;
    return `${done}/${todos.length}`;
  }

  // 子智能体委派的 description / task 是一句话而不是路径：按命令规则保留开头
  //（末尾那一段没有信息量，走路径规则会把「……/xxx」这种尾巴当成重点）
  const description = args.description;
  if (typeof description === "string" && description !== "") return shortenCommand(description);
  const task = args.task;
  if (typeof task === "string" && task !== "") return shortenCommand(task);

  // 兜底：未登记的工具只知道有个字符串参数，按路径规则处理更保守
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? shortenPath(first) : "";
}

/** 结果文本：字符串原样，其余结构化序列化 */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  return typeof result === "string" ? result : safeStringify(result);
}

/** bash 的命令：非字符串（流式期 args 可能不完整）时为空串 */
export function bashCommand(args: unknown): string {
  if (!isRecord(args)) return "";
  const command = args.command;
  return typeof command === "string" ? command : "";
}

/**
 * bash 输出 → 末尾若干行 + 被省略的行数。
 *
 * 末尾换行不算一行：命令输出几乎都以 `\n` 结尾，`split("\n")` 会在尾部多出一个空段。
 * 算作一行会挤掉真正的首行，并把 `TerminalBlock` 的末行高亮落到那个空串上。
 * 只去尾部这一个，中间与内部的空行是排版的一部分，照原样保留。
 */
export function bashOutput(result: unknown): { lines: string[]; omitted: number } {
  const text = toolResultText(result);
  if (text === "") return { lines: [], omitted: 0 };
  const all = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (all.length <= BASH_TAIL_LINES) return { lines: all, omitted: 0 };
  return { lines: all.slice(-BASH_TAIL_LINES), omitted: all.length - BASH_TAIL_LINES };
}

/** 工具 details 里的统一补丁文本；只有 edit 这类带 patch 的工具才有 */
export function detailsPatch(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const patch = details.patch;
  return typeof patch === "string" && patch.trim() !== "" ? patch : null;
}

export interface EditDiff {
  filename: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  omitted: number;
}

/** 统一补丁 → CodeDiff 的入参；解析交给仓库已有的 parsePatch（parse-diff） */
export function toEditDiff(patch: string): EditDiff | null {
  const file = parsePatch(patch)[0];
  if (file === undefined) return null;

  const all: DiffLine[] = file.lines.map((line) => ({
    kind: line.type === "add" ? "added" : line.type === "del" ? "removed" : "context",
    text: line.content,
  }));
  // 没有增删行的补丁是空块：只有文件头（0 个块）、或只有空 context 行时都会落到这里。
  // 只看「有没有解析出文件」不足以拦住后者
  if (file.additions + file.deletions === 0) return null;

  const omitted = Math.max(0, all.length - DIFF_MAX_LINES);

  return {
    filename: file.newName ?? file.oldName ?? "",
    additions: file.additions,
    deletions: file.deletions,
    lines: omitted > 0 ? all.slice(0, DIFF_MAX_LINES) : all,
    omitted,
  };
}

/** TodoList 只认这四种状态；details 从主进程过来是 unknown，必须逐项校验 */
const TODO_STATUSES = new Set<string>(["pending", "active", "done", "failed"]);

function isTodoStatus(value: unknown): value is TodoItem["status"] {
  return typeof value === "string" && TODO_STATUSES.has(value);
}

/** todo 的清单数据：与 TodoList 的入参同形（prop 叫 items，details 里叫 todos） */
export interface TodoDetailData {
  items: TodoItem[];
  revision?: number;
}

/**
 * 逐项校验 `{ todos, revision }`，形状不对返回 null，且绝不抛异常
 * （工具卡在渲染期抛错会带塌整条消息）。
 *
 * 任一项不合法就整体放弃，而不是只丢掉那一项：TodoList 自己会按 items 算
 * 「已完成/总数」，少一项会让这个比例与真实进度对不上。
 *
 * `allowMissingId` 只对工具参数放开：todo 的 schema 里新条目的 id 是可选的
 * （缺了由主进程自动编号），流式期的参数因此常常还没有 id；缺了就按位置补一个
 * 临时 key 给 TodoList 当 key 用，等 details 到了再换成真正的 id。
 */
function parseTodoState(value: unknown, allowMissingId = false): TodoDetailData | null {
  if (!isRecord(value)) return null;
  const todos = value.todos;
  if (!Array.isArray(todos)) return null;

  const items: TodoItem[] = [];
  for (const [index, raw] of todos.entries()) {
    if (!isRecord(raw)) return null;
    const { id, text, status, reason } = raw;
    if (typeof text !== "string" || text === "") return null;
    if (!isTodoStatus(status)) return null;
    if (reason !== undefined && typeof reason !== "string") return null;

    let key: string;
    if (typeof id === "string" && id !== "") key = id;
    else if (id === undefined && allowMissingId) key = `todo-${index}`;
    else return null;

    items.push(
      reason === undefined ? { id: key, text, status } : { id: key, text, status, reason },
    );
  }

  // revision 只影响标题右侧的「1/3 · rev N」文案：缺了或类型不对都不值得放弃整份清单
  const { revision } = value;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return { items };
  return { items, revision };
}

/** details（主进程产出的成品）→ TodoList 的入参；id 必填 */
export function parseTodoDetail(value: unknown): TodoDetailData | null {
  return parseTodoState(value);
}

/** 工具参数 → TodoList 的入参；schema 里新条目的 id 可选，缺了就补临时 key */
export function parseTodoArgs(value: unknown): TodoDetailData | null {
  return parseTodoState(value, true);
}

/**
 * 一次子智能体运行的展开详情。
 *
 * 头上那几个短字段是为卡片头部准备的：主会话里的工具卡只显示「谁、什么状态、第几轮、多久」，
 * 没必要每次都从 `run` 里翻字段；`run` 本身也一并带着，来源徽标 / 工具列表 / 报告 / 停止
 * 这些用到整份记录的地方直接取它，避免把同一个字段抄两遍（抄出来的那份迟早会漂移）。
 */
export interface SubagentDetailData {
  delegationId: string;
  agentName: string;
  status: SubagentRunStatus;
  description: string;
  modelId: string;
  turns: number;
  toolCalls: number;
  /** 已经结束才有：仍在跑的耗时按 run 现算（见 subagentElapsedMs），不在这里钉一个会过期的值 */
  elapsedMs?: number;
  childSessionId: string;
  run: SubagentRun;
  /**
   * 记账调用（TaskWait / TaskList / TaskStop）带回的运行条数。
   *
   * 只有 Task 是「一次委派」，另外三个的 details 是**一批**运行（见契约的 SubagentRunsDetails）。
   * 卡片因此以第一条为主体，但必须把条数带出来 —— 否则一次等了 3 个子智能体的调用会被读成
   * 「只等了一个」，而详情里显示的还是第一个的描述。
   */
  batchSize?: number;
}

/**
 * 运行状态 → 词条键。
 *
 * 用 Record<SubagentRunStatus, …> 而不是带 default 的 switch：这是**穷举**映射，
 * 状态表里加一档时这里会直接是编译错误，而不是悄悄落到一个兜底文案上。
 */
export const SUBAGENT_STATUS_LABEL_KEYS: Record<SubagentRunStatus, string> = {
  running: "rightPanel.subagentRunning",
  completed: "rightPanel.subagentCompleted",
  truncated: "rightPanel.subagentTruncated",
  failed: "rightPanel.subagentFailed",
  aborted: "rightPanel.subagentAborted",
  denied: "rightPanel.subagentDenied",
  // 意外终止：主进程在重启后把没跑完就失联的行降级成它，渲染层只是照实显示
  interrupted: "rightPanel.subagentInterrupted",
};

/** 定义来源 → 词条键；同上，穷举由类型保证 */
export const SUBAGENT_SOURCE_LABEL_KEYS: Record<SubagentSource, string> = {
  builtin: "rightPanel.subagentSourceBuiltin",
  user: "rightPanel.subagentSourceUser",
  temp: "rightPanel.subagentSourceTemp",
};

/**
 * 一次运行最后一次被看见的时刻。
 *
 * 主进程把孤儿行降级成 interrupted 时会把 endedAt 对齐到 updatedAt（最后一次持久化 =
 * 最后活着的时间）；旧记录可能只有 updatedAt，再退到 startedAt，保证调用方永远拿到一个
 * 不会随时间增长的数 —— 终态行上挂着一个会走的钟，读起来就是「还在跑」。
 */
export function subagentLastSeenAt(run: SubagentRun): number {
  return run.endedAt ?? run.updatedAt ?? run.startedAt;
}

/**
 * 运行耗时：终态取最后一次被看见的时刻 - startedAt；仍在跑就按「到此为止」算
 * （面板随事件重渲染，不必自带定时器）。
 *
 * interrupted 的耗时必须**冻结**：它已经不在跑了，若还走 now 兜底，面板上那个秒数会
 * 跟着停留时间一直变大。分支只按状态分：`running` 才允许用 now，其余一律走
 * subagentLastSeenAt（宁可显示 0，也不给一个会增长的读数）。
 */
export function subagentElapsedMs(run: SubagentRun, now: number = Date.now()): number {
  const endedAt =
    run.endedAt ?? (isSubagentRunFinished(run.status) ? subagentLastSeenAt(run) : now);
  return Math.max(0, endedAt - run.startedAt);
}

/**
 * 进度**不再是一个百分比**。
 *
 * 早先这里有 `subagentProgress(run)` = `turns / maxTurns` —— 它依赖 `maxTurns`
 * 那个字段，而该字段已整体删除（见 shared/contracts/subagent.ts 里关于
 * 「为什么没有轮次上限」的说明）。
 *
 * 这个删除同时暴露了原设计的一个问题：**轮次本来就不该被当成进度**。
 * 一个子智能体要跑多少轮是它自己决定的，不是调用方规定的额度 ——
 * `turns / maxTurns` 画出来的「进度条」实际上在说「你已经用掉了多少配额」，
 * 而用户想知道的是「它还在动吗」。
 *
 * 所以现在只报**绝对轮次**（`run.turns`），由调用方按「在跑就转、停下就冻结」
 * 表达状态；`subagentElapsedMs` 提供另一个单调递增的读数（耗时）。
 * 两个都是一直向前走、不需要分母的量。
 */

/** 运行记录 → 展开详情；字段一一对应，不改动任何值 */
function toSubagentDetail(run: SubagentRun): SubagentDetailData {
  return {
    delegationId: run.delegationId,
    agentName: run.agentName,
    status: run.status,
    description: run.description,
    modelId: run.modelId,
    turns: run.turns,
    toolCalls: run.toolCalls,
    ...(run.endedAt === undefined ? {} : { elapsedMs: Math.max(0, run.endedAt - run.startedAt) }),
    childSessionId: run.childSessionId,
    run,
  };
}

/**
 * 后台作业的展开详情。
 *
 * 与子智能体那份的差别：作业的**权威状态**不在工具结果里，而在 store 的
 * `jobsBySession`（主进程持续推 `job-changed`，重启后由 `jobs.list` 补拉）。
 * details 里那份 `job` 只是启动/读取那一刻的快照，所以渲染层优先用 store 里同 id 的那条。
 */
export interface JobDetailData {
  /** 作业 id：渲染层据此去 store 里找权威状态 */
  jobId: string;
  /** 工具结果里的快照（store 里查不到时用它） */
  job: JobInfo;
  /** job_list 的批量：一次列出多个作业时用（单作业工具为 undefined） */
  batch?: readonly JobInfo[];
}

/** details → 作业详情；形状不对返回 null，让调用方退回普通工具行 */
export function parseJobDetail(value: unknown): JobDetailData | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { job?: unknown; jobs?: unknown };
  const single = toJobInfo(record.job);
  if (single !== null) return { jobId: single.id, job: single };
  if (!Array.isArray(record.jobs)) return null;
  const many = record.jobs.map(toJobInfo).filter((job): job is JobInfo => job !== null);
  const first = many[0];
  if (first === undefined) return null;
  // 批量以第一条为主体（pill 显示它），整批挂在 batch 上供展开区列出
  return { jobId: first.id, job: first, batch: many };
}

/** 单个 JobInfo 的最小校验：缺 id/status 就不是作业快照，别硬造 */
function toJobInfo(value: unknown): JobInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<JobInfo>;
  if (typeof record.id !== "string" || record.id === "") return null;
  if (
    record.status !== "running" &&
    record.status !== "exited" &&
    record.status !== "failed" &&
    record.status !== "killed"
  ) {
    return null;
  }
  return record as JobInfo;
}

/**
 * 作业的耗时。
 *
 * 与子智能体同一套规则：**终态必须冻结**在 endedAt 上，只有 running 才允许用 now ——
 * 否则一个早就结束的作业会显示一个一直增长的秒数，那是不真实的。
 * 终态缺 endedAt（记录不全）时退回 startedAt，给出 0 而不是一个会涨的读数。
 */
export function jobElapsedMs(job: JobInfo, now: number = Date.now()): number {
  const endedAt = job.endedAt ?? (job.status === "running" ? now : job.startedAt);
  return Math.max(0, endedAt - job.startedAt);
}
/** 展开面板里用什么渲染结果 */
export type ToolDetail =
  | { kind: "diff"; diff: EditDiff }
  | { kind: "terminal" }
  | { kind: "todo"; items: TodoItem[]; revision?: number }
  | ({ kind: "subagent" } & SubagentDetailData)
  | ({ kind: "job" } & JobDetailData)
  | {
      kind: "web-search";
      sources: WebSource[];
      provider: string;
      truncated: boolean;
      answer?: string;
    }
  | { kind: "web-fetch"; url: string; statusCode: number; title?: string };

/** WebSource 的逐项校验：details 从主进程过来是 unknown，必须自己验 */
function parseWebSources(value: unknown): WebSource[] | null {
  if (!Array.isArray(value)) return null;
  const sources: WebSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const url = item.url;
    if (typeof url !== "string" || url === "") return null;
    const title = item.title;
    const snippet = item.snippet;
    const publishedAt = item.publishedAt;
    if (title !== undefined && typeof title !== "string") return null;
    if (snippet !== undefined && typeof snippet !== "string") return null;
    if (publishedAt !== undefined && typeof publishedAt !== "string") return null;
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return sources;
}

/** web_search 的 details → 卡片数据；形状不对返回 null（落回内置文本面板） */
export function parseWebSearchDetail(
  value: unknown,
): Extract<ToolDetail, { kind: "web-search" }> | null {
  if (!isRecord(value)) return null;
  const sources = parseWebSources(value.sources);
  if (sources === null) return null;
  const provider = typeof value.provider === "string" ? value.provider : "";
  const truncated = value.truncated === true;
  const answer = typeof value.answer === "string" && value.answer !== "" ? value.answer : undefined;
  return {
    kind: "web-search",
    sources,
    provider,
    truncated,
    ...(answer === undefined ? {} : { answer }),
  };
}

/** web_fetch 的 details → 卡片数据 */
export function parseWebFetchDetail(
  value: unknown,
): Extract<ToolDetail, { kind: "web-fetch" }> | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  if (typeof url !== "string" || url === "") return null;
  const statusCode = value.statusCode;
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) return null;
  const title = typeof value.title === "string" && value.title !== "" ? value.title : undefined;
  return { kind: "web-fetch", url, statusCode, ...(title === undefined ? {} : { title }) };
}
/**
 * 选展开面板的渲染方式，并把要用的数据一并解析好。
 *
 * - 失败一律不给详情：`ToolCall` 的收尾标记只有绿勾，报错会被读成成功，改由调用侧走 `ToolFallback`。
 * - Task 系列（委派 / 等待 / 列表 / 停止）的 details 里挂的是那条运行记录：有记录就给子智能体卡片，
 *   没记录（比如「等全部结束」这种不带具体运行的调用）落回内置文本面板。**这道判断必须在
 *   失败闸门之后**：一次启动失败的委派不该显示成一张成功的卡片。
 * - edit 要有能解析出内容的 patch 才算数；解析不出来就当没有详情，让它落回内置的文本面板，
 *   而不是给一个空块。
 * - bash 的输出本身就是内容，直接给终端渲染。
 * - todo 有清单就给 TodoList：优先 details；流式期 details 还没到，退回工具参数里的清单。
 * - grep / glob 的输出本身就是纯文本，交给内置的 Request/Result 面板。
 * - 其余（read / write / 未知工具）没有更贴的组件，保持内置面板。
 */
export function resolveToolDetail(
  toolName: string,
  details: unknown,
  isError?: boolean,
  args?: unknown,
): ToolDetail | null {
  if (isError === true) return null;
  if (SUBAGENT_TOOL_NAMES.includes(toolName)) {
    /**
     * 两种 details 形状都要认：Task 给一条运行记录，TaskWait / TaskList / TaskStop 给一批
     * （{ runs: [...] }）。只认前一种的话后三个永远解析不出来，卡片会静默落回内置文本面板 ——
     * 那正是这段注释最初想避免的结果。
     */
    const single = parseSubagentRun(details);
    if (single !== null) return { kind: "subagent", ...toSubagentDetail(single) };
    const batch = subagentRunsFromDetails(details);
    // 取第一条当主体：上面已经排除了空批量，这里只为满足「下标可能越界」的类型约束
    const first = batch?.[0];
    if (first === undefined) return null;
    return { kind: "subagent", ...toSubagentDetail(first), batchSize: batch?.length ?? 1 };
  }
  /**
   * 后台作业四件套：details 里是 `{ job }`（起 / 读 / 杀）或 `{ jobs }`（列表）。
   *
   * 放在子智能体之后、bash 之前：作业的呈现方式与子智能体同形（状态 pill + 可展开输出），
   * 而与 bash 的关系只是「都能跑命令」—— bash 是同步等待的、结果是文本，
   * 作业是后台跑完的、结果是状态。混用同一张卡片会让「这个到底跑完了没」读不出来。
   */
  if (JOB_TOOL_NAMES.includes(toolName)) {
    const job = parseJobDetail(details);
    return job === null ? null : { kind: "job", ...job };
  }
  if (toolName === "bash") return { kind: "terminal" };
  // details 要等结果回来才有（message-converter 把它映射到 artifact）；工具参数在调用抵达时就有了
  if (toolName === "todo") {
    const todo = parseTodoDetail(details) ?? parseTodoArgs(args);
    return todo === null ? null : { kind: "todo", ...todo };
  }
  /**
   * 网络工具：results 是结构化来源列表（details 里带），比纯文本更适合做卡片 ——
   * 标题可点、hostname 可见、snippet 折叠。
   *
   * 放在 `toolName !== "edit"` 那道硬门**之前**（见下面那行的注释：
   * 新分支必须插在它之前，否则永远走不到）。
   */
  if (toolName === WEB_TOOL_NAMES.search) return parseWebSearchDetail(details);
  if (toolName === WEB_TOOL_NAMES.fetch) return parseWebFetchDetail(details);
  if (toolName !== "edit") return null;

  const patch = detailsPatch(details);
  if (patch === null) return null;
  const diff = toEditDiff(patch);
  return diff === null ? null : { kind: "diff", diff };
}

/** 组内每一步在汇总快照里的形状 */
export interface ToolRow {
  /** 该步在消息 parts 里的下标：各步详情按它取数 */
  partIndex: number;
  name: string;
  chip: string;
  failed: boolean;
}

/**
 * 汇总快照要读的最小字段。刻意用结构类型而不是 PartState：
 * 这个函数要按 token 重算，快照里**不能带 result**——bash 输出上限 256KB，
 * 每步的输出由详情组件在展开时才去读。
 */
export interface ToolPartLike {
  type?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

/** 把一组 part 下标收敛成汇总行的快照 */
export function toolRows(
  parts: readonly (ToolPartLike | undefined)[],
  indices: readonly number[],
): ToolRow[] {
  const rows: ToolRow[] = [];
  for (const index of indices) {
    const part = parts[index];
    if (part?.type !== "tool-call") continue;
    rows.push({
      partIndex: index,
      name: part.toolName ?? "",
      chip: toolChip(part.args),
      failed: part.isError === true,
    });
  }
  return rows;
}
