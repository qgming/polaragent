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
import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import type { AskAnswerItem, AskOutcome, AskQuestion } from "@/shared/contracts/interaction";
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

/**
 * 空结果时的一句话。
 *
 * 「没有匹配」「文件是空的」本身就是答案 —— 给一个纯白面板会让人以为界面坏了。
 */
const EMPTY_RESULT_HINT = "（没有内容）";

/**
 * 浏览器工具名的取值集合。
 *
 * 从 `BROWSER_TOOL_NAMES` 的对象值里推出来（那个常量是工具名与权限表共用的唯一来源），
 * 而不是在渲染层再抄一份字面量数组 —— 抄一份就会在加工具时漏改。
 */
const BROWSER_TOOL_NAMES_VALUES: readonly string[] = Object.values(BROWSER_TOOL_NAMES);

/** 提问的工具名。与主进程 tools/ask.ts 的 ASK_TOOL_NAME 同一个字面量（渲染层不 import 主进程） */
const ASK_TOOL_NAME = "ask_user";

/**
 * 读图片的工具名。同样是字面量（渲染层不 import 主进程，理由见上面 JOB_TOOL_NAMES）。
 *
 * 与主进程 tools/read-image.ts 的 READ_IMAGE_TOOL_NAME 一一对应，改名时两边都要动。
 */
export const READ_IMAGE_TOOL_NAME = "read_image";

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
 * 落定的作业状态是不是**终态**。
 *
 * 与子智能体那边 `isSubagentRunFinished` 同一个用途：主进程的作业表里只有 `running`
 * 是活的，另外三种都是终态。这里刻意不写成 `status !== "running"` 的取反，
 * 而是用穷举式的正向判断 —— 契约里加一档状态时，这里是编译错误而不是「新状态被当成终态」。
 */
export function isJobFinished(status: JobInfo["status"]): boolean {
  switch (status) {
    case "running":
      return false;
    case "exited":
    case "failed":
    case "killed":
      return true;
  }
}

/**
 * 同一作业 id 的两份记录谁更可信。
 *
 * ## 为什么需要它（这条是一个真实缺陷的根治点）
 *
 * 一条作业有**两份**数据源，而它们的新旧并不一致：
 *
 * 1. 磁盘转录里的 `details`（`bash_background` 落盘的那份快照）—— 它停在**启动那一刻**，
 *    写着 `status: "running"`、`totalBytes: 0`、没有 `endedAt`。此后永不更新，
 *    除非进程退出时主进程把结论回填到内存里那条 part 上（而回填**不落盘**）。
 * 2. store 的 `jobsBySession`（`job-changed` 事件 + `jobs.list` 补拉）—— 它始终是最新的，
 *    但**只在内存里**：进程退出后重建会话时，主进程的作业表已经空了，`jobs.list` 返回 `[]`。
 *
 * 于是「重启应用 → 打开一个跑过作业的历史会话」这条路会同时丢掉两边：
 * store 里没有这条作业（主进程表已清空），转录里那份快照又永远写着 running ——
 * 界面于是**永远显示「运行中」**，而那条命令其实早就退出了。
 *
 * 判据因此不能是「谁后到」，只能是**状态本身的确定性**：终态是既成事实（进程已经没了，
 * 不可能再变），running 是一条随时会被推翻的陈旧断言。所以终态一律胜过 running，
 * 与到达顺序、数据来源都无关。
 *
 * 两份都是 running、或两份都是终态时，取 `incoming`（调用方保证它来自更新的那一侧）。
 */
export function preferJobStatus(existing: JobInfo, incoming: JobInfo): JobInfo {
  if (isJobFinished(existing.status) && !isJobFinished(incoming.status)) return existing;
  return incoming;
}

/**
 * 两份记录是不是**同一次运行**。
 *
 * 只比 id 是不够的：作业 id 是主进程内从 1 起的自增序号（`job-1`、`job-2` ……），
 * **每次重启应用都从头数**（见 main/pisdk/jobs.ts 的 nextJobNumber）。于是同一个会话里
 * 完全可能出现「转录里那条上次进程留下的 job-1」与「本次进程新起的 job-1」并存 ——
 * 只按 id 认人，旧 pill 会显示成新作业的状态（一个早就结束的作业看起来又在跑）。
 * `startedAt` 是同一次运行的出生时间，两边都由作业服务在 start 那一刻写下，因此可以当身份用。
 *
 * 认不出身份时**当作不匹配**：宁可退回「这条历史作业已结束」，也不要拿另一个进程的
 * 同名作业给它盖章。
 */
