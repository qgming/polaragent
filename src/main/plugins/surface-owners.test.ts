/**
 * 界面归属表。
 *
 * 它是**桥接权限边界的全部**：主进程不信任调用方自报的 pluginId，只信
 * `event.sender.id` 在这张表里的登记（见文件头的说明）。
 * 所以下面重点验三件事：查得到、注销得干净、按插件批量清得掉。
 */

import { describe, expect, it } from "vitest";
import { createSurfaceOwners } from "./surface-owners";

const PANEL = { pluginId: "dev.example.git-lens", surfaceId: "git", kind: "panel" } as const;
const WINDOW = { pluginId: "dev.example.pet", surfaceId: "pet", kind: "window" } as const;

describe("登记与查询", () => {
  it("登记后查得到", () => {
    const owners = createSurfaceOwners();
    owners.claim(7, PANEL);
    expect(owners.ownerOf(7)).toEqual(PANEL);
    expect(owners.size()).toBe(1);
  });

  it("没登记过的编号查不到 —— 这就是「非插件界面调不动宿主」的实现", () => {
    const owners = createSurfaceOwners();
    expect(owners.ownerOf(999)).toBeUndefined();
  });

  it("不同编号可以是不同插件的界面", () => {
    const owners = createSurfaceOwners();
    owners.claim(1, PANEL);
    owners.claim(2, WINDOW);
    expect(owners.ownerOf(1)?.pluginId).toBe("dev.example.git-lens");
    expect(owners.ownerOf(2)?.pluginId).toBe("dev.example.pet");
  });
});

describe("release", () => {
  it("注销返回原来的归属，之后查不到", () => {
    const owners = createSurfaceOwners();
    owners.claim(7, PANEL);
    expect(owners.release(7)).toEqual(PANEL);
    expect(owners.ownerOf(7)).toBeUndefined();
    expect(owners.size()).toBe(0);
  });

  it("注销没登记过的编号是安全的（返回 undefined，不抛错）", () => {
    // 销毁事件可能重复到达（窗口关闭 + 进程退出各一次），抛错会让清理路径本身出错
    const owners = createSurfaceOwners();
    expect(owners.release(999)).toBeUndefined();
  });

  it("注销后反转索引也干净了（不会留下一个空的插件条目）", () => {
    const owners = createSurfaceOwners();
    owners.claim(7, PANEL);
    owners.release(7);
    expect(owners.idsOfPlugin(PANEL.pluginId)).toEqual([]);
  });
});

describe("**重复登记覆盖而不是抛错**", () => {
  it("同一个编号被重新登记时，旧的归属被摘掉", () => {
    /*
      webContents 编号会被复用：Chromium 销毁一个之后会把编号发给下一个。
      抛错的话，一次漏掉的 release 会让此后所有复用该编号的界面都装不上 ——
      而症状是"插件界面打开是白的、点了没反应"，且只在特定操作顺序下复现。
      覆盖是自我修复的。
    */
    const owners = createSurfaceOwners();
    owners.claim(7, PANEL);
    owners.claim(7, WINDOW);

    expect(owners.ownerOf(7)).toEqual(WINDOW);
    // 旧插件不该还认为 7 是自己的
    expect(owners.idsOfPlugin(PANEL.pluginId)).toEqual([]);
    expect(owners.idsOfPlugin(WINDOW.pluginId)).toEqual([7]);
    expect(owners.size()).toBe(1);
  });
});

describe("按插件批量清（停用 / 卸载时用）", () => {
  it("只清掉目标插件，别的插件不受影响", () => {
    const owners = createSurfaceOwners();
    owners.claim(1, PANEL);
    owners.claim(2, { ...PANEL, surfaceId: "other" });
    owners.claim(3, WINDOW);

    expect(owners.releasePlugin(PANEL.pluginId).sort()).toEqual([1, 2]);
    expect(owners.ownerOf(1)).toBeUndefined();
    expect(owners.ownerOf(2)).toBeUndefined();
    // 别的插件的界面**必须还在** —— 停用一个插件不该把别人的面板关掉
    expect(owners.ownerOf(3)).toEqual(WINDOW);
    expect(owners.size()).toBe(1);
  });

  it("返回被清掉的编号，供调用方去关对应的窗口 / webview", () => {
    const owners = createSurfaceOwners();
    owners.claim(5, PANEL);
    expect(owners.releasePlugin(PANEL.pluginId)).toEqual([5]);
  });

  it("清单个不存在的插件返回空数组（清理路径要能重复跑）", () => {
    const owners = createSurfaceOwners();
    expect(owners.releasePlugin("dev.example.nope")).toEqual([]);
  });

  it("idsOfPlugin 返回的是副本，调用方改了不影响表", () => {
    const owners = createSurfaceOwners();
    owners.claim(1, PANEL);
    owners.idsOfPlugin(PANEL.pluginId).push(999);
    expect(owners.idsOfPlugin(PANEL.pluginId)).toEqual([1]);
  });
});
