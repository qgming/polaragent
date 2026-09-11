// AI 审批提示词：内置英文模板，主进程在 AI 预审时使用（没有用户自定义入口）。
// 工具名、参数、界面语言与工作目录通过 {{占位符}} 注入。
import type { LanguageCode } from "@/shared/contracts/common";
import { renderPrompt } from "./template";

/**
 * 审批补全的角色声明（system prompt）。
 * 中文：你是 Oint（一款桌面 Agent）的工具调用安全审批员。
 */
export const AI_APPROVAL_SYSTEM_PROMPT =
  "You are the tool-call safety reviewer for Oint, a desktop agent.";

/**
 * 理由文案的语言名，写进提示词，保证卡片上的理由是用户看得懂的语言。
 * 中文界面 → Simplified Chinese；英文界面 → English。
 */
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
 *
 * 下面是英文模板逐条对应的中文说明（改模板时两处一起改）：
 *
 * 输出形状
 * · 只返回一个 JSON 对象，别的什么都不要：不要叙述、不要 JSON 之外的 markdown、不要解释、不要代码块围栏。
 * · 对象形状固定为 {"allow": boolean, "reason": string}。
 *
 * 规则（与 Rules: 各条一一对应）
 * 1. allow：只有当这次调用在用户的项目内按原样执行是安全的，才为 true；否则 false。
 * 2. reason：一句话，最多 50 个字符，用 {{language}}（界面语言）写给用户看，说明放行或拒绝的原因。
 * 3. 拒绝：删除或覆盖项目之外的文件；触碰凭据或密钥；破坏性的 git 操作（如 reset --hard、push --force）；
 *    发布包；以及任何不可撤销的远程副作用。
 * 4. 拒绝：读取敏感路径（SSH 密钥、钥匙串、浏览器配置、环境变量转储），或把数据发往用户没有要求的网络端点。
 * 5. 放行：只读查看、构建、测试、格式化，以及留在项目内的编辑。
 * 6. 被截断或含义含糊的参数视为不安全：读不懂的参数就不能批准。
 * 7. 拿不准时一律 allow: false。
 *
 * 素材（占位符）
 * · {{tool_name}}：工具名（如 read / write / edit / bash）。
 * · {{tool_arguments}}：参数的 JSON 文本（已按长度截断）。
 * · {{language}}：理由要使用的语言。
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
  /** 会话工作目录：已知时追加一行，供模型判断操作是否越出项目范围 */
  workingDir?: string;
  /** 界面语言：决定 reason 用哪种语言书写 */
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
  return workingDir === "" ? prompt : `${prompt}\nWorking directory: ${workingDir}`;
}
