import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import {
  stream as openaiCompletionsStream,
  streamSimple as openaiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  stream as openaiResponsesStream,
  streamSimple as openaiResponsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
  stream as anthropicMessagesStream,
  streamSimple as anthropicMessagesStreamSimple,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ProvidersConfig, ProviderConfig } from "@/types/config";

export type RuntimeProvider = {
  id: string;
  name: string;
  type: ProviderConfig["type"];
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  getModel: (modelId?: string) => Model<Api> | null;
};

/**
 * Provider 管理器
 */
export class ProviderManager {
  private providers = new Map<string, RuntimeProvider>();
  private config: ProvidersConfig | null = null;

  /**
   * 初始化所有 Providers
   */
  initialize(config: ProvidersConfig) {
    this.config = config;
    this.providers.clear();

    for (const providerConfig of config.providers) {
      if (!providerConfig.enabled) {
        continue;
      }

      try {
        const provider = this.createProvider(providerConfig);
        if (provider) {
          this.providers.set(providerConfig.id, provider);
          console.log(`Provider 初始化成功: ${providerConfig.name}`);
        }
      } catch (error) {
        console.error(`Provider 初始化失败: ${providerConfig.name}`, error);
      }
    }
  }

  /**
   * 创建 Provider 实例
   */
  private createProvider(config: ProviderConfig): RuntimeProvider | null {
    const apiKey = config.config.apiKey.trim();
    const baseURL = normalizeBaseURL(config.config.baseURL, config.type);
    const defaultModel =
      config.config.defaultModel?.trim() || config.models[0]?.id?.trim() || "";

    if (!apiKey || !baseURL || !defaultModel) {
      return null;
    }

    return {
      id: config.id,
      name: config.name,
      type: config.type,
      apiKey,
      baseURL,
      defaultModel,
      getModel: (modelId?: string) => {
        const id = modelId?.trim() || defaultModel;
        if (!id) {
          return null;
        }

        const savedModel = config.models.find((model) => model.id === id);
        return {
          id,
          name: savedModel?.name || id,
          // 接口格式直接来自供应商 type（与 pi-ai 的 api 对齐）
          api: config.type,
          provider: providerSlug(config.type, baseURL),
          baseUrl: baseURL,
          reasoning: false,
          // 用户手动添加的 OpenAI/Anthropic 兼容模型无法可靠从 /models 判断能力。
          // 这里声明支持图片输入，让真正的多模态模型可以接收图片；若后端模型不支持，
          // 会由上游接口返回明确错误，而不是被本地运行时提前拦下。
          input: ["text", "image"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: savedModel?.contextWindow || 128000,
          maxTokens: savedModel?.maxTokens || 8192,
          headers: config.config.organization
            ? { "OpenAI-Organization": config.config.organization }
            : undefined,
        } as Model<Api>;
      },
    };
  }

  /**
   * 获取 Provider
   */
  getProvider(id: string) {
    return this.providers.get(id);
  }

  /**
   * 获取默认 Provider
   */
  getDefaultProvider() {
    if (!this.config) {
      return null;
    }
    return this.providers.get(this.config.defaultProvider);
  }

  /**
   * 获取全局默认模型 id（配合 getDefaultProvider 使用）
   */
  getDefaultModelId(): string | undefined {
    return this.config?.defaultModel?.trim() || undefined;
  }

  getApiKey(providerId: string): string | undefined {
    return this.providers.get(providerId)?.apiKey;
  }

  /**
   * 获取 Provider 的模型
   */
  getModel(providerId: string, modelId?: string) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider 不存在: ${providerId}`);
    }

    return provider.getModel(modelId);
  }

  /**
   * 获取所有可用的 Providers
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * 验证 Provider 配置
   */
  async validateProvider(config: ProviderConfig): Promise<boolean> {
    try {
      const provider = this.createProvider(config);
      if (!provider) {
        return false;
      }

      // TODO: 实现实际的验证逻辑（发送测试请求）
      return true;
    } catch (error) {
      console.error("Provider 验证失败:", error);
      return false;
    }
  }
}

// 导出单例
export const providerManager = new ProviderManager();

function normalizeBaseURL(baseURL: string, type: ProviderConfig["type"]) {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  // Anthropic Messages 与 Responses 不强制追加 /v1（部分代理已自带或路径不同）；
  // 仅 OpenAI Chat Completions 习惯以 /v1 结尾，缺失时补齐。
  if (type === "openai-completions") {
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  }
  return trimmed;
}

// 给 pi-ai 的 model.provider 一个标识；优先按已知域名识别，否则按格式给通用值
// 0.80 对齐 KnownProvider：覆盖主流 + 国产 + 云厂商域名
function providerSlug(type: ProviderConfig["type"], baseURL: string) {
  // 按接口类型优先
  if (type === "anthropic-messages") return "anthropic";
  // 按域名识别（与 pi-ai KnownProvider 对齐）
  if (baseURL.includes("api.openai.com")) return "openai";
  if (baseURL.includes("api.anthropic.com")) return "anthropic";
  if (baseURL.includes("api.x.ai")) return "xai";
  if (baseURL.includes("api.groq.com")) return "groq";
  if (baseURL.includes("api.mistral.ai")) return "mistral";
  if (baseURL.includes("generativelanguage.googleapis.com")) return "google";
  if (baseURL.includes("aiplatform.googleapis.com")) return "google-vertex";
  if (baseURL.includes("bedrock")) return "amazon-bedrock";
  if (baseURL.includes("deepseek.com")) return "deepseek";
  if (baseURL.includes("openrouter.ai")) return "openrouter";
  if (baseURL.includes("api.together.xyz") || baseURL.includes("together.ai")) return "together";
  if (baseURL.includes("fireworks.ai")) return "fireworks";
  if (baseURL.includes("api.moonshot")) return "moonshotai";
  if (baseURL.includes("api.minimax")) return "minimax";
  if (baseURL.includes("api.cloudflare.com") || baseURL.includes("workers.ai")) return "cloudflare-workers-ai";
  if (baseURL.includes("gateway.ai.vercel.app")) return "vercel-ai-gateway";
  if (baseURL.includes("api.siliconflow")) return "siliconflow";
  if (baseURL.includes("api.lingyi") || baseURL.includes("api.lingyang")) return "ant-ling";
  if (baseURL.includes("api.z.ai") || baseURL.includes("zai")) return "zai";
  if (baseURL.includes("api.kimi")) return "kimi-coding";
  if (baseURL.includes("api.xiaomi") || baseURL.includes("mimo")) return "xiaomi";
  // 兜底：按接口格式给通用值
  if (type === "openai-completions") return "openai";
  if (type === "openai-responses") return "openai";
  return "openai";
}

// 导出 providerSlug 供 pi-models.ts 使用
export { providerSlug };

/**
 * 获取对应类型的 ProviderStreams 实现。
 * pi-ai 内部为每个 API 格式提供了 stream / streamSimple 函数，
 * 这里按 provider type 静态映射到对应实现。
 */
export function getProviderStreams(type: ProviderConfig["type"]): ProviderStreams {
  switch (type) {
    case "anthropic-messages":
      return {
        stream: anthropicMessagesStream,
        streamSimple: anthropicMessagesStreamSimple,
      };
    case "openai-responses":
      return {
        stream: openaiResponsesStream,
        streamSimple: openaiResponsesStreamSimple,
      };
    case "openai-completions":
    default:
      return {
        stream: openaiCompletionsStream,
        streamSimple: openaiCompletionsStreamSimple,
      };
  }
}
