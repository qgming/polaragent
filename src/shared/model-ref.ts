/**
 * 「这个会话实际用哪个模型」的判定。
 *
 * 单独放在 shared 里是因为它有**两个**必须同源的调用方：主进程创建/切换会话运行时时用它决定
 * 请求发给谁，渲染层用它决定 chip 上显示哪个模型、以及思考档位按谁的支持范围渲染。
 * 两处各写一遍就一定会出现「界面按 A 算、请求发给 B」。
 *
 * 优先级与会话工作目录同构（见 use-slash-commands 的 resolveWorkingDir）：会话级选择优先，
 * 没有（或已失效）就回落到全局默认。
 */

import type { ModelRef } from "./contracts/common";
import type { ModelServiceConfig, Settings } from "./contracts/settings";

/** 该引用当前是否可用：服务存在且「有效」（与 providers.ts 的 isValidService 同口径） */
function findValidService(
  services: readonly ModelServiceConfig[],
  serviceId: string,
): ModelServiceConfig | undefined {
  const service = services.find((item) => item.id === serviceId);
  if (!service) return undefined;
  // 三个条件缺一不可（与 isValidService 一致）：id 非空、baseUrl 非空、至少一个模型
  if (service.id.trim() === "" || service.baseUrl.trim() === "" || service.models.length === 0) {
    return undefined;
  }
  return service;
}

/** 引用在设置里是否真的能解析出一个模型（服务被删、模型被删都算失效） */
export function hasModel(settings: Settings, ref: ModelRef | null): ref is ModelRef {
  if (ref === null) return false;
  const service = findValidService(settings.services, ref.serviceId);
  if (!service) return false;
  return service.models.some((model) => model.id === ref.modelId);
}

/**
 * 会话实际使用的模型引用。
 *
 * - 会话绑定过且仍然有效 → 用它；
 * - 绑定失效（服务/模型被删）→ 回落默认模型，而不是让会话卡在一个不存在的模型上；
 * - 都没有 → null（调用方据此提示「请先配置模型服务」）。
 */
export function resolveEffectiveModelRef(
  settings: Settings,
  bound: ModelRef | null,
): ModelRef | null {
  if (hasModel(settings, bound)) return bound;
  return hasModel(settings, settings.defaultModel) ? settings.defaultModel : null;
}
