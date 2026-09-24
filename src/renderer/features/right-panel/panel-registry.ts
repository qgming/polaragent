// 右侧面板的注册表：**内置面板与将来的插件面板走同一条路**。
//
// ## 为什么要有它
//
// 加一个右侧面板原先是**五处**改动：ui-store 的类型联合 + 顺序表、panel-meta 的穷举
// Record（漏项直接编译失败）、RightSidebar 的 switch、useGlobalShortcuts 的 switch。
// 五处里漏掉任何一处，症状都不一样（面板不出现 / 出现但没名字 / 出现但打不开），
// 而它们没有任何共同的真源。现在只剩一处：注册一行。
//
// ## 模块结构的约束（改之前先读这段）
//
// 三个文件，**依赖必须是一条直线**：
//
//     panels.ts  →  builtin-panels.tsx  →  panel-registry.ts
//     （唯一入口）   （注册内置六项）        （纯注册表，无副作用）
//
// 为什么不能让 `panel-registry.ts` 自己 `import "./builtin-panels"`：那会成环
// （builtin 需要 registerPanel），而 ESM 的循环在这里**真的会炸** ——
// `builtin-panels` 的顶层调用会在 `panel-registry` 的模块体执行之前跑，
// 那时 `const panels = new Map()` 还在 TDZ 里，直接 ReferenceError。
//
// 所以：**消费者一律从 `./panels` 导入，不要直接 import 这个文件** ——
// 后者绕过了内置注册，拿到的是一个空注册表。

import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * 面板内容拿到的参数。
 *
 * 做成统一形状而不是让每个面板各要各的：**浏览器面板需要 `tabId`**（多开时一个
 * 标签 = 一个 guest），其余的传了也不用（TS 允许无参组件赋给带参类型）。
 * 于是 `RightSidebar` 不必再为"浏览器要参数"开一条特殊路径。
 */
export interface PanelRenderProps {
  /** 这个面板实例所属的标签 id。同一视图多开时靠它区分 */
  tabId: string;
  /** 它此刻是不是当前标签（浏览器据此决定要不要上报视口） */
  active: boolean;
}

/**
 * 一个右侧面板的完整描述。
 *
 * 「顺序即注册顺序」：选择列表与标签条都按注册顺序渲染，所以内置六项的注册顺序
 * 就是它们过去的 `RIGHT_PANEL_VIEWS` 顺序。**不再单独维护一份顺序表** ——
 * 那正是过去两处会漂移的地方。
 */
export interface PanelDescriptor {
  /**
   * 稳定 id。
   *
   * 内置六项用各自的字面量（`"review"` / `"files"` / …）；将来插件贡献的面板用
   * `plugin:<pluginId>:<surfaceId>` 形状 —— 三段式让"这是谁的面板"在 id 里就能读出来，
   * 也让权限层能像 `mcp__<server>__*` 那样按前缀授权。
   */
  view: string;
  /** 标签与选择列表上的名字（i18n 键） */
  labelKey: string;
  /**
   * 直接显示的文字，**优先于 `labelKey`**。插件贡献的面板走这条。
   *
   * 为什么插件不用 `labelKey`：i18n 词条住在**宿主的语言包**里，而插件的名字住在
   * **它自己的清单**里。把插件名当成一个 i18n 键去查（`t("版本控制")`）虽然
   * 恰好能工作（i18next 查不到就原样返回），但那是**依赖缺键行为**——
   * 而缺键行为是可配置的（`returnNull` / `parseMissingKeyHandler`），
   * 一旦有人调了配置，所有插件面板的标题会一起变成空白或一串方括号。
   *
   * 所以把"这是运行期文字"这件事写进类型，而不是靠一个恰好成立的巧合。
   */
  labelText?: string;
  Icon: LucideIcon;
  /**
   * 单字母快捷键（大写，如 `"P"`），没有就不进快捷键表。
   *
   * 只有单字母 + Ctrl/Cmd 的组合才走这里 —— 需要 Shift 的组合键（如插件管理的
   * Ctrl+Shift+X）留在 useGlobalShortcuts 的副表里，因为那里的语义是"另一张表"。
   */
  shortcut?: string;
  /**
   * 是否出现在**面板选择列表**里。
   *
   * `file`（单文件查看器）是 `false`：它不是用户从列表里挑出来的一个"视图"，
   * 而是点某张文件卡片的结果。放进列表会让"文件"与"文件查看器"两个入口指向同一件事。
   */
  chooseable: boolean;
  /**
   * 常驻面板：**切走不卸载**。
   *
   * 浏览器靠它让页面状态活过切换（display:none 不销毁 guest，页面、滚动位置、
   * 表单草稿都还在）。其余面板切走即卸载 —— 重建成本低，留着只会白占内存。
   */
  resident?: boolean;
  content: ComponentType<PanelRenderProps>;
}

