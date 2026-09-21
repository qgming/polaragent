/**
 * 「本轮文件改动」的纯逻辑：把一段消息里 write / edit 的调用收敛成一组文件卡片数据。
 *
 * 与 session-files.ts 的分工：那边汇总**整个会话**的足迹（给会话面板用，只要路径与次数），
 * 这边只处理**一轮**（一次用户提问到它引发的全部助手消息），而且要带出卡片需要的三件事：
 * 文档类 / 代码类的分流、增删行数、以及给右栏查看器用的绝对路径。
 *
 * 做成纯函数（不碰 React、不碰 store）是为了能在 node project 下直接喂普通对象断言 ——
 * 与 session-files 的 writtenFiles、ToolParts 的 ToolPartLike 同一个口径。
 *
 * **路径的两种形态都要留着**：工具参数里的 path 可能是相对的（模型常写 `src/foo.ts`），
 * 而右栏的文件读取接口只认绝对路径、且必须落在会话工作目录内。所以这里同时给出
 * `path`（原文，用于展示与去重）与 `absolutePath`（拼上 cwd 后的结果，用于打开）。
 * 拼接用纯字符串规则而不是 node:path —— 渲染层不能 import 主进程模块（见 tool-presentation
 * 顶部的同款说明），而这里只需要「相对则前置 cwd」这一条判断。
 */

import { applied, callPath } from "@/renderer/features/session/session-files";
import type { ChatMessage, ChatPart } from "@/shared/contracts/session";

/** 写类工具：write 覆盖整文件、edit 改行。与 main/review/service.ts 的 WRITE_TOOLS 同源 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * 「文档类」扩展名：这些文件的正文本身就是给人读的东西，值得出一张卡片。
 *
 * 代码文件（.ts / .py / …）**刻意不在其中**：它们只出 chip，点开进右栏看源码或 diff。
 * 理由是这样一来卡片区始终很短 —— 一次重构改二十个 .ts 时，卡片区不该变成一面墙，
 * 而那种场景下用户真正想读的往往只有一个 .md。
 *
 * 判据用扩展名而不是 MIME：这里拿不到 MIME（消息里只有路径），而且这一点也不需要
 * 真正的类型探测 —— 它只决定「出不出卡片」，判错的代价是多一张或少一张卡片。
 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "html",
  "htm",
]);

/** 一次改动落在哪个文件上、以及它的展示形态 */
export interface TurnFileChange {
  /** 工具参数里的原始路径（相对或绝对），用作去重键与展示名 */
  path: string;
  /** 拼上会话工作目录后的绝对路径；cwd 缺失时原样保留 path（点开会被主进程拒绝） */
  absolutePath: string;
  /** 文件名（展示用）；解析不出时为整个 path */
  name: string;
  /** 目录部分（相对 cwd 时是相对路径的目录），给卡片上那行小字用；没有目录时为空串 */
  directory: string;
  /** 是否文档类：决定出卡片还是只出 chip */
  isDocument: boolean;
  /** 该文件被改了几次（同一轮里先 write 再 edit 是常态） */
  edits: number;
  /** 最后一次改它的工具名（write / edit） */
  tool: string;
  /** 这几次改动里能解析出的增删合计；解析不出补丁时为 0 */
  additions: number;
  deletions: number;
}

/** 一个回合的文件改动汇总 */
export interface TurnFileSummary {
  /** 全部改动过的文件，按首次出现顺序 */
  files: TurnFileChange[];
  /** 其中的文档类（出卡片的那些） */
  documents: TurnFileChange[];
  /** 去重后的文件数 */
  fileCount: number;
  additions: number;
  deletions: number;
}

/** 空汇总：没有改动时返回同一个常量对象，避免每次渲染都造新引用 */
const EMPTY: TurnFileSummary = {
  files: [],
  documents: [],
  fileCount: 0,
  additions: 0,
  deletions: 0,
};

/** 取小写扩展名；没有扩展名（或以点开头但没有后续字符）时为空串 */
export function extensionOf(path: string): string {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf(".");
  // 前导点（.gitignore）不算扩展名：那是隐藏文件的标记，不是类型
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 路径的最后一段；为空（路径以分隔符结尾）时返回原串 */
export function baseNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments.at(-1) || path;
}

