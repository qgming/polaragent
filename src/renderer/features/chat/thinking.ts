/**
 * 思考档位的解析：把「用户想要的档位」与「这个模型支持哪些档位」合成一个可用结果。
 *
 * 为什么渲染层自己算一遍而不是问主进程：输入框的 chip 每一帧都要知道列出哪几档，走一次
 * IPC 既慢又没必要 —— 模型条目里已经存着 `thinkingLevels`（添加模型时从 pi-ai 目录填好、
 * 用户可改），纯前端就能定案。就近降级的规则与内核 `clampThinkingLevel` 严格一致，
 * 所以「chip 上显示什么」与「请求实际发什么」不会分叉。
 */

import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@/shared/contracts/common";
import type { ModelEntry } from "@/shared/contracts/settings";

/** 档位强弱顺序：索引越大越强 */
const ORDER: readonly ThinkingLevel[] = ALL_THINKING_LEVELS;

/**
 * 该模型支持的档位。
 *
/**
 * 该模型支持的档位。
 *
 * - `reasoning !== true` → 只有「关闭」（与内核一致，见下）；
 * - 显式配过（含用户改过的）→ 以它为准，并按强弱排序、剔除未知取值；
 * - 没配过 → 推理模型给全部五档（目录没匹配到时的兜底，免得什么都选不了）。
 */
export function supportedLevels(entry: ModelEntry | null | undefined): ThinkingLevel[] {
  /**
   * `reasoning !== true` 是**权威**：pi-ai 里所有写 `reasoning_effort` 的分支都带
   * `model.reasoning` 条件（openai-completions.js 的每个 thinkingFormat 分支与兜底分支），
   * 非推理模型的思考参数根本不会发出去。
   *
   * 因此这里不能因为「用户配过 thinkingLevels」就列出一堆档位 —— 那是在承诺一个发不出的
   * 档位，用户选了「高」实际却是关闭。配过的值仍留在配置里，等模型改成推理模型就再生效。
   */
  if (entry?.reasoning !== true) return ["off"];
  const explicit = entry.thinkingLevels;
  if (explicit !== undefined && explicit.length > 0) {
    const known = ORDER.filter((level) => explicit.includes(level));
    if (known.length > 0) return [...known];
  }
  return [...ORDER];
}

/**
 * 就近降级：要的档位不被支持时取最接近的一档。
 *
 * 与内核同款规则 —— 先往**更高**找（宁可多想一点也不悄悄降智），找不到再往低找，
 * 都没有则退回第一个可用档位。
 */
export function clampLevel(
  levels: readonly ThinkingLevel[],
  desired: ThinkingLevel,
): ThinkingLevel {
  if (levels.includes(desired)) return desired;
  const at = ORDER.indexOf(desired);
  for (let index = at; index < ORDER.length; index += 1) {
    const candidate = ORDER[index];
    if (candidate !== undefined && levels.includes(candidate)) return candidate;
  }
  for (let index = at - 1; index >= 0; index -= 1) {
    const candidate = ORDER[index];
    if (candidate !== undefined && levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}

export interface ResolvedThinking {
  /** 设置里存着的档位（用户想要什么），用于说明「为什么要降级」 */
  wanted: ThinkingLevel;
  /** chip 要列出的档位（始终非空） */
  levels: ThinkingLevel[];
  /** 当前生效的档位 */
  level: ThinkingLevel;
  /** 设置里的档位不被这个模型支持，已就近调整 —— 界面据此说明一声 */
  clamped: boolean;
}

/**
 * 合成结果：列表给 chip 渲染，level 给高亮，clamped 给提示。
 *
 * `entry` 传 null（没配模型 / 没选中模型）时按「全档可选」处理：此时没有任何依据去限制
 * 用户，限制反而更可疑。
 */
export function resolveThinking(
  desired: ThinkingLevel,
  entry: ModelEntry | null | undefined,
): ResolvedThinking {
  const levels = entry == null ? [...ORDER] : supportedLevels(entry);
  const level = clampLevel(levels, desired);
  return { wanted: desired, levels, level, clamped: level !== desired };
}

/** 设置里存的档位 → 本地化键（chip 与设置面板共用同一套文案） */
export function thinkingLabelKey(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "chat.thinkingOff";
    case "minimal":
      return "chat.thinkingMinimal";
    case "low":
      return "chat.thinkingLow";
    case "medium":
      return "chat.thinkingMedium";
    case "high":
      return "chat.thinkingHigh";
  }
}
