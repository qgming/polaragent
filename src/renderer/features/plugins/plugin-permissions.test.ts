import { describe, expect, it } from "vitest";
import {
  PLUGIN_PERMISSIONS,
  type PluginContributionSummary,
  type PluginPermissionView,
  UNENFORCED_PLUGIN_PERMISSIONS,
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
    expect(permissionLabelKey("fs.read")).toBe("plugins.perm.fsRead");
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
    const key = permissionLabelKey("fs.write");
    expect(key).toBe("plugins.perm.fsWrite");
    expect(key).not.toContain("..");
  });
});

describe("isPermissionEnforced", () => {
  /**
   * **这份清单被逐字钉住，是为了让每一次改动都是有意的。**
   *
   * 它是一张"承诺与实现不符"的账：列进去 = 界面上会打「未生效」，用户因此知道
   * 那条权限今天不管用。两件事都会让它必须被编辑，而两件都是好事：
   *
   * - **实现了某一项** → 从集合里删掉它，界面自动不再标注（这条用例会红，提醒你确认
   *   执行点真的接上了：权限卡不该在能力已经生效之后还说它没生效）；
   * - **新增一项没实现的能力** → 加进来，界面如实标注（否则又是一条做不到的承诺）。
   */
  it("未生效清单逐条钉住（加一项 / 删一项都要改这里）", () => {
    expect([...UNENFORCED_PLUGIN_PERMISSIONS].sort()).toEqual([
      "fs.delete",
      "fs.read",
      "fs.write",
      "session.read",
      "shell.openExternal",
      "ui.view",
    ]);
  });

  it("清单里的每一项都是宿主认识的权限 —— 拼错一个 id 会让标记悄悄失效", () => {
    const known = new Set<string>(PLUGIN_PERMISSIONS);
    const unknown = [...UNENFORCED_PLUGIN_PERMISSIONS].filter((id) => !known.has(id));
    expect(unknown, `这些 id 不在 PLUGIN_PERMISSIONS 里：${unknown.join(", ")}`).toEqual([]);
  });

  it("已实现的能力一律算「生效」—— 没在清单里就是有执行点", () => {
    // 正向：这几条今天都有真执行点（贡献面门禁、界面桥、MCP 装载、命令/工具注册、钩子）
    expect(isPermissionEnforced("skills.contribute")).toBe(true);
    expect(isPermissionEnforced("net.fetch")).toBe(true);
    expect(isPermissionEnforced("shell.exec")).toBe(true);
    expect(isPermissionEnforced("agent.tool.register")).toBe(true);
    /*
      **钩子这条是从"未生效"转过来的**（清单里删掉了它，同时删掉了上面那份清单的一项）。
      留一条断言在这里，是因为"钩子实现了但权限卡还在说它未生效"是一个会活很久的
      静默错误：界面在告诫用户"它不管用"，而它其实会拦住工具调用。
    */
    expect(isPermissionEnforced("hostHooks.register")).toBe(true);
    // 反向：这几条仍然没有执行点
    expect(isPermissionEnforced("fs.write")).toBe(false);
    expect(isPermissionEnforced("session.read")).toBe(false);
  });

  it("表外的权限算「生效」—— 未知不等于未生效", () => {
    // 一个新客户端贡献的权限、或宿主删掉的旧权限：界面显示 id 原文 + 「未知」，
    // 但**不该**再叠一枚「未生效」—— 那会变成"我不认识它，所以它没用"的错误断言。
    expect(isPermissionEnforced("future.unknown.permission")).toBe(true);
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
