// 语音文字口语优化工具
// 使用配置的 AI 模型整理语音识别文本，去除口头语、语气词等

import { useConfigStore } from "@/stores/config-store";

/**
 * 调用 AI 模型整理语音识别文本
 * @param text 原始语音识别文本
 * @returns 整理后的文本
 */
export async function refineVoiceText(text: string): Promise<string> {
  const { providers } = useConfigStore.getState();

  if (!providers.defaultProvider || !providers.defaultModel) {
    throw new Error("未配置默认模型");
  }

  // 查找当前配置的 provider
  const provider = providers.providers.find((p) => p.id === providers.defaultProvider);
  if (!provider || !provider.enabled) {
    throw new Error("默认 Provider 未启用");
  }

  const { apiKey, baseURL } = provider.config;
  if (!apiKey?.trim() || !baseURL?.trim()) {
    throw new Error("Provider 配置不完整");
  }

  // 构建整理提示词 - 参考标题生成的简洁风格，使用 JSON 格式输出
  const systemPrompt =
    "你是一个语音文本整理助手。你的任务是将语音识别的原始文本整理为清晰、简洁、正式的书面文字。\n" +
    "要求：\n" +
    "1. 去除口头语（嗯、啊、那个、就是说、然后、对、这样子等）\n" +
    "2. 去除重复内容和停顿词\n" +
    "3. 补充必要的标点符号（问号、句号、逗号等）\n" +
    "4. 保持原意不变，不添加原文没有的内容\n" +
    "5. 如果原文包含多个独立的句子或问题，用标点分隔清楚\n" +
    '只输出一个 JSON 对象，格式为 {"text": "整理后的文本"}，不要包含任何额外解释或代码块标记。';

  const userPrompt = `请整理以下语音识别文本：\n\n${text}`;

  // 根据 provider 类型调用不同的 API
  if (provider.type === "openai-completions" || provider.type === "openai-responses") {
    return await callOpenAiCompatible(
      baseURL,
      apiKey,
      providers.defaultModel,
      systemPrompt,
      userPrompt,
    );
  } else if (provider.type === "anthropic-messages") {
    return await callAnthropicMessages(
      baseURL,
      apiKey,
      providers.defaultModel,
      systemPrompt,
      userPrompt,
    );
  } else {
    throw new Error(`不支持的 Provider 类型: ${provider.type}`);
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

/**
 * 调用 OpenAI 兼容接口
 */
async function callOpenAiCompatible(
  baseURL: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3, // 低温度，保持稳定输出
      max_tokens: 500, // 限制输出长度
      response_format: { type: "json_object" }, // 强制 JSON 输出
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 调用失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("API 返回数据格式错误");
  }

  return extractRefinedText(content);
}

/**
 * 调用 Anthropic Messages 接口
 */
async function callAnthropicMessages(
  baseURL: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = `${baseURL.replace(/\/+$/, "")}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 调用失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;

  if (!content) {
    throw new Error("API 返回数据格式错误");
  }

  return extractRefinedText(content);
}

