// 后台作业结束时，把结果组装成**那次工具调用的结果**（纯函数，不碰 Electron / 进程 / 事件流）。
//
// 与 report-delivery 的分工：那边是子智能体，这边是后台作业。两者形状相同、判据不同，
// 所以各自一份纯函数而不是硬塞进同一个模块 —— 作业的成败判据是「进程怎么退出的」
//（退出码），子智能体是「这次运行怎么结束的」（状态枚举），混在一起只会让两边都难读。
//
// 形状的决定（用户明确要求，与子智能体一致）：作业的结论**仍然回填到那次**
// `bash_background` 调用的结果里**（模型与界面都从那次调用读 —— 显示成同一个工具状态组件，
// 里面的内容就是作业的输出）；此外运行时会把一条带结论尾巴的通知以 user 身份注入转录、
// 以系统通知行呈现给用户（两通道：模型从 user 身份的 custom 消息读它、界面从
// origin:"system" 读它并按系统通知行画，见 runtime 的 notifyJobExit / jobExitNotice）。
//
// 为什么这比子智能体更简单：作业状态本来就由主进程通过 `job-changed` 事件持续推进，
// 渲染层 store 里那份 `jobsBySession` 始终是新的（重启后由 `jobs.list` 补拉）。
// 也就是说界面这条路**不依赖回填** —— 回填只是为了让**模型**在下一轮上下文里看到结论。

import type { JobInfo } from "@/shared/contracts/job";

/**
 * 写进工具结果里的输出上限。
 *
 * 与 report-delivery 的 MAX_RESULT_CHARS 同量级但各自定义：那边限制一条报告，
 * 这边限制一段进程输出。作业输出常常又长又重复（构建日志），留太长会把上下文挤掉。
 */
export const MAX_JOB_RESULT_CHARS = 8_000;

/** 一次作业结束要呈现的内容：文本 + 是否算失败 */
export interface JobResult {
  text: string;
  isError: boolean;
}

/**
 * 这个作业算不算「失败」。
 *
 * 判据是**退出码**，不是状态枚举 —— 这是作业与子智能体最重要的一处差别：
 * - `failed`：服务侧已经判定失败（spawn 失败等），一定是失败；
 * - `exited`：只是「进程结束了」，退出码非 0 才算失败（0 = 正常完成）；
 * - `killed`：被我们自己或用户杀掉的，**不算失败** —— 那是有人主动叫停，
 *   给红叉会把它显示成「跑挂了」，与「我把它停了」是两件事；
 * - `running`：还没结束，本来就不该有结果（调用方据此跳过回填）。
 *
 * 退出码缺失（被信号杀死、spawn 失败）时按状态判断，不瞎猜。
 */
export function jobIsError(job: JobInfo): boolean {
  if (job.status === "failed") return true;
  if (job.status === "exited") return job.exitCode !== undefined && job.exitCode !== 0;
  return false;
}

/** 一行说清这个作业怎么样了：这是状态组件上那句状态词的来源 */
export function describeJobOutcome(job: JobInfo): string {
  const parts: string[] = [];
  if (job.exitCode !== undefined) parts.push(`退出码 ${job.exitCode}`);
  if (job.endedAt !== undefined) parts.push(`用时 ${formatElapsed(job.endedAt - job.startedAt)}`);
  const detail = parts.length === 0 ? "" : `（${parts.join("，")}）`;

  switch (job.status) {
    case "running":
      return `后台作业 ${job.id} 正在运行`;
    case "exited":
      // 退出码 0 与非 0 是两句话：「已完成」与「已退出」对一个被派活的人含义不同
      return jobIsError(job)
        ? `后台作业 ${job.id} 已退出${detail}`
        : `后台作业 ${job.id} 已完成${detail}`;
    case "failed":
      return `后台作业 ${job.id} 运行失败${detail}`;
    case "killed":
      return `后台作业 ${job.id} 已被停止${detail}`;
  }
}

/**
 * 作业结束时要写进工具结果的内容。
 *
 * `running` 返回 null：还没结束就没有「结论」可写（调用方据此跳过回填，
 * 与 report-delivery 的 buildSubagentResult 同一个约定）。
 *
 * 文案里带上**命令**与**工作目录**：一次会话里可能起过好几个作业，
 * 只说「job-3 已完成」模型不知道那是哪一条。
 */
export function buildJobResult(job: JobInfo, tail: string): JobResult | null {
  if (job.status === "running") return null;

  const lines = [describeJobOutcome(job), `命令：${job.command}`, `工作目录：${job.cwd}`];
  const body = tail.trim();
  lines.push(body === "" ? "输出：（没有捕获到输出）" : `输出：\n${capTail(body)}`);
  // 终态的作业输出可以再读一次：drain 语义下已经读过的部分拿不回来，
  // 所以这里给出的是「结果里已经带着的这段」，要更多就再调 job_output
  lines.push(`要再看后续输出就调用 job_output {"id":"${job.id}"}。`);

  return { text: lines.join("\n"), isError: jobIsError(job) };
}

/** 毫秒 → 人读的短时长（与渲染层 formatDuration 的口径一致：秒级、不补零） */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** 截断长输出，并把「被截断了」与原文长度写清楚 */
function capTail(tail: string): string {
  if (tail.length <= MAX_JOB_RESULT_CHARS) return tail;
  return (
    `${tail.slice(0, MAX_JOB_RESULT_CHARS)}\n\n` +
    `［输出已截断：原文 ${tail.length} 字符，这里只保留前 ${MAX_JOB_RESULT_CHARS} 字符］`
  );
}
/**
 * 通知正文里输出段的上限。
 * 结论本体已回填在工具结果里（上限 MAX_JOB_RESULT_CHARS），通知只是「替它开口」，
 * 带一小段尾巴让用户/模型在消息流里直接看到结果，而不是强迫去翻工具卡。
 */
export const MAX_JOB_NOTICE_CHARS = 1_500;

/**
 * 作业退出的通知正文（终态才有；running 返回 null 由调用方跳过）。tail 是最近一段输出。
 *
 * 与 buildJobResult 同构（describeJobOutcome + 命令 + 工作目录 + 输出段 + job_output 指向），
 * 差异只在输出段的上限更小（MAX_JOB_NOTICE_CHARS）—— 结论全文已在工具结果里，
 * 这里重复的只是给用户/模型在消息流里直接看到的一小段。
 */
export function buildJobNotice(
  job: JobInfo,
  tail: string,
): { text: string; isError: boolean } | null {
  if (job.status === "running") return null;

  const lines = [describeJobOutcome(job), `命令：${job.command}`, `工作目录：${job.cwd}`];
  const body = tail.trim();
  lines.push(body === "" ? "输出：（没有捕获到输出）" : `输出：\n${capNoticeTail(body)}`);
  // 与 buildJobResult 同一句末行提示：drain 语义下已读部分拿不回来，要看后续就再调 job_output
  lines.push(`要再看后续输出就调用 job_output {"id":"${job.id}"}。`);

  return { text: lines.join("\n"), isError: jobIsError(job) };
}

/** 通知正文用的截断：上限更小、提示文案另起一套（与 capTail 各管各的） */
function capNoticeTail(tail: string): string {
  if (tail.length <= MAX_JOB_NOTICE_CHARS) return tail;
  return (
    `${tail.slice(0, MAX_JOB_NOTICE_CHARS)}\n\n` +
    `［通知输出已截断：原文 ${tail.length} 字符，只保留前 ${MAX_JOB_NOTICE_CHARS} 字符］`
  );
}