/** 路径的目录部分；没有分隔符时返回空串 */
function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "" : path.slice(0, index);
}

/** 该路径是不是文档类 */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(path));
}

/**
 * 把工具参数里的路径拼成绝对路径。
 *
 * 判据只看「是不是绝对」这一件事，用两条覆盖两个平台：
 *  - POSIX 风格 `/foo`；
 *  - Windows 盘符 `C:\foo` / `C:/foo`（含 UNC 的 `\\server\share`）。
 *
 * 拼接时统一用正斜杠：主进程的 normalizePath 会把它归一成平台分隔符，
 * 而这里再引一套 path.join 只会多一处平台分支。
 */
export function toAbsolutePath(path: string, cwd: string | undefined): string {
  const isAbsolute = path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
  if (isAbsolute) return path;
  if (cwd === undefined || cwd === "") return path;
  const base = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
  return `${base}/${path}`;
}

/** 从工具 details 里取统一 diff 文本；与 main/review/service.ts 的 detailsPatch 同口径 */
function detailsPatch(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const patch = (details as Record<string, unknown>).patch;
  return typeof patch === "string" && patch.trim() !== "" ? patch : null;
}

/**
 * 从统一 diff 里数增删行。
 *
 * 与 main/review/service.ts 的 countLines 同一算法（那边不能 import 渲染层，这边也不能
 * import 主进程，所以是**两份实现**——改判据时两处都要动）。
 *
 * 按位置判文件头：只有在第一个 `@@` 之前出现的 `--- ` / `+++ ` 才是头，
 * 之后的 `+++xxx` 是正文 —— 否则「加了一行 +++」会被算成 +0。
 */
function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

/**
 * 汇总一段消息里的文件改动。
 *
 * `cwd` 来自会话（`SessionSummary.cwd`）：只用来把相对路径拼成绝对路径。
 * 传 undefined 时 `absolutePath` 就等于原始 path —— 那一栏点开会被主进程拒，
 * 但**不该因此不显示卡片**：展示（这一轮改了什么）与打开（能不能读到）是两件事。
 *
 * 顺序按**首次出现**：用户扫这一块时的心智顺序是「这轮先动了什么」，
 * 而不是「哪个文件最后被改」。同一文件改多次只占一张卡，次数累加。
 */
export function summarizeTurnFiles(
  messages: readonly ChatMessage[],
  cwd: string | undefined,
): TurnFileSummary {
  const byPath = new Map<string, TurnFileChange>();
  let additions = 0;
  let deletions = 0;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      if (!WRITE_TOOLS.has(part.toolName)) continue;
      if (!applied(part)) continue;
      const path = callPath(part);
      if (path === null) continue;

      const patch = detailsPatch((part as Extract<ChatPart, { type: "tool-call" }>).details);
      const counted = patch === null ? { additions: 0, deletions: 0 } : countLines(patch);
      additions += counted.additions;
      deletions += counted.deletions;

      const existing = byPath.get(path);
      if (existing === undefined) {
        byPath.set(path, {
          path,
          absolutePath: toAbsolutePath(path, cwd),
          name: baseNameOf(path),
          directory: directoryOf(path),
          isDocument: isDocumentPath(path),
          edits: 1,
          tool: part.toolName,
          additions: counted.additions,
          deletions: counted.deletions,
        });
      } else {
        existing.edits += 1;
        existing.tool = part.toolName;
        existing.additions += counted.additions;
        existing.deletions += counted.deletions;
      }
    }
  }

  if (byPath.size === 0) return EMPTY;
  const files = [...byPath.values()];
  return {
    files,
    documents: files.filter((file) => file.isDocument),
    fileCount: files.length,
    additions,
    deletions,
  };
}