export function sameJobRun(
  a: Pick<JobInfo, "id" | "startedAt">,
  b: Pick<JobInfo, "id" | "startedAt">,
): boolean {
  return a.id === b.id && a.startedAt === b.startedAt;
}

/**
 * 把 store 里同 id 的权威记录并到快照上。
 *
 * `live === undefined`（store 里没有这条作业）时**原样返回快照**：那种情况下快照是唯一的
 * 依据，但对一条早已结束的历史作业来说它恰恰是最不可信的一份 —— 这一档因此交给
 * `reconciled` 判定（见 resolveJobView），不要在这里编一个状态。
 */
export function mergeJobSnapshot(snapshot: JobInfo, live: JobInfo | undefined): JobInfo {
  if (live === undefined) return snapshot;
  return preferJobStatus(snapshot, live);
}

/**
 * 界面最终该显示的那条作业记录。
 *
 * 三档，按可信度从高到低：
 *
 * 1. **对过账、且权威列表里没有它** → 这条作业已经不在主进程的作业表里了
 *    （进程退出后重启、或被上限淘汰）。它是历史，不可能还在跑；而快照里那份
 *    running 是启动那一刻的死数据。既然无从知道它究竟怎么结束的，
 *    就**按「已结束」呈现**。这与子智能体把未确认的 running 降级成 interrupted 同一条纪律：
 *    「确认不了它还在跑」绝不能显示成「还在跑」。
 *
 *    这里把 `endedAt` **留空**而不是补一个 startedAt：补出来的会让耗时读数是「0s」，
 *    而那个 0 是编的 —— 它读起来像「它瞬间就结束了」，与事实（我们不知道它跑了多久）
 *    不符。留空则走 jobElapsedMs 的「终态缺 endedAt → 0」那一档，同样不显示会增长的读数，
 *    但语义上是「不知道」而不是「零」。
 *
 * 2. store 里有它 → 用 `preferJobStatus` 合并（终态胜过 running）。
 *
 * 3. 还没对过账（`reconciled === false`）→ 原样用快照。启动那一瞬间 `jobs.list` 还在飞，
 *    此时把每条 running 都判成已结束只会闪一屏假的终态。
 */