/**
 * 注册表本体。用 Map 而不是普通对象：**插入顺序是契约的一部分**（见 PanelDescriptor 的说明），
 * 而对象在整数键上会重排。
 *
 * 值里带一个 `token` 而不只是描述子：见 registerPanel 里 disposer 的说明。
 */
const panels = new Map<string, { descriptor: PanelDescriptor; token: number }>();

/** 每次注册发一个自增 token，用来识别"这个 disposer 属于哪一次注册" */
let registrationSeq = 0;

/** 面板在标签 / 列表上显示的名字。**两个消费方都必须走这里**，不要各自判一次 */
export function panelLabel(panel: PanelDescriptor, translate: (key: string) => string): string {
  return panel.labelText ?? translate(panel.labelKey);
}

/**
 * 注册一个面板，返回注销函数。
 *
 * 返回 disposer 而不是 `unregister(view)` 是刻意的：插件卸载时要撤掉自己贡献的面板，
 * 而"撤掉我当时注册的那一项"比"按 id 删一项"更安全 —— 后者在 id 撞车时会把别人的
 * 面板删掉（内置与插件同名、或两个插件同名）。宿主把返回的函数挂在插件生命周期上，
 * 于是 `onUnload` 漏写也不会留下残留。
 *
 * **disposer 认的是 token 而不是描述对象的身份。** 这一点踩过：插件在模块级建好一份
 * 描述子，`register → unregister → 再 register` 传的是**同一个对象**，于是用身份比较时
 * 旧 disposer 会把新那一项当成自己的删掉。token 让每次注册都是一次新的身份。
 */
export function registerPanel(descriptor: PanelDescriptor): () => void {
  if (panels.has(descriptor.view)) {
    /*
      重复注册**直接抛错**而不是覆盖。
      覆盖是静默的：两个插件用同一个 view 时，后注册的会悄悄顶掉前一个，
      而用户看到的是"某个插件坏了"。抛出去至少能让加载流程把它记成一条可读的错误。
    */
    throw new Error(`面板 "${descriptor.view}" 已被注册，不能重复注册`);
  }
  registrationSeq += 1;
  const token = registrationSeq;
  panels.set(descriptor.view, { descriptor, token });

  return () => {
    // 只在仍是**自己那一次**注册时删：重复调用同一个 disposer 是幂等的，
    // 而"注销后又被重新注册"时旧 disposer 不会误伤新的那一项。
    if (panels.get(descriptor.view)?.token === token) panels.delete(descriptor.view);
  };
}

/** 按 view 取描述；不存在返回 undefined（界面据此显示"这个面板已经不可用"） */
export function getPanel(view: string): PanelDescriptor | undefined {
  return panels.get(view)?.descriptor;
}

/** 全部面板，按注册顺序 */
export function listPanels(): PanelDescriptor[] {
  return [...panels.values()].map((entry) => entry.descriptor);
}

/** 面板选择列表要的那几项（按注册顺序）。`chooseable: false` 的被滤掉 */
export function chooseablePanels(): PanelDescriptor[] {
  return listPanels().filter((panel) => panel.chooseable);
}

/** 带了快捷键的面板，供 useGlobalShortcuts 建表 */
export function panelShortcuts(): { key: string; view: string }[] {
  const out: { key: string; view: string }[] = [];
  for (const entry of panels.values()) {
    const { shortcut, view } = entry.descriptor;
    if (shortcut !== undefined && shortcut !== "") {
      out.push({ key: shortcut.toLowerCase(), view });
    }
  }
  return out;
}
