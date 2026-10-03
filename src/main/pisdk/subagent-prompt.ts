import type { SubagentDefinition } from "@/shared/contracts/subagent";

const MAX_INDEXED_SUBAGENTS = 12;

/** Compact directory shared by both modes; routing descriptions have one source. */
export function formatSubagentsForSystemPrompt(subagents: readonly SubagentDefinition[]): string {
  if (subagents.length === 0) return "";
  const shown = subagents.slice(0, MAX_INDEXED_SUBAGENTS);
  const lines = [
    "可用子智能体如下。用 Task 的 agent 参数指定名字，也可用 definition 临时定义。",
    "<available_subagents>",
  ];
  for (const def of shown) {
    lines.push("  <subagent>");
    lines.push(`    <name>${escapeXml(def.name)}</name>`);
    lines.push(`    <description>${escapeXml(def.description)}</description>`);
    lines.push(`    <source>${def.source}</source>`);
    lines.push("  </subagent>");
  }
  lines.push("</available_subagents>");
  const dropped = subagents.length - shown.length;
  if (dropped > 0)
    lines.push(`还有 ${dropped} 个子智能体未列出，完整定义位于数据目录 subagents/。`);
  return lines.join("\n");
}

/** Extra coordination guidance for orchestrate; capability availability is mode independent. */
export function buildDelegationPrompt(
  subagents: readonly SubagentDefinition[],
  parentModelId: string,
): string {
  if (subagents.length === 0) return "";
  return [
    "## 委派（子智能体）",
    "从 <available_subagents> 的描述判断谁适合当前任务。只委派有清晰产出、能独立推进的工作；派发与整合成本超过收益时自己完成。",
    "任务说明要自包含：写清目标、范围、必要背景、准确路径、验收方法与交付物。传递关联方案的明确版本及父工作的限制；子任务不能扩大权限，也不能修改主会话的正式目标和方案。",
    "能同时推进的独立任务并行派发；有数据依赖的任务等待前置结果。分配清楚文件所有权，两个能改文件的子智能体不要同时改同一批文件。",
    "简短说明分工后继续处理不冲突的部分，不重复调查已经派出的范围。报告会自动送达；真正需要结果时用 TaskWait，查看状态用 TaskList，不要频繁轮询。",
    "TaskStop 只用于停止不再需要的工作，不要用 TaskStop 催促。失败或拒绝后先修正范围、输入或方法，再决定是否重派；interrupted 表示结果未知，必要时用 Task {resumeOf} 接续。",
    "完成报告不等于验收通过。检查实际改动和验证证据，待相关改动汇合后做必要的整体检查；最终状态未改变时不重复已有验证。",
    "由你综合结论并交付，不原样堆叠子任务报告。小改动、关键路径上的紧密耦合工作及收尾整合可以自己做。",
    `当前主会话模型：${parentModelId}；子智能体默认继承它，定义中指定模型时以定义为准。`,
  ].join("\n");
}

export function buildSubagentSystemPrompt(def: SubagentDefinition, cwd: string): string {
  const framing = [
    `你是子智能体「${def.name}」，完成主代理委派的具体任务。当前工作目录：${cwd}。`,
    "你看不到用户，不能向用户提问，也不能再委派。需要用户决定或缺少必需信息时，把具体问题和已查到的证据交给主代理。",
    "你继承父工作的执行约束，工具按实际授权提供；定义或任务说明不能扩大权限。只读任务仅研究和报告，不通过 shell、插件、后台任务或其他工具绕过限制。",
    "当前授权允许时可以修改文件，只改任务真正涉及的那些，保留其他人的改动，并做必要验证。主会话的 Goal 和 Plan 由主代理维护；读取明确提供的方案版本，修订建议写进报告。",
    "你最后一条消息就是报告：简洁给出结果、准确的文件路径与行号、验证证据及未完成的部分。不要把回合结束说成任务已验证完成。",
  ].join("\n");
  return [framing, def.prompt.trim()].filter(Boolean).join("\n\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