/**
 * 逐回合汇总：`回合最后一条消息 id → 那一回合的文件改动`。
 *
 * **回合的边界是用户消息**：一条用户消息开启新的一回合，其后连续的助手消息都属于它。
 * 这是这个产品里「一轮对话」唯一稳定的定义 —— 助手消息会被工具调用切成好几条相邻消息，
 * 按助手消息切会把一轮对话切成好几块，文件改动就会重复出现在每一块下面。
 *
 * 返回值以**回合最后一条消息的 id** 为键：渲染侧就是「渲染到这条消息之后插入一块」，
 * 不需要再在视图里算一遍边界（那样两处判据一定会漂移）。
 *
 * ## 只收「整轮已经结束」的回合
 *
 * `runFinished` 由调用方给（Thread 从 `runningBySession` 读），**当前这一轮还没结束时
 * 整表为空** —— 一块都不出。
 *
 * 早先这里判的是「这一轮里没有还在跑的工具」（见 isTurnSettled），那是错的：
 * 多步 run 的**步骤与步骤之间**恰好满足「没有工具在跑」—— 模型刚写完文件、正在想下一步时，
 * 那一刻判据为真，块就冒出来；下一步的工具一起来，判据又为假，块又消失。
 * 用户看到的就是「中途闪一下」（用户报的正是这个）。
 *
 * 为什么用 `runningBySession` 而不是轮询消息状态：那是**权威信号** —— 主进程
 * `run-started` / `run-ended` 事件直接写的，覆盖「流式中、等审批、等提问、工具在跑」
 * 全部中间态，而不用去枚举它们的组合。判据只有一个问句：这一轮跑完了吗。
 *
 * 没有改动的回合不入表：调用方用 `map.get(id)` 判空即可，不必再判 `fileCount === 0`。
 * 末尾那条「刚发出、还没有回复」的用户消息不构成回合（切片为空），自然不会出块。
 */
export function turnFileSummaries(
  messages: readonly ChatMessage[],
  cwd: string | undefined,
  runFinished: boolean,
): Map<string, TurnFileSummary> {
  const result = new Map<string, TurnFileSummary>();
  // 这一轮还没结束：任何文件改动都还不算「本轮结果」，一块都不出
  if (!runFinished) return result;

  let start = 0;

  for (let index = 0; index <= messages.length; index += 1) {
    const boundary = index === messages.length || messages[index]?.role === "user";
    if (!boundary) continue;

    if (index > start) {
      const turn = messages.slice(start, index);
      const last = turn.at(-1);
      if (last !== undefined) {
        const summary = summarizeTurnFiles(turn, cwd);
        if (summary.fileCount > 0) result.set(last.id, summary);
      }
    }
    start = index;
  }

  return result;
}

/**
 * 绝对路径 → `file://` URL，供内置浏览器打开本地 HTML。
 *
 * 自己拼而不是用 node 的 `pathToFileURL`：渲染层不能 import 主进程/Node 模块
 *（见 tool-presentation 顶部的同款说明），而这个转换只有三步。
 *
 * 两处细节：
 *  - 反斜杠统一成正斜杠，Windows 的 `D:\a\b.html` 否则会拼出 `file://D:\a\b.html`；
 *  - `#` 与 `?` 必须单独编码 —— 文件名里带这两个字符时会被当成 fragment / query 截掉，
 *    而 `encodeURI` **不会**转义它们（它按 URL 语法认为那是分隔符）。
 */
export function toFileUrl(absolutePath: string): string {
  const posix = absolutePath.replace(/\\/g, "/");
  const rooted = posix.startsWith("/") ? posix : `/${posix}`;
  return `file://${encodeURI(rooted).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/**
 * 一个文件该怎么打开：进右栏的文档查看器，还是交给内置浏览器。
 *
 * HTML **交给浏览器**（用户明确要求）：右栏已经有内置浏览器，本地 HTML 在那里是
 * 真正渲染出来的页面，而应用自己的 CSP 是 `frame-src 'none'`（见 main/app/window.ts），
 * 在查看器里内联渲染它要么被 CSP 拦掉、要么得引一个 sanitize 依赖。
 * 其余文本类（md / txt / 代码）都进查看器 —— 它是给「读一个文件」用的那一个面板。
 */
export type FileOpenTarget = "viewer" | "browser";

export function fileOpenTarget(path: string): FileOpenTarget {
  const extension = extensionOf(path);
  return extension === "html" || extension === "htm" ? "browser" : "viewer";
}

/**
 * 该文件在查看器里有没有「渲染」这一档。
 *
 * 只有 markdown 家族有：它们按源码读是 `## 标题` / `| 表 |`，按渲染读才是文档。
 * 其余一律只有源码一档 —— 给一个点了没变化的切换按钮比不给更糟。
 */
export function hasRenderedMode(path: string): boolean {
  const extension = extensionOf(path);
  return extension === "md" || extension === "markdown" || extension === "mdx";
}
