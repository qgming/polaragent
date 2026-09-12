// 模型服务装配：把 Settings.services 转换为 pi-ai 的 provider / model 对象。

import type {
  Api,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import {
  stream as completionsStream,
  streamSimple as completionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  stream as responsesStream,
  streamSimple as responsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
  ALL_THINKING_LEVELS,
  type ThinkingLevel,
  type WireFormat,
} from "@/shared/contracts/common";
import type { ModelEntry, ModelServiceConfig, Settings } from "@/shared/contracts/settings";

/** 模型条目缺省上下文窗口（tokens） */
const DEFAULT_CONTEXT_WINDOW = 128000;

/** 单次装配结果：models 注册表 + 服务 id → provider 映射 */
export interface ProvidersBundle {
  models: MutableModels;
  providers: Map<string, Provider>;
}

/** wireFormat → 适配器流实现；createProvider 内部按 model.api 分派 */
const ADAPTER_STREAMS: Record<WireFormat, ProviderStreams> = {
  "openai-completions": {
    stream: completionsStream,
    streamSimple: completionsStreamSimple,
  },
  "openai-responses": {
    stream: responsesStream,
    streamSimple: responsesStreamSimple,
  },
};

/** 服务有效性：id 与 baseUrl 非空白，且至少配置一个模型 */
function isValidService(service: ModelServiceConfig): boolean {
  return service.id.trim() !== "" && service.baseUrl.trim() !== "" && service.models.length > 0;
}

/** ModelEntry → Model；自定义端点无价格数据，cost 统一为零 */
function toPiModel(service: ModelServiceConfig, entry: ModelEntry): Model<Api> {
  const contextWindow = entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api: service.wireFormat,
    provider: service.id,
    baseUrl: service.baseUrl,
    reasoning: entry.reasoning ?? false,
    input: entry.acceptsImages === true ? ["text", "image"] : ["text"],
    thinkingLevelMap: toThinkingLevelMap(entry.thinkingLevels),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: resolveMaxTokens(entry.maxTokens, contextWindow),
  };
}

/**
 * 支持的档位 → pi-ai 的 `thinkingLevelMap`。
 *
 * 语义照内核：`null` = 该档位不支持，`undefined`（键缺席）= 用 provider 默认值。
 * 于是「用户勾了哪几档」直接表达成「未勾的写 null」，内核自己的 clampThinkingLevel 就会
 * 把请求收窄到这些档位 —— 思考等级因此真正进到请求参数里，而不只是提示词里的一句话。
 *
 * 两种情况不生成 map（返回 undefined）：
 * - 没配过（undefined）：让内核按 provider 默认处理；
 * - 空数组：等同「没有信息」，同样交给内核。
 *
 * 一处已知取舍：内核还有 xhigh / max 两档，而 ModelEntry 只存本仓五档。用户显式配过档位时，
 * 这两档会因为不在 map 里而被内核视为不支持 —— 但本仓从不请求它们（settings.thinkingLevel
 * 只有五档），所以不影响实际行为。
 */
function toThinkingLevelMap(
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevelMap | undefined {
  if (levels === undefined || levels.length === 0) return undefined;
  const map: ThinkingLevelMap = {};
  for (const level of ALL_THINKING_LEVELS) {
    map[level] = levels.includes(level) ? undefined : null;
  }
  return map;
}

/**
 * 解析输出上限：
 * - 未设置 → 0，pi-ai 会直接省略 max_tokens，由服务端决定（避免猜错被拒）；
 * - 大于等于上下文窗口 → 视为把窗口误填成输出上限，同样不传递；
 * - 其余按原值使用。
 */
function resolveMaxTokens(maxTokens: number | undefined, contextWindow: number): number {
  if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens < 1) return 0;
  if (maxTokens >= contextWindow) return 0;
  return maxTokens;
}

/** 服务内模型列表 → Model 对象的纯函数（便于单测与 UI 预览） */
export function toPiModels(service: ModelServiceConfig): Model<Api>[] {
  return service.models.map((entry) => toPiModel(service, entry));
}

/** 依据设置装配全部模型服务；无有效服务时返回空 bundle（不抛错） */
export function buildProviders(settings: Settings): ProvidersBundle {
  const models = createModels();
  const providers = new Map<string, Provider>();

  for (const service of settings.services) {
    // 无效服务静默跳过，不影响其余服务
    if (!isValidService(service)) continue;

    const provider = createProvider<Api>({
      id: service.id,
      name: service.name,
      baseUrl: service.baseUrl,
      auth: {
        apiKey: {
          name: service.name,
          // 空 apiKey 也照常返回，交由请求阶段报错，装配阶段不抛异常
          resolve: async () => ({ auth: { apiKey: service.apiKey } }),
        },
      },
      models: toPiModels(service),
      api: ADAPTER_STREAMS,
    });

    models.setProvider(provider);
    providers.set(service.id, provider);
  }

  return { models, providers };
}

/** 把设置里的模型引用解析为 pi-ai 的 Model；解析失败返回 undefined */
export function resolveModel(
  settings: Settings,
  ref: { serviceId: string; modelId: string } | null,
): Model<Api> | undefined {
  if (!ref) return undefined;

  // 纯函数实现：不依赖 buildProviders 的注册表副作用
  const service = settings.services.find((item) => item.id === ref.serviceId);
  if (!service || !isValidService(service)) return undefined;
  if (!service.models.some((entry) => entry.id === ref.modelId)) return undefined;

  return toPiModels(service).find((model) => model.id === ref.modelId);
}
