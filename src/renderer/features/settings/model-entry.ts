/**
 * 模型条目的「目录 → 配置」映射：把目录匹配结果翻成要写进 settings 的补丁。
 *
 * 单独成文件是为了能被单测直接驱动（不需要挂 React 组件、也不需要 window.oint）：
 * 「匹配后自动填什么」与「什么情况下不要覆盖用户的修改」这两条规则是本功能的核心契约，
 * 值得有独立的断言。
 */

import type { ModelCatalogEntry } from "@/shared/contracts/models";
import type { ModelEntry } from "@/shared/contracts/settings";

/**
 * 目录条目 → ModelEntry 补丁。
 *
 * 能力项一并写入，这正是「匹配后自动填好、之后还能改」的落点：
 * - `acceptsImages` 用目录的 `supportsImages`；
 * - `thinkingLevels` **只在目录真的带了档位表时**才写（thinkingSource === "pi-ai"）。
 *   推断值（仅有 reasoning 标志）不写进配置 —— 那是我们的猜测，固化成用户配置之后，
 *   用户在界面上看到的就是一条假的事实，也无从区分「目录说的」与「我们猜的」。
 */
export function catalogPatch(entry: ModelCatalogEntry): Partial<ModelEntry> {
  return {
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.reasoning,
    acceptsImages: entry.supportsImages,
    ...(entry.thinkingSource === "pi-ai" ? { thinkingLevels: [...entry.supportedThinking] } : {}),
  };
}

/**
 * 用户是否已经动过能力项（图片开关 / 思考档位）。
 *
 * 自动匹配只在「没动过」时才回填：只看名称与窗口的话，用户手动开了图片开关之后输入框
 * 一失焦，目录结果就会把他的选择覆盖掉。
 */
export function hasManualCapability(entry: ModelEntry): boolean {
  return entry.acceptsImages !== undefined || entry.thinkingLevels !== undefined;
}
