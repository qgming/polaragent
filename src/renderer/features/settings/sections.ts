// 设置分栏注册表的**唯一对外入口**。
//
// 与 features/right-panel/panels.ts 同构：先跑内置注册的副作用，再暴露查询 API。
// 任何从这里导入的模块拿到的一定是一张已经装好内置十项的表。
//
// ⚠️ **不要直接 import `./settings-registry` 或 `./builtin-sections`** ——
// 前者拿到空表，后者只注册但拿不到查询函数。

import "./builtin-sections";

export type { SettingsSectionDescriptor } from "./settings-registry";
export {
  getSettingsSection,
  registerSettingsSection,
  settingsSections,
} from "./settings-registry";
