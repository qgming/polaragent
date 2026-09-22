/**
 * pi-ai 自带的标准模型目录：按模型 id 查「支持哪些思考档位」与图片输入能力。
 *
 * 为什么要用这份目录，而不是只看 models.dev：
 * - models.dev 只有一个 `reasoning: boolean`，**没有档位信息** —— 无法回答
 *   「这个模型支不支持 minimal / high」；
 * - pi-ai 的 `dist/providers/data/*.json`（41 个 provider）里每个模型都带
 *   `thinkingLevelMap`，`null` 明确表示「该档位不支持」，这才是权威档位数据；
 * - 内核自己就按它做降级（`clampThinkingLevel`），我们用同一份数据才能与内核口径一致。
 *
 * 加载策略：**懒加载 + 一次缓存，且连 `providers/all` 本身都动态 import**。
 * 目录合计约 1.4 MB JSON（openrouter 一份就 164 KB），而匹配只发生在「用户填模型 ID」
 * 这一刻；`providers/all` 还会把 41 个 provider 工厂连同各自的 SDK 适配层一起拉进来
 * （实测 ~190 ms），没有任何理由在主进程启动时付这个代价。
 *
 * provider 清单**不再手写**：改用 pi-ai 的 `getBuiltinProviders()` / `getBuiltinModels()`。
 * 手写清单在 0.85.1 → 0.87.0 之间就漏掉了新增的 `meta` 与 `radius` 两个 provider，
 * 而漏掉的后果是静默的 —— 用户填这两个 provider 的模型 id 时匹配不到档位。
 * 交给上游枚举，升级时新增 provider 自动跟上。
 *
 * 匹配用的是自己的一套归一化（与 models-catalog.ts 同思路、独立实现）：pi-ai 的 id 不带
 * provider 前缀，所以额外准备 `<provider>/<id>` 与「只留字母数字」两种键。
 */

import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@/shared/contracts/common";
import type { CatalogModality } from "@/shared/contracts/models";

/** `@earendil-works/pi-ai/providers/all` 的静态类型，供动态 import 标注 */
type BuiltinCatalog = typeof import("@earendil-works/pi-ai/providers/all");

/** 动态加载上游 provider 枚举（见文件头：这项 import 约 190 ms，不能进启动路径） */
function loadBuiltinCatalog(): Promise<BuiltinCatalog> {
  return import("@earendil-works/pi-ai/providers/all");
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
  // 逐个 try：某个 provider 的目录取值失败（打包裁剪、依赖升级改了结构）不该让整个匹配失效
  for (const entry of await providerCatalog()) {
    try {
      models.push(...entry.models);
    } catch (error) {
      console.warn(
        `[known-models] 加载 provider 目录失败（${entry.provider}）：${error instanceof Error ? error.message : String(error)}`,
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
 * 上游 provider 枚举（provider 名 + 该 provider 的模型清单），懒加载一次。
 *
 * 抽出这一层是为了让 `providers/all` 只在真正要匹配时才被 import —— 见文件头。
 */
let catalog: Promise<ReadonlyArray<{ provider: string; models: Model<Api>[] }>> | null = null;

function providerCatalog(): Promise<ReadonlyArray<{ provider: string; models: Model<Api>[] }>> {
  catalog ??= (async () => {
    const all = await loadBuiltinCatalog();
    return all.getBuiltinProviders().map((provider) => ({
      provider,
      models: [...all.getBuiltinModels(provider)],
    }));
  })();
  return catalog;
}

/**
 * 目录里的 provider 数量（由 pi-ai 的 `providers/all` 提供）。
 *
 * 暴露出来是给测试当守卫：单个 provider 取值失败只记警告，万一某个子路径改名 / 被裁掉，
 * 表现是「静默少了几百个模型」而不是报错。测试拿它 + 模型总数一起断言，才能把这类事故变成红的。
 */
export async function providerCatalogCount(): Promise<number> {
  return (await providerCatalog()).length;
}

/** 已加载目录里的模型条数（首次调用会触发全量加载） */
export async function knownModelCount(): Promise<number> {
  cached ??= loadIndex();
  return (await cached).size;
}
