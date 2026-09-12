// AI 审批器：用一次性纯文本补全判断工具调用是否放行；任何异常与超时一律拒绝。
// 模型固定取默认路由模型（settings.defaultModel）；提示词是内置英文模板，没有用户自定义入口。

import type { MutableModels } from "@earendil-works/pi-ai";
import type { LanguageCode, ModelRef } from "@/shared/contracts/common";
import type { Settings } from "@/shared/contracts/settings";
import { AI_APPROVAL_SYSTEM_PROMPT, buildAiApprovalPrompt } from "@/shared/prompts/ai-approval";
import { buildProviders, resolveModel } from "./providers";
export interface AiApproverInput {
  toolName: string;
  argsText: string;
  workingDir?: string;
  /**
   * 本会话实际使用的模型引用。缺省时才回落到设置里的默认模型 ——
   * 审批该用「这个会话正在用的模型」，否则会话绑定过模型时会话跑 A、审批跑 B。
   */
  modelRef?: ModelRef;
}

export interface AiApproverResult {
  allow: boolean;
  reason: string;
}

export type AiApprover = (input: AiApproverInput) => Promise<AiApproverResult>;

/** 审批补全的超时时间（毫秒），超时按拒绝处理 */
const TIMEOUT_MS = 15_000;
/**
 * 输出上限：审批只要一小段 JSON，但不能压得太紧 —— 默认路由模型可能是思考型模型，
 * 上限不够时会只吐推理、没有结论（解析失败即全量拒绝），所以留出余量。
 */
const MAX_TOKENS = 256;
/** 参数文本截断长度，避免写入大文件内容撑爆审批提示词 */
const MAX_ARGS_CHARS = 2_000;
/** 理由展示长度上限（≤50 字） */
const MAX_REASON_CHARS = 50;

/** 兜底理由与错误文案（按语言）：英文界面不该出现中文理由 */
const REASONS: Record<
  LanguageCode,
  {
    parseFailed: string;
    missingField: string;
    notJson: string;
    allowFallback: string;
    denyFallback: string;
    noModel: string;
    settingsFailed: string;
    timedOut: string;
    callFailed: string;
  }
> = {
  "zh-CN": {
    parseFailed: "AI 审批结果解析失败，已拒绝",
    missingField: "AI 审批结果缺少 allow 字段，已拒绝",
    notJson: "AI 审批结果不是合法 JSON，已拒绝",
    allowFallback: "AI 判定安全",
    denyFallback: "AI 判定存在风险",
    noModel: "未选择默认模型，已拒绝",
    settingsFailed: "读取设置失败，已拒绝：",
    timedOut: "AI 审批超时，已拒绝",
    callFailed: "AI 审批调用失败，已拒绝：",
  },
  "en-US": {
    parseFailed: "AI verdict could not be parsed — denied",
    missingField: "AI verdict has no allow field — denied",
    notJson: "AI verdict is not valid JSON — denied",
    allowFallback: "AI judged the call safe",
    denyFallback: "AI judged the call risky",
    noModel: "No default model selected — denied",
    settingsFailed: "Failed to read settings — denied: ",
    timedOut: "AI review timed out — denied",
    callFailed: "AI review call failed — denied: ",
  },
};

function toErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 按码点截断（避免切在代理对中间） */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** 判断异常是否来自 AbortSignal.timeout（DOMException name 为 TimeoutError） */
function isTimeout(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** 参数文本可能很长，截断后再交给提示词模板 */
function approvalArgsText(input: AiApproverInput): string {
  return truncate(input.argsText, MAX_ARGS_CHARS);
}

/** 解析模型输出：允许被代码块或解释文本包裹，最终仍需合法 JSON 且 allow 为布尔值 */
function parseDecision(text: string, language: LanguageCode): AiApproverResult {
  const reasons = REASONS[language];
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { allow: false, reason: reasons.parseFailed };
  try {
    const parsed = JSON.parse(match[0]) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") {
      return { allow: false, reason: reasons.missingField };
    }
    const rawReason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const fallback = parsed.allow ? reasons.allowFallback : reasons.denyFallback;
    return {
      allow: parsed.allow,
      reason: truncate(rawReason === "" ? fallback : rawReason, MAX_REASON_CHARS),
    };
  } catch {
    return { allow: false, reason: reasons.notJson };
  }
}

/**
 * 基于 pi-ai 一次性补全的 AI 审批器：
 * 模型固定取用户选中的默认路由模型（settings.defaultModel），
 * 系统提示词是内置英文模板（AI_APPROVAL_PROMPT），没有用户自定义入口。
 */
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
      // 设置读不出来时无从得知界面语言：用中性（英文）兜底，避免英文用户收到中文理由
      const reasons = REASONS["en-US"];
      return { allow: false, reason: `${reasons.settingsFailed}${toErrorText(error)}` };
    }

    const reasons = REASONS[settings.language];
    // 优先用会话实际使用的模型；只有调用方没给时才回落到设置里的默认模型
    const model = resolveModel(settings, input.modelRef ?? settings.defaultModel);
    // 安全侧默认拒绝：没有可用模型时不放行
    if (!model) return { allow: false, reason: reasons.noModel };

    try {
      const message = await buildModels(settings).completeSimple(
        model,
        {
          systemPrompt: AI_APPROVAL_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildAiApprovalPrompt({
                toolName: input.toolName,
                argsText: approvalArgsText(input),
                ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }),
                language: settings.language,
              }),
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return parseDecision(text, settings.language);
    } catch (error) {
      if (isTimeout(error)) return { allow: false, reason: reasons.timedOut };
      return { allow: false, reason: `${reasons.callFailed}${toErrorText(error)}` };
    }
  };
}
