// 工具展示注册表的**唯一对外入口**。
//
// 与 features/right-panel/panels.ts / features/settings/sections.ts 同构：
// 先跑内置注册的副作用，再暴露查询 API。
//
// ⚠️ **不要直接 import `./tool-presentation-registry` 或 `./builtin-tool-presentations`** ——
// 前者拿到空表，后者只注册但拿不到查询函数。

import "./builtin-tool-presentations";

export type { ToolPresentation } from "./tool-presentation-registry";
export {
  DEFAULT_TOOL_ICON,
  FALLBACK_TOOL_LABELS,
  registerToolPresentation,
  toolActiveLabelKey,
  toolIcon,
  toolLabelKeys,
  toolPresentations,
} from "./tool-presentation-registry";