export function resolveJobView(
  snapshot: JobInfo,
  live: JobInfo | undefined,
  reconciled: boolean,
): JobInfo {
  if (live !== undefined) return mergeJobSnapshot(snapshot, live);
  // 没对过账：无权下结论，快照说什么就是什么
  if (!reconciled) return snapshot;
  if (isJobFinished(snapshot.status)) return snapshot;
  // 对过账、权威列表里没有、快照却还写着 running → 陈旧断言，按已结束呈现。
  // endedAt 只在快照本来就有的时候才带上，绝不编一个（见上面第 1 条）
  return {
    ...snapshot,
    status: "exited",
    ...(snapshot.endedAt === undefined ? {} : { endedAt: snapshot.endedAt }),
  };
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

/**
 * pill 上该显示的耗时（毫秒）；**不知道时返回 undefined，调用方据此不显示读数**。
 *
 * 与 jobElapsedMs 的分工：那个只管「算出一个不会随时间增长的数」，所以终态缺 endedAt 时
 * 必须退回 0 才安全。但 0 画到界面上是 `0s` —— 那读起来是「它瞬间就结束了」，
 * 而真正的情况是**我们不知道它跑了多久**（作业表已经清了、转录里那份快照停在启动那一刻）。
 * 一个编出来的 0 与一个会增长的秒数一样不真实，只是方向相反：宁可什么都不说。
 *
 * running 一定有读数（它正在流逝）；终态只在**有 endedAt** 时才有读数 ——
 * 那正是「它什么时候结束的」这个事实被记录下来的标志。
 */
export function jobElapsedReading(job: JobInfo, now: number = Date.now()): number | undefined {
  if (job.status !== "running" && job.endedAt === undefined) return undefined;
  return jobElapsedMs(job, now);
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
  | { kind: "web-fetch"; url: string; statusCode: number; title?: string }
  /** 提问：模型问了什么、用户答了什么（见 parseAskDetail） */
  | AskDetailData
  /** 文本类工具（read / grep / glob / 报错 / 兜底）：正文原样展示 */
  | TextDetailData
  /** 写入：文件路径 + 规模 + 正文预览（write 的 details 是 undefined） */
  | WriteDetailData
  /** 浏览器工具的通用结果：tab 身份 + 读数行 + 条目列表 */
  | BrowserDetailData
  /** 图片：路径 + 读数 + 按需加载的图片本体（见 parseImageDetail） */
  | ImageDetailData;

/**
 * 图片详情：一次 read_image 调用的读数。
 *
 * **刻意不含图片字节**：工具 details 会随 part 落盘（见 main/pisdk/tools/read-image.ts
 * 的文件头），把几 MB 的图塞进去等于每读一张就往会话库里写一份 base64。
 * 界面展开时用 `files.readImage` 按 path 现取一次（见 ImageDetail 组件）。
 */
export interface ImageDetailData {
  kind: "image";
  /** 绝对路径（主进程解析后的；按它去读图片） */
  path: string;
  mediaType: string;
  bytes: number;
  /** 像素尺寸；头部解析不出来时缺省 —— 界面据此不显示尺寸，而不是显示编的 */
  width?: number;
  height?: number;
}

/**
 * read_image 的 details → 图片详情。
 *
 * 形状不对返回 null，让调用方退回文本详情（结果里的信封文本仍能读到路径与读数）——
 * 与其它 parse* 同一条纪律：details 从主进程过来是 unknown，必须自己验。
 *
 * `path` 是必需的：没有它就无法去读图片，而一张显示不出来的图详情没有意义。
 */
export function parseImageDetail(value: unknown): ImageDetailData | null {
  if (!isRecord(value)) return null;
  const image = value.image;
  if (!isRecord(image)) return null;

  const path = image.path;
  if (typeof path !== "string" || path === "") return null;
  const mediaType = image.mediaType;
  if (typeof mediaType !== "string" || mediaType === "") return null;
  const bytes = image.bytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;

  // 尺寸是可选读数：读不出来时只是不显示，不该因此丢掉整张卡
  const width = typeof image.width === "number" && image.width > 0 ? image.width : undefined;
  const height = typeof image.height === "number" && image.height > 0 ? image.height : undefined;

  return {
    kind: "image",
    path,
    mediaType,
    bytes,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/**
 * 提问详情：一次 ask_user 调用的问题与答案。
 *
 * `questions` 与 `answers` 按 `questionId` 配对后交给界面渲染 —— 配对放在这里而不是组件里，
 * 是因为「哪道题答了什么」是纯逻辑，而组件里做配对会让它没法被单测覆盖。
 */
export interface AskDetailData {
  kind: "ask";
  outcome: AskOutcome;
  questions: AskQuestion[];
  /** 每题的作答；未作答的题也会有一条（selected 为空数组） */
  answers: AskAnswerItem[];
}

/**
 * 文本类详情：工具的正文就是内容。
 *
 * `header` 是工具自己拼在结果首行的那句（如 `tab t2` 或检索根），`footer` 是尾注
 * （分页提示、省略说明）—— 两者都要与正文分开渲染：尾注是**元信息**不是内容，
 * 混在正文里会让用户以为文件真的长那样（read 的 `[Showing lines …]` 就是典型）。
 */
export interface TextDetailData {
  kind: "text";
  body: string;
  /**
   * 尾注（分页提示、省略说明、`[exited with code N]`）。
   *
   * 与正文分开渲染：它是**元信息**不是内容 —— 混在正文里会让人以为文件真的长那样
   *（read 的 `[Showing lines …]` 就是典型）。
   */
  footer?: string;
  /** 结果为空（没有匹配、空文件）时给一句说明，避免渲染一个空白面板 */
  emptyText?: string;
}

/** 写入详情：write 的 details 是 undefined，只能从参数与结果里取 */
export interface WriteDetailData {
  kind: "write";
  path: string;
  /** 写入的字符数；拿不到时 undefined（不编造一个 0） */
  bytes?: number;
  /** 写入的正文预览（前若干行，给「我到底写了什么」一个落点） */
  preview?: string;
}

/** 浏览器工具的详情：tab 身份 + 键值行 + 可选的条目列表 */
export interface BrowserDetailData {
  kind: "browser";
  /** 形如 "t2"；缺省表示这次调用没有指定标签（工具会在正文里说明） */
  tabId?: string;
  /** 摘要行：角色 + 名字（如 `button · 提交`），或状态、数量这类读数 */
  fields: { label: string; value: string }[];
  /** 逐条内容（快照的元素清单、控制台日志、网络记录） */
  entries?: { kind?: "info" | "error"; text: string }[];
  /** 列表被截断时的一句说明 */
  omittedText?: string;
  /** 结果正文（浏览器工具的结果本身就是给人看的文本，原样保留一份） */
  body?: string;
}

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
 * ask_user 的 details → 提问详情。
 *
 * 这是**唯一**一次把「模型问了什么、用户答了什么」拿出来给人看的地方：提问卡在提交后
 * 就从消息流里撤掉了（见 chat-store 的 ask-resolved），会话里只剩这条工具行。
 * 所以解析必须宽容到「哪怕 outcome 缺失也要能显示出题面」—— 出题是用户最想回看的东西，
 * 不该因为一个字段的类型不对就整块不显示。
 *
 * `questions` 是必需项（没有题面就没有可显示的内容）；`answers` 缺失时按「全都没作答」处理，
 * 而不是返回 null：超时 / 取消两种收尾本来就没有作答。
 */
export function parseAskDetail(value: unknown): AskDetailData | null {
  if (!isRecord(value)) return null;

  const rawQuestions = value.questions;
  if (!Array.isArray(rawQuestions)) return null;

  const questions: AskQuestion[] = [];
  for (const item of rawQuestions) {
    if (!isRecord(item)) continue;
    const { id, header, question, options, multiSelect } = item;
    if (typeof id !== "string" || id === "") continue;
    if (typeof question !== "string" || question === "") continue;
    const label = typeof header === "string" && header !== "" ? header : question;
    const list =
      Array.isArray(options) && options.every((option) => typeof option === "string")
        ? (options as string[])
        : undefined;
    questions.push({
      id,
      header: label,
      question,
      ...(list === undefined ? {} : { options: list }),
      ...(multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  // 一道题都没解析出来：没有可显示的内容，让调用方退回通用文本面板
  if (questions.length === 0) return null;

  const answers: AskAnswerItem[] = [];
  if (Array.isArray(value.answers)) {
    for (const item of value.answers) {
      if (!isRecord(item)) continue;
      const { questionId, selected, text } = item;
      if (typeof questionId !== "string" || questionId === "") continue;
      const picked = Array.isArray(selected)
        ? selected.filter((option): option is string => typeof option === "string")
        : [];
      const free = typeof text === "string" && text.trim() !== "" ? text : undefined;
      answers.push({
        questionId,
        selected: picked,
        ...(free === undefined ? {} : { text: free }),
      });
    }
  }

  const outcome: AskOutcome =
    value.outcome === "answered" || value.outcome === "unanswered" || value.outcome === "cancelled"
      ? value.outcome
      : "answered";

  return { kind: "ask", outcome, questions, answers };
}

/**
 * 把工具结果文本拆成 body / footer 两段。
 *
 * 依据是**本仓库所有文本类工具共同的结果形状**：正文若干行，末尾是可选的方括号尾注
 *（`[Showing lines 1-50 of 200. Use offset=51 …]`、`[exited with code 0]`）。
 *
 * 判据取「以 `[` 开头且以 `]` 结尾的整行」而不是正则匹配具体文案：尾注的措辞由内核与
 * 各工具自己写（read 的两种、grep/glob 的 limit 说明、bash 的 fullOutputPath），
 * 逐条匹配文案会在内核改一个字之后静默失效。方括号整行是它们共同的形态。
 *
 * **刻意不切「首行当 header」**。那是第一版的写法，判据是「多行结果的首行是身份行」——
 * 实测下它错得离谱：read 的首行是第一个行号行、grep 的是第一条命中、glob 的是第一个路径，
 * 全都被当成身份行从正文里摘了出去。真正有身份行的只有浏览器工具（`tab t2`），
 * 而它们现在走 BrowserDetail（tabId 从 details 里结构化取），不需要这条通用启发式。
 */
export function splitToolText(text: string): { body: string; footer?: string } {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed === "") return { body: "" };

  const lines = trimmed.split("\n");

  // 尾注：从末尾往前收集连续的方括号行（有的结果会连写两行）
  let end = lines.length;
  const footer: string[] = [];
  while (end > 0) {
    const line = (lines[end - 1] ?? "").trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      footer.unshift(lines[end - 1] ?? "");
      end -= 1;
      continue;
    }
    break;
  }

  return {
    // 收掉尾注前那个空行：内核统一用 "\n\n[…]" 分隔正文与尾注，
    // 留着会在正文末尾多出一条空白（正文与尾注之间本来就有分隔线）
    body: lines.slice(0, end).join("\n").replace(/\n+$/, ""),
    ...(footer.length === 0 ? {} : { footer: footer.join("\n") }),
  };
}

/**
 * 文本类工具的详情：结果文本拆成正文与尾注。
 *
 * 失败态也会走到这里（见 resolveToolDetail）：报错文本本身就是内容，
 * 而 `Error: …` 那一行常常多行成段 —— 旧的 Request/Result 面板把换行压平之后，
 * 最需要读的那段反而糊成了一整行。
 */
export function parseTextDetail(result: unknown, emptyText?: string): TextDetailData | null {
  const text = toolResultText(result);
  if (text === "") {
    return emptyText === undefined ? null : { kind: "text", body: "", emptyText };
  }
  const split = splitToolText(text);
  return {
    kind: "text",
    body: split.body,
    ...(split.footer === undefined ? {} : { footer: split.footer }),
    ...(emptyText === undefined ? {} : { emptyText }),
  };
}

/**
 * write 的参数 → 详情：路径是必填，正文从参数里取。
 *
 * **刻意不接收 result**：内核对 write 只回一句 `Successfully wrote to <path>`（没有字节数），
 * 唯一有内容的来源就是参数里的 `content`。多收一个用不上的参数只会让调用方以为它在起作用。
 */
export function parseWriteDetail(args: unknown): WriteDetailData | null {
  if (!isRecord(args)) return null;
  const path = typeof args.path === "string" && args.path !== "" ? args.path : null;
  if (path === null) return null;

  const content = typeof args.content === "string" ? args.content : undefined;
  // 结果里的字节数：内核对 write 只回 "Successfully wrote to <path>"（没有数字），
  // 所以这里按**参数的正文长度**给规模，并明确它是字符数而不是磁盘字节数
  const bytes = content === undefined ? undefined : content.length;

  return {
    kind: "write",
    path,
    ...(bytes === undefined ? {} : { bytes }),
    ...(content === undefined ? {} : { preview: content.slice(0, 4000) }),
  };
}

/**
 * 浏览器工具的详情：把 details 里的结构化读数摊平成「标签 + 值」行。
 *
 * 每个工具的 details 形状都不同（open 给页面状态、snapshot 给快照、logs 给日志报告……），
 * 逐个写一套组件会让这九个工具各有一张卡，而它们的**共同点**是「这次调用读到了什么」。
 * 所以这里做一次通用摊平：已知形状给专门的字段名，其余按原字段名直出 ——
 * 结果是「至少不会什么都没显示」，而不是「认不出就什么都不显示」（这正是当前的毛病）。
 *
 * 快照的元素清单、控制台日志、网络记录这三类**有列表价值**的进 entries，
 * 其余进 fields。列表上限与对话流里的其它详情一致：长了内部滚动，不把消息撑爆。
 */
export function parseBrowserDetail(
  toolName: string,
  details: unknown,
  result: unknown,
): BrowserDetailData | null {
  const fields: BrowserDetailData["fields"] = [];
  const entries: BrowserDetailData["entries"] = [];
  let omittedText: string | undefined;
  let tabId: string | undefined;

  const record = isRecord(details) ? details : null;

  // tab 身份：九个浏览器的 details 都带 tabId（或 state.tabId）
  if (record !== null) {
    if (typeof record.tabId === "string" && record.tabId !== "") tabId = record.tabId;
  }

  if (toolName === BROWSER_TOOL_NAMES.snapshot && record !== null) {
    // 快照：可见文本 + 可交互元素清单
    if (typeof record.url === "string" && record.url !== "") {
      fields.push({ label: "url", value: record.url });
    }
    if (typeof record.title === "string" && record.title !== "") {
      fields.push({ label: "title", value: record.title });
    }
    if (Array.isArray(record.elements)) {
      for (const element of record.elements) {
        if (!isRecord(element)) continue;
        const ref = typeof element.ref === "string" ? element.ref : "";
        const role = typeof element.role === "string" ? element.role : "";
        const name = typeof element.name === "string" ? element.name : "";
        const value = typeof element.value === "string" ? element.value : "";
        const head = [ref, role].filter((piece) => piece !== "").join(" ");
        const tail = value === "" ? name : `${name} = ${value}`;
        entries.push({ text: [head, tail].filter((piece) => piece !== "").join("  ") });
      }
    }
    // 被截断的条数必须说出来：不说的话「页面就这么多」是错误的结论
    if (isRecord(record.omitted)) {
      const parts: string[] = [];
      if (typeof record.omitted.elements === "number" && record.omitted.elements > 0) {
        parts.push(`${record.omitted.elements} elements`);
      }
      if (typeof record.omitted.textChars === "number" && record.omitted.textChars > 0) {
        parts.push(`${record.omitted.textChars} chars`);
      }
      if (parts.length > 0) omittedText = `omitted: ${parts.join(", ")}`;
    }
    if (typeof record.text === "string" && record.text.trim() !== "") {
      // 可见文本进 body（它是大段正文，不适合按「标签: 值」渲染）
    }
  } else if (toolName === BROWSER_TOOL_NAMES.logs && record !== null) {
    if (Array.isArray(record.entries)) {
      for (const entry of record.entries) {
        if (!isRecord(entry)) continue;
        const level = typeof entry.level === "string" ? entry.level : "";
        const text = typeof entry.text === "string" ? entry.text : "";
        const source = typeof entry.source === "string" ? entry.source : "";
        const line = typeof entry.line === "number" ? `:${entry.line}` : "";
        const where = source === "" ? "" : ` (${source}${line})`;
        entries.push({
          kind: level === "error" ? "error" : "info",
          text: `${level} ${text}${where}`.trim(),
        });
      }
    }
    if (typeof record.dropped === "number" && record.dropped > 0) {
      omittedText = `${record.dropped} filtered out`;
    }
    if (typeof record.total === "number")
      fields.push({ label: "total", value: String(record.total) });
    if (typeof record.truncated === "boolean") {
      fields.push({ label: "truncated", value: String(record.truncated) });
    }
  } else if (toolName === BROWSER_TOOL_NAMES.evaluate && record !== null) {
    if (record.ok === true) {
      const value = typeof record.value === "string" ? record.value : "";
      fields.push({ label: "result", value: value === "" ? "(no value)" : value });
    } else if (typeof record.error === "string") {
      entries.push({ kind: "error", text: record.error });
    }
  } else if (toolName === BROWSER_TOOL_NAMES.screenshot && record !== null) {
    if (typeof record.width === "number" && typeof record.height === "number") {
      fields.push({ label: "viewport", value: `${record.width}×${record.height}` });
    }
  } else if (toolName === BROWSER_TOOL_NAMES.wait && record !== null) {
    if (typeof record.matched === "boolean") {
      fields.push({ label: "matched", value: String(record.matched) });
    }
    if (typeof record.waitedMs === "number") {
      fields.push({ label: "waited", value: `${record.waitedMs}ms` });
    }
    if (typeof record.detail === "string" && record.detail !== "") {
      fields.push({ label: "detail", value: record.detail });
    }
  } else if (toolName === BROWSER_TOOL_NAMES.act && record !== null) {
    // 动作回执：点了哪个元素、名字是什么、页面有没有跳走
    if (typeof record.ref === "string" && record.ref !== "") {
      fields.push({ label: "ref", value: record.ref });
    }
    if (typeof record.name === "string" && record.name !== "") {
      fields.push({ label: "name", value: record.name });
    }
    if (typeof record.navigated === "boolean") {
      fields.push({ label: "navigated", value: String(record.navigated) });
    }
    if (typeof record.effect === "string" && record.effect !== "") {
      fields.push({ label: "effect", value: record.effect });
    }
  } else if (toolName === BROWSER_TOOL_NAMES.dialog && record !== null) {
    if (isRecord(record.policy) && typeof record.policy.action === "string") {
      fields.push({ label: "policy", value: record.policy.action });
    }
    if (typeof record.handledSinceLastRead === "number") {
      fields.push({ label: "handled", value: String(record.handledSinceLastRead) });
    }
  } else if (record !== null) {
    /**
     * 剩下的（open / history，以及将来新增的浏览器工具）：按原字段名直出。
     * 通用兜底在这儿是**刻意**的 —— 认不出的形状也要显示出来，
     * 而不是像现在这样落回一个「Request/Result」的空壳。
     * `state` 是 open/history 的嵌套对象，摊平一层（值是原始类型才收）。
     */
    const source = isRecord(record.state) ? { ...record, ...record.state } : record;
    for (const [key, value] of Object.entries(source)) {
      if (key === "state" || key === "tabId") continue;
      if (value === undefined || value === null) continue;
      if (typeof value === "object") continue;
      fields.push({ label: key, value: String(value) });
    }
  }

  /**
   * 结果正文：浏览器工具的结果本身就是给人看的（tab 行 + 格式化正文），
   * 详情里已经有结构化读数时它仍然值得留一份 —— 两份是**互补**的，
   * 读数答「发生了什么」，正文答「原文长什么样」。
   */
  const body = toolResultText(result);

  /**
   * 四样里任何一样有内容就给详情。
   *
   * `omittedText` **必须算进来**：一份「元素全被截断、正文也被截断」的快照可能
   * 一个字段一个条目都没有，只剩这句「省略了多少」—— 而那句话恰恰是唯一的信息
   *（不说的话，读到的就是「页面就这么多」这个错误结论）。
   */
  if (fields.length === 0 && entries.length === 0 && body === "" && omittedText === undefined) {
    return null;
  }

  return {
    kind: "browser",
    ...(tabId === undefined ? {} : { tabId }),
    fields,
    ...(entries.length === 0 ? {} : { entries }),
    ...(omittedText === undefined ? {} : { omittedText }),
    ...(body === "" ? {} : { body }),
  };
}
/**
 * 选展开面板的渲染方式，并把要用的数据一并解析好。
 *
 * ## 失败不再一律取消详情（这条是这次改动最要紧的一处）
 *
 * 早先第一行是 `if (isError) return null`，于是**失败的工具恰恰没有详情** ——
 * 而失败输出的多行特征最强（栈、编译错误、命中列表），落到那个不保留换行的文本面板上
 * 就被压成一整行。现在失败走「文本详情」这条路：报错文本本身就是内容，
 * 交给 TextDetail 按原文渲染（保留换行、等宽）。
 *
 * 少数工具失败时仍然没有结构化读数可给（比如 edit 没有 patch），于是退回文本详情 ——
 * 那正是想要的兜底，而不再是「什么都没有」。
 *
 * ## 顺序
 *
 * 1. 子智能体四件套 → 状态 pill（形状与工具行差太远，连 ToolCall 都不进）
 * 2. 后台作业四件套 → 状态 pill（同上）
 * 3. ask_user → 问题与作答（会话里唯一还能回看答案的地方）
 * 4. bash / edit / todo / web_* → 各自的专属详情
 * 5. 浏览器九件套 → 通用「读数 + 条目」详情
 * 6. read / write / grep / glob / 及其余 → 文本详情（read 额外给文件头）
 *
 * 最后那条兜底是这次改动的另一半：**未知工具也给文本详情**，不再落回那个
 * Request/Result 面板。那个面板已经被删掉了（见 tool-call.tsx）。
 */
export function resolveToolDetail(
  toolName: string,
  details: unknown,
  isError?: boolean,
  args?: unknown,
  result?: unknown,
): ToolDetail | null {
  const failed = isError === true;

  if (SUBAGENT_TOOL_NAMES.includes(toolName)) {
    /**
     * 两种 details 形状都要认：Task 给一条运行记录，TaskWait / TaskList / TaskStop 给一批
     * （{ runs: [...] }）。只认前一种的话后三个永远解析不出来，卡片会静默落回文本面板。
     * 失败态不给卡片：一次启动失败的委派显示成「运行中」比显示成错误更糟。
     */
    if (failed) return parseTextDetail(result);
    const single = parseSubagentRun(details);
    if (single !== null) return { kind: "subagent", ...toSubagentDetail(single) };
    const batch = subagentRunsFromDetails(details);
    // 取第一条当主体：上面已经排除了空批量，这里只为满足「下标可能越界」的类型约束
    const first = batch?.[0];
    if (first === undefined) return parseTextDetail(result);
    return { kind: "subagent", ...toSubagentDetail(first), batchSize: batch?.length ?? 1 };
  }

  /**
   * 后台作业四件套：details 里是 `{ job }`（起 / 读 / 杀）或 `{ jobs }`（列表）。
   *
   * 作业的详情**不看失败闸门**：作业失败本身就是这颗 pill 要显示的结论，
   * 藏起来反而看不出「它跑挂了」。调用侧（ToolCallPart）对作业另开一条分支取它。
   */
  if (JOB_TOOL_NAMES.includes(toolName)) {
    const job = parseJobDetail(details);
    return job === null ? null : { kind: "job", ...job };
  }

  /**
   * 提问：**失败也要给**。ask_user 一般不会失败（超时/取消都走成功结果 + outcome），
   * 但真的出错时至少要能看到问的是什么 —— 那是用户唯一能回看题面的地方。
   */
  if (toolName === ASK_TOOL_NAME) {
    const ask = parseAskDetail(details);
    if (ask !== null) return ask;
    return parseTextDetail(result);
  }

  if (toolName === "bash") return { kind: "terminal" };

  /**
   * 读图片：详情就是**那张图**（用户明确要求「点开就是显示图片」）。
   *
   * 失败时给文本详情而不是图片卡：读不出来时结果文本里写着原因
   *（格式不支持 / 太大 / 路径越界），那才是用户要看的东西 —— 摆一张空图框更糟。
   */
  if (toolName === READ_IMAGE_TOOL_NAME) {
    const image = failed ? null : parseImageDetail(details);
    return image ?? parseTextDetail(result);
  }

  if (toolName === "todo") {
    // details 要等结果回来才有；工具参数在调用抵达时就有了（流式期靠它兜底）
    const todo = parseTodoDetail(details) ?? parseTodoArgs(args);
    return todo === null ? parseTextDetail(result) : { kind: "todo", ...todo };
  }

  if (toolName === WEB_TOOL_NAMES.search) {
    return failed ? parseTextDetail(result) : parseWebSearchDetail(details);
  }
  if (toolName === WEB_TOOL_NAMES.fetch) {
    return failed ? parseTextDetail(result) : parseWebFetchDetail(details);
  }

  if (toolName === "edit") {
    const patch = failed ? null : detailsPatch(details);
    const diff = patch === null ? null : toEditDiff(patch);
    // 失败、或补丁解析不出来：退回文本详情（结果文本里写着为什么失败）
    return diff === null ? parseTextDetail(result) : { kind: "diff", diff };
  }

  /**
   * 浏览器九件套：通用读数 + 条目。
   *
   * 放在文本详情**之前**：这些工具的 details 里有 tab 身份、元素清单、日志条目这类
   * 比纯文本更好读的东西。放在通用兜底之后它们就永远走不到了。
   */
  if (BROWSER_TOOL_NAMES_VALUES.includes(toolName)) {
    const browser = parseBrowserDetail(toolName, details, result);
    return browser ?? parseTextDetail(result);
  }

  // write：details 是 undefined，只能从参数里取路径与正文
  if (toolName === "write") {
    const write = parseWriteDetail(args);
    if (write !== null) return write;
    return parseTextDetail(result);
  }

  /**
   * 兜底：read / grep / glob / MCP 工具 / 将来新增的一切。
   *
   * 这就是「不再有 Request/Result 面板」的落点 —— 认不出形状的工具也能看到**原文**，
   * 而不是一个把换行压平的转储框。`emptyText` 给空结果一句说明，
   * 免得渲染一个纯白面板（「没有匹配」本身就是答案，值得说出来）。
   */
  return parseTextDetail(result, EMPTY_RESULT_HINT);
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
