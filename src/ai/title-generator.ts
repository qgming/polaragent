// 对话标题自动生成
// src/ai/title-generator.ts
//
// 使用 pi-ai 的 completeSimple 非流式 API，跟随设置中的 provider 配置。
// 不再依赖 Electron IPC 的 /chat/completions 端点，支持所有 provider 类型。

import { resolveDefaultModelService } from "./model-router";
import { callLlm } from "./llm-call";
import {
  extractLastLabeledValue,
  parseJsonObjectCandidates,
  unwrapStructuredOutput,
} from "./structured-output";

/** 标题建议字数范围（放宽，不做硬截断，仅在明显超长时按完整词收口） */
const MIN_TITLE_LENGTH = 5;
const MAX_TITLE_LENGTH = 15;
const MAX_MESSAGES_FOR_TITLE = 4;
const MAX_MESSAGE_CHARS = 420;

/** 用于生成标题的历史消息（角色 + 内容） */
export interface TitleHistoryMessage {
  role: "assistant" | "user";
  content: string;
}

/**
 * 清洗模型返回的标题：去掉引号、标点、换行。
 * 不做硬截断——只在明显超长（超过上限 1.5 倍）时，按完整词边界保守收口，
 * 避免把词/单词从中间切断，保留「真实标题」的可读形态。
 */
function sanitizeTitle(raw: string): string {
  const title = raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^(?:标题|对话标题|title)\s*[:：\-]\s*/i, "")
    .replace(/^\d+[.、)\s]+/, "")
    .trim()
    // 去掉首尾的引号/书名号/句号等常见包裹符号
    .replace(/^["'"『』「」《》【】\s]+/, "")
    .replace(/["'"『』「」《》【】。．.，,；;：:\s]+$/, "")
    .trim();

  // 上限内直接返回；仅在明显超长时才收口，避免轻微超长就被裁
  const HARD_LIMIT = Math.ceil(MAX_TITLE_LENGTH * 1.5);
  if (title.length <= HARD_LIMIT) {
    return title;
  }
  return truncateAtWordBoundary(title, MAX_TITLE_LENGTH);
}

/**
 * 在不切断完整词的前提下，把标题收口到目标字数附近。
 * 优先在最后一个空格处断开（保留完整英文单词）；
 * 若无空格（纯中文），则按字数直接截断。
 */
function truncateAtWordBoundary(title: string, limit: number): string {
  const slice = title.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  // 有空格且不至于截得太短时，在词边界断开
  if (lastSpace > limit * 0.5) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

/**
 * 根据对话历史（用户问题 + AI 正文）生成一个简短标题。
 * 使用 pi-ai 的 completeSimple 非流式 API，跟随设置中的 provider 配置。
 * 失败返回 null（调用方保留原标题）。
 */
export async function generateConversationTitle(
  history: TitleHistoryMessage[],
): Promise<string | null> {
  const service = resolveDefaultModelService();
  if (!service) return null;

  const transcript = buildTitleTranscript(history);
  if (!transcript) return null;

  const systemPrompt =
    "你是一个对话标题生成器。根据给定的早期对话内容，生成一个能概括核心任务或结论的中文标题。\n\n" +
    "要求：\n" +
    `- 标题长度控制在 ${MIN_TITLE_LENGTH}-${MAX_TITLE_LENGTH} 个字\n` +
    '- 优先使用具体名词和动作，避免"问题解答""方案讨论"等空泛标题\n' +
    "- 标题中不要包含引号、句号、序号或多余标点\n" +
    "- 优先输出纯 JSON，不要包含解释、代码块标记或其他内容\n" +
    "- 如果模型能力限制导致无法输出严格 JSON，至少输出可提取的单行标题键值\n\n" +
    "标准输出示例：\n" +
    '{"title": "实现用户登录功能"}\n\n' +
    "退化输出示例（无法输出严格 JSON 时使用）：\n" +
    "title: 实现用户登录功能\n" +
    "标题：实现用户登录功能";

  const userPrompt = `请为以下对话生成标题：\n\n${transcript}`;

  try {
    const result = await callLlm(service, {
      systemPrompt,
      userPrompt,
      temperature: 0.15,
      maxTokens: 48,
      jsonMode: true,
    });
    const title = extractTitle(result);
    return title && title.length > 0 ? title : null;
  } catch (error) {
    console.error("生成对话标题失败:", error);
    return null;
  }
}

function buildTitleTranscript(history: TitleHistoryMessage[]): string {
  return history
    .slice(0, MAX_MESSAGES_FOR_TITLE)
    .map((message) => {
      const content = message.content
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
      if (!content) return "";
      const speaker = message.role === "user" ? "用户" : "助手";
      return `${speaker}：${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 从模型返回的文本中解析出标题。
 * 优先按 JSON {"title": "..."} 解析；解析失败时退化为把整段文本当标题清洗。
 */
export function extractTitle(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const unwrapped = unwrapStructuredOutput(text);

  for (const parsed of parseJsonObjectCandidates(unwrapped)) {
    if (typeof parsed.title === "string") {
      return sanitizeTitle(parsed.title);
    }
  }

  const labeledTitle = extractLastLabeledValue(unwrapped, ["title", "标题", "对话标题"]);
  if (labeledTitle) {
    return sanitizeTitle(labeledTitle);
  }

  // 兜底：整段文本当标题清洗（模型可能未按 JSON 输出）
  const fallback = sanitizeTitle(unwrapped);
  return fallback.length > 0 ? fallback : null;
}
