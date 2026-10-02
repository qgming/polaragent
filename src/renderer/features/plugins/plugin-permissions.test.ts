import { describe, expect, it } from "vitest";
import {
  PLUGIN_PERMISSIONS,
  type PluginContributionSummary,
  type PluginPermissionView,
} from "@/shared/contracts/plugin";
import {
  contributionChips,
  contributionTotal,
  isPermissionEnforced,
  permissionLabelKey,
  riskChipClass,
  sortPermissions,
} from "./plugin-permissions";

/**
 * 这一组用例钉的是**三个容易在重构里悄悄丢掉的约定**：
 *  1. 表外的权限必须能被识别出来（返回 undefined），界面据此显示 id 原文；
 *  2. 权限按风险从高到低排（用户先看到危险的）；
 *  3. 计数为 0 的贡献物不出现（零不是信息）。
 */

describe("permissionLabelKey", () => {
  it("已定义的权限返回字面量文案键", () => {
    expect(permissionLabelKey("ui.panel")).toBe("plugins.perm.uiPanel");
    expect(permissionLabelKey("shell.exec")).toBe("plugins.perm.shellExec");
    expect(permissionLabelKey("fs.read")).toBeUndefined();
  });

  it("**宿主认识的每一项权限都有展示文案** —— 加权限时漏改这里会红", () => {
    /*
      这条是跨端一致性断言：`PLUGIN_PERMISSIONS`（共享契约里的能力目录）是唯一真源，
      主进程的校验器按它判合法性、风险表按它给档位，而**界面按它找文案**。

      漏了的话不会报错 —— 界面会退化成显示权限 id 原文（`fs.write` 而不是「写入文件」），
      而那正是这个仓库反复踩过的形态：渲染成功、断言也过，只有肉眼看界面才发现。

      真正的保护是 check-i18n（它扫 `labelKey:` 字段），这条是它之前的一道快速闸门。
    */
    const missing = PLUGIN_PERMISSIONS.filter((id) => permissionLabelKey(id) === undefined);
    expect(missing, `这些权限没有展示文案：${missing.join(", ")}`).toEqual([]);
  });

  it("表外的权限返回 undefined —— 界面据此显示 id 原文而不是留白", () => {
    // 症状对照：返回空串 / 抛错都会让界面出现一行「什么都没有」，
    // 而用户该看到的是「有个我不认识的权限」。
    expect(permissionLabelKey("future.unknown.permission")).toBeUndefined();
    expect(permissionLabelKey("")).toBeUndefined();
  });

  it("权限 id 自带点号，但文案键必须是扁平的 camelCase", () => {
    // 拼串（`plugins.perm.${id}`）会撞上 i18next 的点号嵌套语义，
    // 这条用例把「表驱动」这个形状本身钉住。
    const key = permissionLabelKey("clipboard.write");
    expect(key).toBe("plugins.perm.clipboardWrite");
    expect(key).not.toContain("..");
  });
});

describe("isPermissionEnforced", () => {
  it("all published capabilities have a real enforcement point", () => {
    expect(PLUGIN_PERMISSIONS.every(isPermissionEnforced)).toBe(true);
    expect(isPermissionEnforced("fs.write")).toBe(false);
  });
});

describe("sortPermissions", () => {
  const perm = (id: string, risk: PluginPermissionView["risk"]): PluginPermissionView => ({
    id,
    risk,
  });

  it("按 high → medium → low 排序", () => {
    const input = [perm("a", "low"), perm("b", "high"), perm("c", "medium")];
    expect(sortPermissions(input).map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("同档保持原顺序（稳定排序）—— 列表不该在每次渲染时抖动", () => {
    const input = [perm("a", "high"), perm("b", "high"), perm("c", "high")];
    expect(sortPermissions(input).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("不改动入参", () => {
    const input = [perm("a", "low"), perm("b", "high")];
    sortPermissions(input);
    expect(input.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("contributionChips / contributionTotal", () => {
  const summary = (partial: Partial<PluginContributionSummary>): PluginContributionSummary => ({
    panels: 0,
    modals: 0,
    windows: 0,
    commands: 0,
    skills: 0,
    prompts: 0,
    subagents: 0,
    mcpServers: 0,
    tools: 0,
    ...partial,
  });

  it("只返回计数大于 0 的项 —— 零不该出现在 chip 行里", () => {
    const chips = contributionChips(summary({ panels: 1, tools: 2 }));
    expect(chips).toEqual([
      { key: "plugins.contrib.panels", count: 1 },
      { key: "plugins.contrib.tools", count: 2 },
    ]);
  });

  it("顺序按界面可读性而不是结构体字段顺序（界面 → 能力 → 数据）", () => {
    const chips = contributionChips(summary({ tools: 1, panels: 1, mcpServers: 1 }));
    expect(chips.map((chip) => chip.key)).toEqual([
      "plugins.contrib.panels",
      "plugins.contrib.mcpServers",
      "plugins.contrib.tools",
    ]);
  });

  it("全为 0 时返回空数组（界面据此显示「无贡献物」）", () => {
    expect(contributionChips(summary({}))).toEqual([]);
  });

  it("总数把八个字段全算进去", () => {
    expect(contributionTotal(summary({ panels: 1, windows: 2, commands: 3 }))).toBe(6);
    expect(contributionTotal(summary({}))).toBe(0);
  });
});

describe("riskChipClass", () => {
  it("三档各不相同 —— 同色的「警告」和「危险」等于没有分档", () => {
    const classes = [riskChipClass("low"), riskChipClass("medium"), riskChipClass("high")];
    expect(new Set(classes).size).toBe(3);
  });

  it("高危用仓库既有的错误配色，中危用既有的警告配色", () => {
    // 与 approval-card / SubagentsPanel 同一口径 —— 不新造一套颜色，
    // 否则同一个界面里会出现两种「警告黄」。
    expect(riskChipClass("high")).toContain("red-600");
    expect(riskChipClass("medium")).toContain("amber-600");
  });
});
