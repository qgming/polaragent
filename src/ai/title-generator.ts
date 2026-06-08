// 对话标题自动生成
// src/ai/title-generator.ts

import { firstModelService, resolveModelService } from "./model-router";
import { chatCompletion, isElectronRuntime } from "@/lib/electron/electron-api";

/** 标题建议字数上限（放宽，不做硬截断，仅在明显超长时按完整词收口） */
const MAX_TITLE_LENGTH = 20;

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
    // 去掉首尾的引号/书名号/句号等常见包裹符号
    .replace(/^["'“”『』「」《》【】\s]+/, "")
    .replace(/["'“”『』「」《》【】。．.\s]+$/, "")
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
 * 仅在 Electron 环境下通过 LLM 生成；失败或非 Electron 环境返回 null（调用方保留原标题）。
 */
export async function generateConversationTitle(
  history: TitleHistoryMessage[],
  agentId = "default",
): Promise<string | null> {
  if (!isElectronRuntime()) {
    return null;
  }

  const service = resolveModelService(agentId) ?? firstModelService();
  if (!service) {
    return null;
  }

  // 把历史拼成纯文本，避免占用过多 token
  const transcript = history
    .map((message) => {
      const speaker = message.role === "user" ? "用户" : "助手";
      const content = message.content.replace(/\s+/g, " ").trim().slice(0, 500);
      return `${speaker}：${content}`;
    })
    .join("\n");

  const systemPrompt =
    "你是一个对话标题生成器。根据给定的「用户问题 + 助手正文回复」，生成一个能概括对话主题的简短中文标题。" +
    `要求：尽量控制在 ${MAX_TITLE_LENGTH} 个字以内（可保留完整词语，不要为凑字数生硬截断）；标题中不要包含引号或多余标点。` +
    '只输出一个 JSON 对象，格式为 {"title": "标题内容"}，不要包含任何额外解释或代码块标记。';

  const userPrompt = `请为以下对话生成标题：\n\n${transcript}`;

  try {
    // 非流式一次性请求 + JSON 输出，拿到完整文本后直接 parse 判断可用
    const result = await chatCompletion({
      baseUrl: service.provider.baseURL,
      apiKey: service.provider.apiKey,
      model: service.model.id,
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
      maxTokens: 64,
      responseFormat: "json_object",
    });

    const title = extractTitle(result.content);
    return title && title.length > 0 ? title : null;
  } catch (error) {
    console.error("生成对话标题失败:", error);
    return null;
  }
}

/**
 * 从模型返回的文本中解析出标题。
 * 优先按 JSON {"title": "..."} 解析；解析失败时退化为把整段文本当标题清洗。
 */
function extractTitle(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // 去掉可能被包裹的 ```json ... ``` 代码块标记
  const unwrapped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(unwrapped) as { title?: unknown };
    if (parsed && typeof parsed.title === "string") {
      return sanitizeTitle(parsed.title);
    }
  } catch {
    // 不是合法 JSON：尝试从文本中抓取 "title": "..." 片段
    const match = unwrapped.match(/"title"\s*:\s*"([^"]+)"/);
    if (match) {
      return sanitizeTitle(match[1]);
    }
  }

  // 兜底：整段文本当标题清洗（模型可能未按 JSON 输出）
  const fallback = sanitizeTitle(unwrapped);
  return fallback.length > 0 ? fallback : null;
}
