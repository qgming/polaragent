// 右侧面板「审查」的主进程实现：把一次会话里 write / edit 的改动汇总成可渲染的清单。
//
// 数据来源是**会话消息**，不是 git 工作树：仓库没有 git 集成，而模型每次写文件都会把
// patch 放进工具结果（edit 的 details.patch、write 的内容），那份记录与会话一一对应，
// 是「这次对话把项目改成了什么样」最直接的答案（见 shared/contracts/review.ts 的取舍说明）。
//
// 与渲染层的分工：patch 的解析（parse-diff）留在渲染层，因为 DiffViewer 本来就在那边；
// 这里只负责取出 patch 文本、按路径归一、算增删行数。

import path from "node:path";
import { getSessionStore } from "@/main/pisdk/session-store";
import { normalizePath } from "@/main/security/path-guard";
import type { ChangeKind, FileChange, ReviewSummary } from "@/shared/contracts/review";
import type { ChatMessage, ChatPart, SessionMessagesPage } from "@/shared/contracts/session";

/** 审查面板最多回顾多少条消息：一次超长会话不该为了审查把全部历史都读一遍 */
const SCAN_LIMIT = 2000;

/** 写类工具：write 覆盖整文件、edit 改行 */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** 一条 tool-call 是否真的落到文件上了（与 session-files.ts 的 applied 同一口径） */
function applied(part: Extract<ChatPart, { type: "tool-call" }>): boolean {
  if (part.isError === true) return false;
  // pending-approval / denied / error 都还没成功改动；running 已经发出去了，算
  return part.status !== "pending-approval" && part.status !== "denied" && part.status !== "error";
}

/** 工具参数里的路径（与 tool-presentation 的取键顺序一致：path 优先，其次 file） */
function callPath(part: Extract<ChatPart, { type: "tool-call" }>): string | null {
  const args = part.args;
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** 从工具 details 里取统一 diff 文本；取不到返回 null（面板会退化为只显示文件与增删数） */
function detailsPatch(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const patch = (details as Record<string, unknown>).patch;
  return typeof patch === "string" && patch.trim() !== "" ? patch : null;
}

/**
 * 从统一 diff 里数增删行。
 *
 * 难点只有一个：`+++` / `---` 既可能是文件头，也可能是**正文行**（例如给 markdown
 * 加一行 front-matter、或在对比两份 diff）。单纯按前缀跳过会把后者漏掉，
 * 于是「加了一行 +++」这种改动在面板上显示为 +0（实测确认过）。
 *
 * 因此按**位置**判：只有在 hunk 之外（还没见到 `@@`）的 `--- ` / `+++ ` 才是文件头。
 * 进入 hunk 之后，`+++xxx`（没有空格、或即使有空格）都算正文 —— 因为文件头
 * 一定出现在第一个 `@@` 之前，这一点是所有统一 diff 生成器的共同形态。
 *
 * 不引入 parse-diff：渲染层已经有一份完整解析（DiffViewer），这里只是给面板
 * 顶部那行合计数字计数，为它多一次解析没有必要。
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
    // 文件头只在 hunk 之前出现；这里连 `diff --git`、`index`、`new file mode` 一起跳过
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

/**
 * 判断这次改动是新建还是修改。
 *
 * 判据顺序（越靠前越可信）：
 *   1. 工具 details 里的 kind/isNew 字段（模型侧如果给了就直接用）；
 *   2. diff 头 `--- /dev/null`：表示原先没有这个文件，是新建；
 *   3. 都拿不到时按工具名推：write 多为新建、edit 必然是修改。
 *
 * 判错的代价只是面板上那个标签，不影响补丁内容，所以这里不做额外 IO（不去 stat 磁盘）。
 */
function classify(
  part: Extract<ChatPart, { type: "tool-call" }>,
  patch: string | null,
): ChangeKind {
  const details = part.details;
  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    if (record.isNew === true) return "added";
    if (record.kind === "added" || record.kind === "modified") return record.kind;
  }
  if (patch !== null && /^---\s+\/dev\/null/m.test(patch)) return "added";
  return part.toolName === "write" ? "added" : "modified";
}

/** 会话工作目录内的展示路径（相对更短更易读）；跨出目录时回落绝对路径 */
function displayPathOf(absolute: string, root: string): string {
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolute;
  }
  return relative.split(path.sep).join("/");
}

/**
 * 汇总改动。
 *
 * 会话工作目录（session.cwd）是路径归一的基准：工具参数里的路径可能是相对的
 * （模型常常写 `src/foo.ts`），用 cwd 解析后才能与其它记录对上、也才能算出展示路径。
 */
export function summarizeReview(page: SessionMessagesPage, cwd: string): ReviewSummary {
  const root = normalizePath(cwd);
  const changes: FileChange[] = [];
  const uniquePaths = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const message of page.messages as readonly ChatMessage[]) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      if (!WRITE_TOOLS.has(part.toolName)) continue;
      if (!applied(part)) continue;

      const rawPath = callPath(part);
      if (rawPath === null) continue;

      // 相对路径按会话工作目录解析（与模型侧文件工具同一基准）
      const absolute = normalizePath(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath));
      const patch = detailsPatch(part.details);
      const counted = patch === null ? { additions: 0, deletions: 0 } : countLines(patch);

      changes.push({
        path: absolute,
        displayPath: displayPathOf(absolute, root),
        kind: classify(part, patch),
        additions: counted.additions,
        deletions: counted.deletions,
        tool: part.toolName,
        toolCallId: part.toolCallId,
        at: message.createdAt,
        patch,
      });

      uniquePaths.add(absolute);
      additions += counted.additions;
      deletions += counted.deletions;
    }
  }

  // 最新的改动排最前：用户打开审查时最关心的通常是「刚刚改了什么」
  changes.reverse();

  return { root, changes, fileCount: uniquePaths.size, additions, deletions };
}

/**
 * IPC 入口：按会话 id 汇总。
 *
 * 消息从会话存储读（与渲染层的 loadMessages 同一个来源），
 * 所以面板看到的改动与对话里显示的完全一致，不另算一份。
 */
export async function reviewSummary(sessionId: string): Promise<ReviewSummary> {
  const cwd = await getSessionStore().readCwd(sessionId);
  if (cwd === null) throw new Error(`会话不存在或未绑定工作目录：${sessionId}`);

  // 从会话尾部读：审查关心的是最近的改动，而 store 默认按 newestFirst 返回，
  // 超过 SCAN_LIMIT 条时更早的改动不再回顾（面板顶部会显示本次统计范围）
  const page = await getSessionStore().loadMessages(sessionId, { limit: SCAN_LIMIT });
  return summarizeReview(page, cwd);
}
