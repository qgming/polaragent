// 子智能体终止时，把结果组装成**那次工具调用的结果**（纯函数，不碰 Electron / harness / 事件流）。
//
// 为什么单独一个文件、为什么必须是纯函数：
// 「报告以什么形状交回去」是这次功能的对外契约，而它的分支不少（四种终态 × 有/无报告 ×
// 是否被自己停掉），把**组装**与**投递**拆开之后，这张表可以用测试逐条钉死，
// 不必为了一条分支去搭假 harness。
//
// 形状的决定（用户明确要求）：报告**不作为一条用户消息**出现，而是那次子智能体调用的结果 ——
// 也就是写进 `Task` 调用的 details / result，显示在「xxx 已完成」那个状态里。
//
// 为什么不再「推一条消息给主代理」：
// 1. 用户要的形状就是工具结果，而不是对话里凭空多一句；
// 2. 主代理要读它，走 `TaskWait` / `TaskList`（报告在里面完整带着）——
//    那是「主动读取」，比系统替模型开口更可控，也就没有了自激唤醒的问题
//    （原先为抑制自激而设的唤醒预算因此不再需要）。
//
// 因此这里只回答一件事：**这次终止该以什么内容、什么成败标记呈现**。

import type { SubagentRun } from "@/shared/contracts/subagent";

/**
 * 单次报告在工具结果里最多保留多少字符。
 *
 * 与 tools/subagent.ts 的 MAX_REPORT_CHARS 同量级，但**刻意各自定义**：
 * 那边限制的是「TaskWait 一次返回多份报告」的总体积，这里限制的是「一条工具结果的长度」。
 * 两处共用一个常量会让其中一处想调的时候被另一处绑住。
 */
export const MAX_RESULT_CHARS = 8_000;

/** 一次终止要呈现的内容：文本 + 是否算失败 */
export interface SubagentResult {
  /** 写进工具结果正文的文本（模型与界面都按它显示） */
  text: string;
  /** 失败态（渲染层据此给红叉而不是绿勾） */
  isError: boolean;
}

/** 终态里哪些算「失败」：只有真正没跑成 / 跑挂了才算，truncated 与 aborted 是「有结果的未完成」 */
const FAILED_STATUSES = new Set(["failed", "denied"]);

/**
 * 这次运行该怎么呈现成工具结果。`null` = 还在跑，不该有结果（调用方据此跳过回填）。
 *
 * 四种终态都要回填，**包括没有报告的**：状态本身就是要显示的东西
 *（「已完成」「达到轮次上限」「意外终止」「运行失败」）——
 * 只在有报告时才回填的话，界面会永远停在 running 上，而那正是要修掉的症状。
 */
export function buildSubagentResult(run: SubagentRun): SubagentResult | null {
  if (run.status === "running") return null;

  const report = (run.report ?? "").trim();
  const headline = describeOutcome(run);
  // 没有报告时明确说「没有」，而不是留一个空块 —— 模型看到空的「报告：」会以为内容丢了
  const body =
    report === ""
      ? "报告：（没有产出报告）"
      : `报告：\n${capReport(report, run.status === "truncated")}`;
  const hint =
    report === ""
      ? ""
      : `\n（要再看一遍就调用 TaskWait {"delegationIds":["${run.delegationId}"]}；` +
        "这份报告由你综合后给用户，不要原样转述。）";

  return {
    text: `${headline}\n${body}${hint}`,
    isError: FAILED_STATUSES.has(run.status),
  };
}

/** 一行描述这次运行怎么结束的：这是「xxx 已完成」那句话的来源 */
export function describeOutcome(run: SubagentRun): string {
  const who = `子智能体「${run.agentName}」`;
  const task = run.description === "" ? "" : `（任务：${run.description}）`;
  switch (run.status) {
    case "completed":
      return `${who}已完成${task}。`;
    case "truncated":
      return `${who}达到轮次上限被截断${task}：下面这份报告可能不完整。`;
    case "interrupted":
      return `${who}意外终止${task}：上个进程在它运行期间退出，结果未知。`;
    case "aborted":
      return `${who}已停止${task}${run.error === undefined ? "" : `（${run.error}）`}。`;
    case "denied":
      return `${who}未能启动${task}：${run.error ?? "未给出原因"}。`;
    case "failed":
      return `${who}运行失败${task}：${run.error ?? "未给出原因"}。`;
    default:
      return `${who}仍在运行${task}。`;
  }
}

/** 截断长报告，并把「被截断了」写清楚 —— 模型据此知道下面这份不完整 */
function capReport(report: string, incomplete: boolean): string {
  const note = incomplete ? "\n（注意：这次运行被轮次上限截断，报告本身也可能不完整）" : "";
  if (report.length <= MAX_RESULT_CHARS) return `${report}${note}`;
  return (
    `${report.slice(0, MAX_RESULT_CHARS)}\n\n` +
    `［报告已截断：原文 ${report.length} 字符，这里只保留前 ${MAX_RESULT_CHARS} 字符］${note}`
  );
}
