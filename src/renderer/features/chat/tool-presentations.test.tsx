/**
 * 工具展示注册表。
 *
 * 它替代了过去**两张并列的 Record**（TOOL_ICONS / TOOL_LABELS，键集合逐字相同）。
 * 所以下面第一组用例的形状就是"这两张表永远同键"这件事的回归保护 ——
 * 过去它靠两处手写维护，现在靠一张表在结构上成立。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_ICON,
  FALLBACK_TOOL_LABELS,
  registerToolPresentation,
  toolActiveLabelKey,
  toolIcon,
  toolLabelKeys,
  toolPresentations,
} from "./tool-presentations";

/** 内置的 27 个工具名（与主进程交付的工具集一一对应） */
const BUILTIN = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "todo",
  "ask_user",
  "read_image",
  "bash_background",
  "job_output",
  "job_list",
  "job_kill",
  "browser_open",
  "browser_history",
  "browser_snapshot",
  "browser_act",
  "browser_wait",
  "browser_screenshot",
  "browser_logs",
  "browser_dialog",
  "browser_evaluate",
  "web_search",
  "web_fetch",
  "Task",
  "TaskWait",
  "TaskList",
  "TaskStop",
];

describe("内置工具展示", () => {
  it("27 项都注册上了", () => {
    const names = toolPresentations().map((item) => item.name);
    for (const name of BUILTIN) {
      expect(names, `${name} 应该已注册`).toContain(name);
    }
    expect(toolPresentations()).toHaveLength(BUILTIN.length);
  });

  it("**每一项都同时有图标与两个文案键** —— 这正是合并两张表要消灭的半成品状态", () => {
    // 过去图标与文案各一张表，加工具时只改一处的症状是「图标对了但名字显示成『调用』」
    for (const item of toolPresentations()) {
      expect(item.Icon, `${item.name} 缺图标`).toBeDefined();
      expect(item.resting, `${item.name} 缺收尾态文案键`).toMatch(/^tools\./);
      expect(item.active, `${item.name} 缺进行态文案键`).toMatch(/^tools\./);
    }
  });

  it("同一个工具的两种状态是不同的键（复制粘贴忘记改的守卫）", () => {
    for (const item of toolPresentations()) {
      expect(item.resting, `${item.name} 的两种状态用了同一个键`).not.toBe(item.active);
    }
  });

  it("键名不重复（两个工具共用一个词条会让其中一个显示错名字）", () => {
    const all = toolPresentations().flatMap((item) => [item.resting, item.active]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("未登记的工具", () => {
  it("MCP 工具落到通用「调用」与默认图标", () => {
    // MCP 的工具名由 server 决定、数量不可预知，不可能逐个登记 —— 回退是正常路径
    expect(toolLabelKeys("mcp__github__search")).toEqual({ ...FALLBACK_TOOL_LABELS });
    expect(toolIcon("mcp__github__search")).toBe(DEFAULT_TOOL_ICON);
  });

  it("插件工具同样回退（在插件注册自己的展示之前）", () => {
    expect(toolLabelKeys("plugin__git_lens__status")).toEqual({ ...FALLBACK_TOOL_LABELS });
    expect(toolIcon("plugin__git_lens__status")).toBe(DEFAULT_TOOL_ICON);
  });

  it("回退返回的是副本 —— 调用方改了不该污染全局表", () => {
    const labels = toolLabelKeys("plugin__x__y");
    labels.resting = "tampered";
    expect(FALLBACK_TOOL_LABELS.resting).toBe("tools.call");
  });

  it("toolActiveLabelKey 走同一条回退", () => {
    expect(toolActiveLabelKey("plugin__x__y")).toBe("tools.callActive");
    expect(toolActiveLabelKey("bash")).toBe("tools.bashActive");
  });
});

describe("registerToolPresentation 的注册表语义", () => {
  it("插件能为自己的工具补上展示", () => {
    const dispose = registerToolPresentation({
      name: "plugin__git_lens__status",
      Icon: toolIcon("bash"),
      resting: "tools.call",
      active: "tools.callActive",
    });
    expect(toolPresentations().map((item) => item.name)).toContain("plugin__git_lens__status");
    dispose();
    expect(toolPresentations().map((item) => item.name)).not.toContain("plugin__git_lens__status");
  });

  it("重复注册抛错而不是静默覆盖", () => {
    expect(() =>
      registerToolPresentation({
        name: "bash",
        Icon: DEFAULT_TOOL_ICON,
        resting: "tools.bash",
        active: "tools.bashActive",
      }),
    ).toThrow(/已被注册/);
  });

  it("注册 → 注销 → 用同一个描述对象再注册时，旧 disposer 不误删新的那一项", () => {
    // 与 panel-registry 同一个坑：用对象身份判断归属时，模块级描述子会让旧 disposer
    // 把新注册的那一项当成自己的删掉。token 才认得出"哪一次注册"。
    const descriptor = {
      name: "test:re-registered",
      Icon: DEFAULT_TOOL_ICON,
      resting: "tools.call",
      active: "tools.callActive",
    };
    const firstDispose = registerToolPresentation(descriptor);
    firstDispose();

    const secondDispose = registerToolPresentation(descriptor);
    firstDispose();
    expect(toolPresentations().map((item) => item.name)).toContain("test:re-registered");
    secondDispose();
  });
});
