// LLM 轻量调用工具
// src/ai/llm-call.ts
//
// 提供统一的 LLM 调用接口，使用 pi-ai 的非流式 completeSimple API。
// 跟随设置中的 provider 配置，支持所有 provider 类型（OpenAI、Anthropic 等）。
// 供标题生成、目标评估、记忆捕获、工具权限审查等轻量场景使用。

import type { RoutedModelService } from "./model-router";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { RETRY_DELAYS, MAX_RETRIES, sleep } from "./retry";

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** 强制 JSON 输出（通过 response_format 参数） */
  jsonMode?: boolean;
}

/**
 * 使用 pi-ai 的非流式 completeSimple API 进行轻量级 LLM 调用。
 * 跟随设置中的 provider 配置，支持所有 provider 类型。
 *
 * @param service 模型服务（provider + model）
 * @param options 调用选项（systemPrompt、userPrompt、temperature、maxTokens、jsonMode）
 * @returns 模型返回的文本内容
 */
export async function callLlm(
  service: RoutedModelService,
  options: LlmCallOptions,
): Promise<string> {
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
  
  // 如果启用 JSON 模式，通过 onPayload 回调注入 response_format 参数
  if (options.jsonMode) {
    streamOptions.onPayload = (payload: unknown) => {
      const params = payload as Record<string, unknown>;
      params.response_format = { type: "json_object" };
      return params;
    };
  }

  // 重试循环：固定 5 次，间隔递增
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await completeSimple(model, context, {
        ...streamOptions,
        signal: controller.signal,
      });
      
      // 从 AssistantMessage 中提取文本内容
      const textBlock = response.content.find(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      );
      const result = textBlock ? textBlock.text : "";
      
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(
          `LLM调用失败，${delay}ms 后重试 (${attempt + 1}/${MAX_RETRIES}):`,
          error instanceof Error ? error.message : String(error),
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // 理论上不会执行到这里，因为循环内要么 return 要么 throw
  throw new Error("LLM 调用失败：已耗尽重试次数");
}
