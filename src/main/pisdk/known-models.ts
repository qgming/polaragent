/**
 * pi-ai 自带的标准模型目录：按模型 id 查「支持哪些思考档位」与图片输入能力。
 *
 * 为什么要用这份目录，而不是只看 models.dev：
 * - models.dev 只有一个 `reasoning: boolean`，**没有档位信息** —— 无法回答
 *   「这个模型支不支持 minimal / high」；
 * - pi-ai 的 `dist/providers/data/*.json`（39 个 provider）里每个模型都带
 *   `thinkingLevelMap`，`null` 明确表示「该档位不支持」，这才是权威档位数据；
 * - 内核自己就按它做降级（`clampThinkingLevel`），我们用同一份数据才能与内核口径一致。
 *
 * 加载策略：懒加载 + 一次缓存。39 个目录合计约 700 KB JSON（openrouter 一份就 164 KB），
 * 而匹配只发生在「用户填模型 ID」这一刻，没有理由在启动时把它全解析一遍。
 *
 * 匹配用的是自己的一套归一化（与 models-catalog.ts 同思路、独立实现）：pi-ai 的 id 不带
 * provider 前缀，所以额外准备 `<provider>/<id>` 与「只留字母数字」两种键。
 */

import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@/shared/contracts/common";
import type { CatalogModality } from "@/shared/contracts/models";

/** provider 目录加载器；返回该模块导出的整份目录对象（形状在 toModelList 里校验） */
type CatalogLoader = () => Promise<unknown>;

/**
 * 全部 provider 目录。顺序即优先级：同一个模型 id 出现在多个 provider 时先出现的赢，
 * 唯一例外见 buildKnownModelIndex（带 thinkingLevelMap 的会顶掉不带的 —— 那正是我们要的信息）。
 */
const LOADERS: readonly CatalogLoader[] = [
  async () => (await import("@earendil-works/pi-ai/providers/anthropic.models")).ANTHROPIC_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/openai.models")).OPENAI_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/google.models")).GOOGLE_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/google-vertex.models")).GOOGLE_VERTEX_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/deepseek.models")).DEEPSEEK_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/mistral.models")).MISTRAL_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/xai.models")).XAI_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/zai.models")).ZAI_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/zai-coding-cn.models")).ZAI_CODING_CN_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/minimax.models")).MINIMAX_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/minimax-cn.models")).MINIMAX_CN_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/moonshotai.models")).MOONSHOTAI_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/moonshotai-cn.models")).MOONSHOTAI_CN_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/kimi-coding.models")).KIMI_CODING_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/xiaomi.models")).XIAOMI_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models"))
      .XIAOMI_TOKEN_PLAN_AMS_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models"))
      .XIAOMI_TOKEN_PLAN_CN_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models"))
      .XIAOMI_TOKEN_PLAN_SGP_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/qwen-token-plan.models")).QWEN_TOKEN_PLAN_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/qwen-token-plan-cn.models"))
      .QWEN_TOKEN_PLAN_CN_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/qwen-token-plan-individual.models"))
      .QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/ant-ling.models")).ANT_LING_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/groq.models")).GROQ_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/cerebras.models")).CEREBRAS_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/baseten.models")).BASETEN_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/fireworks.models")).FIREWORKS_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/nvidia.models")).NVIDIA_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/together.models")).TOGETHER_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/github-copilot.models")).GITHUB_COPILOT_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/openai-codex.models")).OPENAI_CODEX_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/huggingface.models")).HUGGINGFACE_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/cloudflare-workers-ai.models"))
      .CLOUDFLARE_WORKERS_AI_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models"))
      .CLOUDFLARE_AI_GATEWAY_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/vercel-ai-gateway.models"))
      .VERCEL_AI_GATEWAY_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/openrouter.models")).OPENROUTER_MODELS,
  async () => (await import("@earendil-works/pi-ai/providers/opencode.models")).OPENCODE_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/opencode-go.models")).OPENCODE_GO_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/amazon-bedrock.models")).AMAZON_BEDROCK_MODELS,
  async () =>
    (await import("@earendil-works/pi-ai/providers/azure-openai-responses.models"))
      .AZURE_OPENAI_RESPONSES_MODELS,
];

/** 目录对象 → 模型数组；只收「有字符串 id」的条目，目录结构变化时不抛错 */
function toModelList(catalog: unknown): Model<Api>[] {
  if (typeof catalog !== "object" || catalog === null) return [];
  return Object.values(catalog).filter(
    (item): item is Model<Api> => typeof (item as Model<Api> | null)?.id === "string",
  );
}

/** 只留字母数字：处理 "claude-opus-4.5" 与 "claude-opus-4-5" 这种写法差异 */
function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 模型 → 可用于建索引的全部键（小写 id、provider/id、以及两者的归一化形式） */
export function knownModelKeys(model: Model<Api>): string[] {
  const id = model.id.toLowerCase();
  const qualified = `${String(model.provider).toLowerCase()}/${id}`;
  const keys = [id, qualified, normalizeId(id), normalizeId(qualified)];
  return [...new Set(keys.filter((key) => key !== ""))];
}

