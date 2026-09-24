// 设置分栏的注册表 —— 与右侧面板注册表（features/right-panel/panel-registry.ts）同构。
//
// 加一个设置分栏原先是**四处 + 一处隐式**：ui-store 的类型联合与顺序表、
// SettingsModal 的 SECTIONS 数组与 renderPanel 的 switch。而第 5 处最隐蔽：
// SearchModal 用 `` t(`settings.${section}`) `` 拼 i18n 键，**它依赖"section id 恰好
// 等于文案键的后缀"这条没人写下来的约定** —— 改一个 id 会让搜索里的那一项显示成
// `settings.foo`，而编译器与 lint 都不会响。
//
// 现在只剩一处：注册一行，且**文案键是描述子里的字面量**（不再拼串）。

import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export interface SettingsSectionDescriptor {
  /** 稳定 id，同时是 Tabs 的 value */
  id: string;
  /**
   * 文案键。**必须是字面量**（`"settings.general"`），不要拼串 ——
   * scripts/check-i18n.mjs 抓的就是字面量，拼出来的键漏译不会被门禁拦住。
   */
  labelKey: string;
  Icon: LucideIcon;
  /** 分栏内容。**无参组件**：分栏自己从 store / IPC 取需要的东西 */
  content: ComponentType;
}

const sections = new Map<string, { descriptor: SettingsSectionDescriptor; token: number }>();
let registrationSeq = 0;

/** 注册一个分栏，返回注销函数（token 语义与 registerPanel 一字不差，见那边的说明） */
export function registerSettingsSection(descriptor: SettingsSectionDescriptor): () => void {
  if (sections.has(descriptor.id)) {
    throw new Error(`设置分栏 "${descriptor.id}" 已被注册，不能重复注册`);
  }
  registrationSeq += 1;
  const token = registrationSeq;
  sections.set(descriptor.id, { descriptor, token });

  return () => {
    if (sections.get(descriptor.id)?.token === token) sections.delete(descriptor.id);
  };
}

/** 全部分栏，按注册顺序（左导航与搜索里的「设置」结果都读它） */
export function settingsSections(): SettingsSectionDescriptor[] {
  return [...sections.values()].map((entry) => entry.descriptor);
}

/** 按 id 取描述；不存在返回 undefined */
export function getSettingsSection(id: string): SettingsSectionDescriptor | undefined {
  return sections.get(id)?.descriptor;
}
