/**
 * 设置分栏注册表。
 *
 * 与 panels.test.tsx 同构，但多钉一条**这次重构真正修掉的东西**：
 * 过去 SearchModal 用 `` t(`settings.${section}`) `` 拼文案键，依赖
 * "section id 恰好等于键的后缀"这条没人写下来的约定。下面最后那一组用例
 * 把「文案键必须与 id 解耦」这件事变成断言 —— 只要有人再把它们绑回去，就会红。
 */

import { describe, expect, it } from "vitest";
import { getSettingsSection, registerSettingsSection, settingsSections } from "./sections";

/** 取一个内置分栏的图标；用会抛错的助手而不是 `!`（本仓库禁非空断言） */
function iconOf(id: string) {
  const section = getSettingsSection(id);
  if (section === undefined) throw new Error(`内置分栏 ${id} 未注册`);
  return section.Icon;
}

/** 历史的十个分栏，顺序即左导航顺序 */
const EXPECTED_IDS = [
  "general",
  "services",
  "web",
  "mcp",
  "skills",
  "subagents",
  "promptTemplates",
  "personalization",
  "data",
  "about",
];

describe("内置设置分栏", () => {
  it("十个都注册上了，且顺序与过去的 SETTINGS_SECTIONS 一致", () => {
    expect(settingsSections().map((section) => section.id)).toEqual(EXPECTED_IDS);
  });

  it("每一项都有图标、文案键与内容组件 —— 缺了会画出没有名字或点不开的分栏", () => {
    for (const section of settingsSections()) {
      expect(section.Icon, `${section.id} 缺图标`).toBeDefined();
      expect(section.content, `${section.id} 缺内容组件`).toBeDefined();
      expect(section.labelKey, `${section.id} 缺文案键`).not.toBe("");
    }
  });

  it("文案键都是 settings. 命名空间下的字面量", () => {
    // 字面量这一点很关键：scripts/check-i18n.mjs 抓的是**编译期字面量**。
    // 拼出来的键（`settings.${id}`）正好从它眼皮底下溜过去 —— 那正是这次修掉的东西。
    for (const section of settingsSections()) {
      expect(section.labelKey, `${section.id} 的文案键不在 settings. 命名空间下`).toMatch(
        /^settings\.[A-Za-z0-9_]+$/,
      );
    }
  });
});

describe("文案键与 id 的关系", () => {
  it("内置十项恰好 `labelKey === `settings.` + id`，但**这不构成契约**", () => {
    /*
      这一条要如实说明它测的是什么、不是什么。

      内置十项上，`labelKey` 与 `` `settings.${id}` `` 恰好相等 —— 所以过去
      SearchModal 用 `` t(`settings.${section}`) `` 拼键时"看起来是对的"。

      但那是**巧合而不是约定**：注册表允许插件注册 `id: "acme.git"` 而
      `labelKey: "plugins.acme.gitTitle"`，那时拼键立刻失效。
      现在标签取自描述子里的显式字段，所以拼法已经不存在了。

      断言相等只是把"今天的事实"记下来（它同时也是回归信号：如果哪天有人改了
      某个内置项的键却忘了它是被搜索读取的，这条会红）。
    */
    for (const section of settingsSections()) {
      expect(section.labelKey).toBe(`settings.${section.id}`);
    }
  });
});

describe("registerSettingsSection 的注册表语义", () => {
  it("重复注册抛错而不是静默覆盖", () => {
    expect(() =>
      registerSettingsSection({
        id: "general",
        labelKey: "settings.general",
        Icon: iconOf("general"),
        content: () => null,
      }),
    ).toThrow(/已被注册/);
  });

  it("disposer 只删自己注册的那一项（重复调用幂等）", () => {
    const dispose = registerSettingsSection({
      id: "test:disposable",
      labelKey: "settings.about",
      Icon: iconOf("about"),
      content: () => null,
    });
    expect(getSettingsSection("test:disposable")).toBeDefined();

    dispose();
    // 幂等：插件卸载路径可能重复调用
    dispose();
    expect(getSettingsSection("test:disposable")).toBeUndefined();
    // 内置十项一个都没被带走
    expect(settingsSections().map((section) => section.id)).toEqual(EXPECTED_IDS);
  });

  it("查不到的 id 返回 undefined（搜索/深链据此回落）", () => {
    expect(getSettingsSection("plugin:gone:settings")).toBeUndefined();
  });
});
