/**
 * 工具调用的纯逻辑层：参数、输出、补丁 → 官方 Elements 组件的入参。
 *
 * 与渲染分开是为了能测：本仓库的 vitest 是 node 环境且只收 `*.test.ts`，
 * 组件渲染没有测试设施，这里把容易出错的部分（补丁映射、行数截断）留在可测的纯函数里。
 * 需要 i18n 的部分（省略提示、动词）留在 ToolParts.tsx。
 */

import type { DiffLine } from "@/renderer/components/assistant-ui/elements/code-diff";
import type { TodoItem } from "@/renderer/components/assistant-ui/elements/todo-list";
import { parsePatch } from "@/renderer/components/ui/diff-viewer";

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

/** 展开面板里用什么渲染结果 */
export type ToolDetail =
  | { kind: "diff"; diff: EditDiff }
  | { kind: "terminal" }
  | { kind: "todo"; items: TodoItem[]; revision?: number };

/**
 * 选展开面板的渲染方式，并把要用的数据一并解析好。
 *
 * - 失败一律不给详情：`ToolCall` 的收尾标记只有绿勾，报错会被读成成功，改由调用侧走 `ToolFallback`。
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
  if (toolName === "bash") return { kind: "terminal" };
  // details 要等结果回来才有（message-converter 把它映射到 artifact）；工具参数在调用抵达时就有了
  if (toolName === "todo") {
    const todo = parseTodoDetail(details) ?? parseTodoArgs(args);
    return todo === null ? null : { kind: "todo", ...todo };
  }
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
