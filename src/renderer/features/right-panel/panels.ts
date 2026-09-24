// 右侧面板注册表的**唯一对外入口**。
//
// 为什么要有这一层：内置六项的注册是**副作用**（见 builtin-panels.tsx），
// 而消费方（RightSidebar / RightPanelChooser / useGlobalShortcuts）不该关心
// "我是不是第一个 import 的人"。这个文件把两件事绑在一起：
//
//   1. `import "./builtin-panels"` —— 先跑注册；
//   2. `export * from "./panel-registry"` —— 再暴露查询与注册 API。
//
// ESM 保证 import 先于本模块体执行，所以任何从这里导入的模块，
// **拿到的一定是一张已经装好内置六项的表**。
//
// ⚠️ **不要直接 import `./panel-registry` 或 `./builtin-panels`** ——
// 前者拿到空表，后者只注册但拿不到查询函数。

import "./builtin-panels";

export type { PanelDescriptor, PanelRenderProps } from "./panel-registry";
export {
  chooseablePanels,
  getPanel,
  listPanels,
  panelLabel,
  panelShortcuts,
  registerPanel,
} from "./panel-registry";
