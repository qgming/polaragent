// AI 审批器：用一次性纯文本补全判断工具调用是否放行；任何异常与超时一律拒绝。

import type { MutableModels } from "@earendil-works/pi-ai";
import type { Settings } from "@/shared/contracts/settings";
import { buildProviders, resolveModel } from "./providers";

export interface AiApproverInput {
  toolName: string;
  argsText: string;
  workingDir?: string;
}

export interface AiApproverResult {
  allow: boolean;
  reason: string;
}

export type AiApprover = (input: AiApproverInput) => Promise<AiApproverResult>;

/** 审批补全的超时时间（毫秒），超时按拒绝处理 */
const TIMEOUT_MS = 15_000;
/** 审批输出很短，限制输出 token 防止模型展开长文 */
const MAX_TOKENS = 128;
/** 参数文本截断长度，避免写入大文件内容撑爆审批提示词 */
const MAX_ARGS_CHARS = 2_000;
/** 理由展示长度上限（≤50 字） */
const MAX_REASON_CHARS = 50;

const SYSTEM_PROMPT = [
  "你是 PolarAgent 的工具调用安全审批器。",
  "根据工具名与参数判断该操作是否可以安全执行；涉及删除、覆盖、敏感路径或远程副作用时倾向拒绝。",
  '只输出一个 JSON 对象，不要输出其他内容：{"allow": true, "reason": "不超过50字的中文理由"}。',
  "拿不准时输出 allow:false。",
].join("\n");

function toErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 判断异常是否来自 AbortSignal.timeout（DOMException name 为 TimeoutError） */
function isTimeout(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  return name === "TimeoutError" || name === "AbortError";
}

function buildUserPrompt(input: AiApproverInput): string {
  const lines = [
    `工具名：${input.toolName}`,
    `参数（JSON）：${truncate(input.argsText, MAX_ARGS_CHARS)}`,
  ];
  if (input.workingDir) lines.push(`工作目录：${input.workingDir}`);
  return lines.join("\n");
}

/** 解析模型输出：允许被代码块或解释文本包裹，最终仍需合法 JSON 且 allow 为布尔值 */
function parseDecision(text: string): AiApproverResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { allow: false, reason: "AI 审批结果解析失败，已拒绝" };
  try {
    const parsed = JSON.parse(match[0]) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") {
      return { allow: false, reason: "AI 审批结果缺少 allow 字段，已拒绝" };
    }
    const rawReason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const fallback = parsed.allow ? "AI 判定安全" : "AI 判定存在风险";
    return {
      allow: parsed.allow,
      reason: truncate(rawReason === "" ? fallback : rawReason, MAX_REASON_CHARS),
    };
  } catch {
    return { allow: false, reason: "AI 审批结果不是合法 JSON，已拒绝" };
  }
}

/** 基于 pi-ai 一次性补全的 AI 审批器；模型取 settings.aiApprovalModel，缺失时用 defaultModel */
export function createAiApprover(deps: {
  getSettings: () => Promise<Settings>;
  /** 每次调用时构造 models（设置可能变化）；复用 providers.ts 的实现 */
  buildModels?: (settings: Settings) => MutableModels;
}): AiApprover {
  const buildModels = deps.buildModels ?? ((settings: Settings) => buildProviders(settings).models);

  return async (input) => {
    let settings: Settings;
    try {
      settings = await deps.getSettings();
    } catch (error) {
      return { allow: false, reason: `读取设置失败，已拒绝：${toErrorText(error)}` };
    }

    const model = resolveModel(settings, settings.aiApprovalModel ?? settings.defaultModel);
    // 安全侧默认拒绝：没有可用模型时不放行
    if (!model) return { allow: false, reason: "未配置审批模型" };

    try {
      const message = await buildModels(settings).completeSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(input), timestamp: Date.now() }],
        },
        { maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return parseDecision(text);
    } catch (error) {
      if (isTimeout(error)) return { allow: false, reason: "AI 审批超时，已拒绝" };
      return { allow: false, reason: `AI 审批调用失败，已拒绝：${toErrorText(error)}` };
    }
  };
}
