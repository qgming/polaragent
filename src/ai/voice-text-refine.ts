// 语音文字口语优化工具
// src/ai/voice-text-refine.ts
//
// 使用配置的 AI 模型整理语音识别文本，去除口头语、语气词等。
// 使用 pi-ai 统一的 streamSimple API，跟随设置中的 provider 配置。

import { callLlm } from "./llm-call";
import { resolveDefaultModelService } from "./model-router";

// 整理提示词系统提示词
const REFINER_SYSTEM_PROMPT = [
  "你是一个语音文本整理助手。你的任务是将语音识别的原始文本整理为清晰、简洁、正式的书面文字。",
  "要求：",
  "1. 去除口头语（嗯、啊、那个、就是说、然后、对、这样子等）",
  "2. 去除重复内容和停顿词",
  "3. 补充必要的标点符号（问号、句号、逗号等）",
  "4. 保持原意不变，不添加原文没有的内容",
  "5. 如果原文包含多个独立的句子或问题，用标点分隔清楚",
  '只输出一个 JSON 对象，格式为 {"text": "整理后的文本"}，不要包含任何额外解释或代码块标记。',
].join("\n");

/**
 * 调用 AI 模型整理语音识别文本
 * @param text 原始语音识别文本
 * @returns 整理后的文本
 */
export async function refineVoiceText(text: string): Promise<string> {
  const service = resolveDefaultModelService();
  if (!service) {
    throw new Error("未配置默认模型");
  }

  const userPrompt = `请整理以下语音识别文本：\n\n${text}`;

  try {
    const result = await callLlm(service, {
      systemPrompt: REFINER_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.3,
      maxTokens: 500,
    });
    return extractRefinedText(result);
  } catch (error) {
    console.error("语音文字整理失败:", error);
    throw error;
  }
}

/**
 * 从模型返回的文本中解析出整理后的文本
 * 优先按 JSON {"text": "..."} 解析；解析失败时退化为直接返回文本
 */
function extractRefinedText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  // 去掉可能被包裹的 ```json ... ``` 代码块标记
  const unwrapped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(unwrapped) as { text?: unknown };
    if (parsed && typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    // 不是合法 JSON：尝试从文本中抓取 "text": "..." 片段
    const match = unwrapped.match(/"text"\s*:\s*"([^"]+)"/);
    if (match) {
      return match[1].trim();
    }
  }

  // 兜底：整段文本直接返回（模型可能未按 JSON 输出）
  return unwrapped;
}
