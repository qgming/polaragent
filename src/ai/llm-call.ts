// LLM 轻量调用工具
// src/ai/llm-call.ts
//
// 提供统一的 LLM 调用接口，使用 pi-ai 的 streamSimple API。
// 跟随设置中的 provider 配置，支持所有 provider 类型（OpenAI、Anthropic 等）。
// 供标题生成、目标评估、记忆捕获、工具权限审查等轻量场景使用。

import type { RoutedModelService } from "./model-router";
import { getProviderStreams } from "./providers";
import type {
  Api,
  Model,
  Context,
  AssistantMessageEvent,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 使用 pi-ai 统一的 streamSimple API 进行轻量级 LLM 调用。
 * 跟随设置中的 provider 配置，支持所有 provider 类型。
 *
 * @param service 模型服务（provider + model）
 * @param options 调用选项（systemPrompt、userPrompt、temperature、maxTokens）
 * @returns 模型返回的文本内容
 */
export async function callLlm(
  service: RoutedModelService,
  options: LlmCallOptions,
): Promise<string> {
  const providerType = service.provider.type;
  const streams = getProviderStreams(providerType);
  const model = service.model as Model<Api>;

  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: [
      {
        role: "user",
        content: options.userPrompt,
        timestamp: Date.now(),
      },
    ],
  };

  // 直接传入 apiKey，因为轻量调用没有注册到 pi-ai 的 Models 实例中
  const streamOptions: SimpleStreamOptions = {
    apiKey: service.provider.apiKey,
  };
  if (options.temperature !== undefined) {
    streamOptions.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    streamOptions.maxTokens = options.maxTokens;
  }

  const eventStream = streams.streamSimple(model, context, streamOptions);
  return await collectTextFromStream(eventStream);
}

/**
 * 从 AssistantMessageEventStream 收集完整的文本内容。
 */
async function collectTextFromStream(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<string> {
  let textContent = "";
  let finalText: string | null = null;

  for await (const event of stream) {
    if (event.type === "text_delta") {
      textContent += event.delta;
    } else if (event.type === "done") {
      const textBlock = event.message.content.find(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      );
      if (textBlock) {
        finalText = textBlock.text;
      }
    } else if (event.type === "error") {
      const errorMessage = event.error.errorMessage || "未知错误";
      throw new Error(`LLM 调用失败: ${errorMessage}`);
    }
  }

  return finalText ?? textContent;
}
