// AI 审批提示词：内置英文模板，主进程在 AI 预审时使用（没有用户自定义入口）。
// 工具名、参数、界面语言与工作目录通过 {{占位符}} 注入。
import type { LanguageCode } from "@/shared/contracts/common";
import { renderPrompt } from "./template";

/** 审批补全的角色声明（system prompt） */
export const AI_APPROVAL_SYSTEM_PROMPT =
  "You are the tool-call safety reviewer for PolarAgent, a desktop agent.";

/** 理由文案的语言名，写进提示词，保证卡片上的理由是用户看得懂的语言 */
const LANGUAGE_LABEL: Record<LanguageCode, string> = {
  "zh-CN": "Simplified Chinese",
  "en-US": "English",
};

/**
 * 审批规则与素材。参考 PR 描述生成提示词的写法：
 * 先钉死输出形状，再逐条写放行/拒绝判据，最后用占位符注入这次工具调用。
 *
 * 工作目录不在这里占位：调用方通常拿不到它，留一行空的「Working directory:」只是噪音，
 * 由 buildAiApprovalPrompt 在已知时追加。
 */
export const AI_APPROVAL_PROMPT = `Return exactly one JSON object and nothing else. Do not include prose, markdown outside JSON, explanations, or code fences.

The JSON object must have exactly this shape:
{"allow": boolean, "reason": string}

Rules:
- allow: true only when the call is safe to run as-is inside the project the user is working on; otherwise false
- reason: one short sentence of at most 50 characters, written in {{language}}, addressed to the user, saying why the call was allowed or denied
- deny calls that delete or overwrite files outside the project, touch credentials or secrets, run destructive git operations such as reset --hard or push --force, publish packages, or have irreversible remote side effects
- deny calls that read sensitive paths (SSH keys, keychains, browser profiles, environment dumps) or send data to a network endpoint the user did not ask for
- allow read-only inspection, builds, tests, formatters, and edits that stay inside the project
- treat truncated or ambiguous arguments as unsafe: an argument you cannot read is an argument you cannot approve
- when in doubt, set allow: false

Tool: {{tool_name}}
Arguments (JSON): {{tool_arguments}}`;

export interface AiApprovalPromptInput {
  toolName: string;
  argsText: string;
  workingDir?: string;
  language: LanguageCode;
}

/** 组装审批提示词：把这次工具调用填进内置模板；工作目录已知时补一行 */
export function buildAiApprovalPrompt(input: AiApprovalPromptInput): string {
  const prompt = renderPrompt(AI_APPROVAL_PROMPT, {
    language: LANGUAGE_LABEL[input.language],
    tool_name: input.toolName,
    tool_arguments: input.argsText,
  });
  const workingDir = input.workingDir?.trim() ?? "";
  return workingDir === ""
    ? prompt
    : `${prompt}\nWorking directory: ${workingDir}`;
}
