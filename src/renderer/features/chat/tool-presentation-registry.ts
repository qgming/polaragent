// 工具展示注册表：**工具名 → 图标 + 两种状态的文案键**。
//
// ## 为什么要有它
//
// 原先这是**两张并列的表**：`TOOL_ICONS`（27 项图标）与 `TOOL_LABELS`（同样 27 项文案），
// 键集合逐字相同却各写一份 —— 加一个工具要改两处，漏一处的症状是「图标对了但名字显示
// 成通用的『调用』」（或反过来）。合成一张表之后只有一处。
//
// 而它成为**注册表**是为了插件：插件给模型加的工具（`plugin__<key>__<tool>`）不在
// 内置表里，于是它的卡片一直用终端图标 + 通用的「调用」。注册表让插件能补上自己那几项，
// 而不必改这个文件。
//
// ## ⚠️ 字段名是约束，不是风格
//
// `resting` / `active` 这两个字段名**被 scripts/check-i18n.mjs 扫**（它的 KEY_FIELD_RE
// 里有 `resting` 与 `active` —— 那两个看着奇怪的名字就是为这张表准备的）。
// 改成别的名字（比如 `labelKey`）不会报错，但**这两个字段会从词条门禁里消失**：
// i18next 缺键时原样返回键名，界面上直接显示 `tools.bash`。
// 与 features/plugins/plugin-permissions.ts 是同一类陷阱，那边的注释写得更细。
//
// ## 覆盖不到的形态（刻意的）
//
// **详情渲染**（`ToolDetail` 的判别联合 + `resolveToolDetail` 的解析链）不在这个注册表里。
// 那不是"再来一张表"能解决的：插件要渲染自己的结果，需要宿主先定义「插件工具的结果
// 长什么样」—— 那属于 T1（进程外工具）的设计。今天插件工具走的是通用文本/`toolResultText`
// 回退路径，这是**如实的行为**而不是缺陷。

import type { LucideIcon } from "lucide-react";
import { TerminalIcon } from "lucide-react";

export interface ToolPresentation {
  /** 工具名 —— 模型看到的那个（含 `plugin__` / `mcp__` 前缀） */
  name: string;
  Icon: LucideIcon;
  /** 收尾态的文案键 */
  resting: string;
  /** 进行态的文案键 */
  active: string;
}

const presentations = new Map<string, { descriptor: ToolPresentation; token: number }>();
let registrationSeq = 0;

/**
 * 注册一个工具的展示，返回注销函数。
 *
 * token 语义与 panel-registry 一字不差（见那边的说明）：disposer 认的是"哪一次注册"
 * 而不是描述对象的身份 —— 插件在模块级建好一份描述子时，`注册 → 注销 → 再注册`
 * 传的是同一个对象，用身份比较会让旧 disposer 误删新那一项。
 */
export function registerToolPresentation(descriptor: ToolPresentation): () => void {
  if (presentations.has(descriptor.name)) {
    throw new Error(`工具 "${descriptor.name}" 的展示已被注册，不能重复注册`);
  }
  registrationSeq += 1;
  const token = registrationSeq;
  presentations.set(descriptor.name, { descriptor, token });

  return () => {
    if (presentations.get(descriptor.name)?.token === token) presentations.delete(descriptor.name);
  };
}

/** 全部已注册的工具展示，按注册顺序 */
export function toolPresentations(): ToolPresentation[] {
  return [...presentations.values()].map((entry) => entry.descriptor);
}

/**
 * 未登记的工具用哪一个图标。
 *
 * 终端图标是内置的默认：一个不认识的名字，最可能来自一个"跑点什么"的工具
 *（MCP server 的工具、插件工具），终端比一个通用方块更能说明这件事。
 */
export const DEFAULT_TOOL_ICON: LucideIcon = TerminalIcon;

/**
 * 未登记的工具用哪两个文案键。
 *
 * **必须留在代码里的字面量**（而不是拼出来的）：`t()` 的词条门禁要看得见它们。
 */
export const FALLBACK_TOOL_LABELS = {
  resting: "tools.call",
  active: "tools.callActive",
} as const;

/** 工具名 → 词条键；未登记的工具落到通用「调用」 */
export function toolLabelKeys(toolName: string): { resting: string; active: string } {
  const found = presentations.get(toolName)?.descriptor;
  return found === undefined
    ? { ...FALLBACK_TOOL_LABELS }
    : { resting: found.resting, active: found.active };
}

/** 工具进行态的词条键；给消息尾部的运行指示器复用 */
export function toolActiveLabelKey(toolName: string): string {
  return toolLabelKeys(toolName).active;
}

/** 工具名 → 图标；未登记的一律用终端图标 */
export function toolIcon(toolName: string): LucideIcon {
  return presentations.get(toolName)?.descriptor.Icon ?? DEFAULT_TOOL_ICON;
}