/**
 * 模型 id → 该模型支持的思考档位（收窄到本仓五档）。
 *
 * 判定完全交给内核的 `getSupportedThinkingLevels`：它按 `thinkingLevelMap` 里
 * `null` = 不支持、`xhigh`/`max` 需显式映射的规则给出答案。这里只做取值收窄 ——
 * xhigh/max 不进用户可选档位。
 */
export function knownThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  const supported = getSupportedThinkingLevels(model);
  return ALL_THINKING_LEVELS.filter((level) => supported.includes(level));
}

/** 模型是否接受图片输入（pi-ai 的 input 是权威口径） */
export function knownSupportsImages(model: Model<Api>): boolean {
  return model.input.includes("image");
}

/**
 * 建索引。同一个模型 id 出现在多个 provider 时：先出现的赢，但**带 `thinkingLevelMap`
 * 的可以顶掉不带 map 的** —— 我们的目的正是拿到档位信息，没有 map 的那份对此无能为力。
 */
export function buildKnownModelIndex(models: readonly Model<Api>[]): Map<string, Model<Api>> {
  const index = new Map<string, Model<Api>>();
  for (const model of models) {
    for (const key of knownModelKeys(model)) {
      const existing = index.get(key);
      if (existing === undefined) {
        index.set(key, model);
        continue;
      }
      if (existing.thinkingLevelMap === undefined && model.thinkingLevelMap !== undefined) {
        index.set(key, model);
      }
    }
  }
  return index;
}

/** 在索引里查模型：原样小写 → 归一化，两级；都没有则 null */
export function matchInKnownIndex(
  index: ReadonlyMap<string, Model<Api>>,
  id: string,
): Model<Api> | null {
  const needle = id.trim();
  if (needle === "") return null;
  const direct = index.get(needle.toLowerCase());
  if (direct !== undefined) return direct;
  const normalized = normalizeId(needle);
  if (normalized === "") return null;
  return index.get(normalized) ?? null;
}

/** 索引缓存；null 表示还没加载过 */
let cached: Promise<Map<string, Model<Api>>> | null = null;

async function loadIndex(): Promise<Map<string, Model<Api>>> {
  const models: Model<Api>[] = [];
  // 逐个 try：某个 provider 的目录加载失败（打包裁剪、依赖升级改了文件名）不该让整个匹配失效
  for (const load of LOADERS) {
    try {
      models.push(...toModelList(await load()));
    } catch (error) {
      console.warn(
        `[known-models] 加载 provider 目录失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return buildKnownModelIndex(models);
}

/**
 * 按模型 id 匹配 pi-ai 标准目录；匹配不到返回 null。
 * 首次调用会加载全部 provider 目录，之后走缓存。
 */
export async function matchKnownModel(id: string): Promise<Model<Api> | null> {
  const trimmed = id.trim();
  if (trimmed === "") return null;
  cached ??= loadIndex();
  try {
    return matchInKnownIndex(await cached, trimmed);
  } catch (error) {
    // 加载失败不重试（避免每次失焦都去踩同一颗雷），也绝不让匹配报错冒到界面上
    console.warn(
      `[known-models] 匹配失败：${error instanceof Error ? error.message : String(error)}`,
    );
    cached = null;
    return null;
  }
}

/**
 * 从 pi-ai 模型上摘出的能力快照。
 *
 * 刻意摘成普通对象：合并（mergeCatalogEntry）与断言都在纯函数层做，不必把 `Model` 这种
 * 带一大堆可选字段的内核类型透进目录逻辑与测试里。
 */
export interface KnownCapabilities {
  /** pi-ai 的模型 id（不带 provider 前缀） */
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: CatalogModality[];
  /** 支持的思考档位（已收窄到本仓五档，始终非空） */
  thinkingLevels: ThinkingLevel[];
  /** 这份目录是否真的带了 thinkingLevelMap（带了才算权威档位，否则只是按 reasoning 的推断） */
  hasThinkingMap: boolean;
}

/** Model → 能力快照 */
export function knownCapabilities(model: Model<Api>): KnownCapabilities {
  const levels = knownThinkingLevels(model);
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    hasThinkingMap: model.thinkingLevelMap !== undefined,
    input: model.input.filter((kind) => kind === "text" || kind === "image"),
    // 档位为空说明这份目录对思考一无所知（既非推理模型、也没给 map）：交给上层按 reasoning
    // 推断。这里如实回 ["off"]，不假装有信息
    thinkingLevels: levels.length > 0 ? levels : ["off"],
  };
}

/** 按 id 匹配并摘出能力快照；匹配不到返回 null */
export async function matchKnownCapabilities(id: string): Promise<KnownCapabilities | null> {
  const model = await matchKnownModel(id);
  return model === null ? null : knownCapabilities(model);
}

/**
 * 目录加载器的数量。
 *
 * 暴露出来是给测试当守卫：`loadIndex` 对单个 provider 的失败只记警告，万一某个子路径改名 /
 * 被裁掉，表现是「静默少了几百个模型」而不是报错。测试拿它 + 模型总数一起断言，才能把这类
 * 事故变成红的。
 */
export const PROVIDER_CATALOG_COUNT = LOADERS.length;

/** 已加载目录里的模型条数（首次调用会触发全量加载） */
export async function knownModelCount(): Promise<number> {
  cached ??= loadIndex();
  return (await cached).size;
}
