/**
 * 界面声明的挑选判据（纯函数，无 electron）。
 *
 * 它挡的是两类真实会发生的错：
 *  1. **只声明模态窗的插件**：attach 那一刻若按 `kind === "panel"` 找界面，会找不到 ——
 *     于是归属登记不上、页面里每次 `window.oint.*` 都被身份闸门拒掉，而它还会被
 *     当成普通浏览器 guest 接管（导航、截图那一套都冲着它去）；
 *  2. **一个插件声明了多个渲染层界面**：认错 surfaceId 之后，"关掉哪一个"会关错。
 *
 * 判据的边界（身份按分区、surfaceId 按 URL 补）写在 surface-decls.ts 的文件头，
 * 这里只钉规则本身。
 */

import { describe, expect, it } from "vitest";
import type { PluginSurfaceDecl } from "@/shared/contracts/plugin";
import { rendererSurfaces, surfaceByUrl } from "./surface-decls";
import { surfaceUrl } from "./surface-url";

const PANEL: PluginSurfaceDecl = {
  id: "home",
  kind: "panel",
  title: "面板",
  entry: "./ui/panel.html",
};

const MODAL: PluginSurfaceDecl = {
  id: "settings",
  kind: "modal",
  title: "设置",
  entry: "./ui/settings.html",
};

const WINDOW: PluginSurfaceDecl = {
  id: "pet",
  kind: "window",
  title: "宠物",
  entry: "./ui/pet.html",
  shape: "widget",
};

describe("rendererSurfaces", () => {
  it("收面板与模态窗", () => {
    expect(rendererSurfaces([PANEL, MODAL]).map((surface) => surface.id)).toEqual([
      "home",
      "settings",
    ]);
  });

  it("窗口不在其中（那类界面由主进程建窗，不走 guest 归属这条路）", () => {
    expect(rendererSurfaces([WINDOW])).toEqual([]);
  });

  it("只有窗口的插件返回空数组 —— 调用方据此判「这不是渲染层界面」而不是拿第一个凑数", () => {
    expect(rendererSurfaces([WINDOW, WINDOW])).toHaveLength(0);
  });

  it("保持清单顺序：attach 时的占位取的就是第一个", () => {
    expect(rendererSurfaces([MODAL, PANEL])[0]?.id).toBe("settings");
  });
});

describe("surfaceByUrl", () => {
  const pluginId = "dev.oint.demo";

  it("按完整 URL 精确匹配", () => {
    const hit = surfaceByUrl(pluginId, [PANEL, MODAL], surfaceUrl(pluginId, MODAL.entry));
    expect(hit?.id).toBe("settings");
  });

  it("没有匹配时返回 undefined —— **不兜底**，否则一次页面内导航会把 surfaceId 覆盖成错的", () => {
    const other = surfaceUrl(pluginId, "./ui/other.html");
    expect(surfaceByUrl(pluginId, [PANEL, MODAL], other)).toBeUndefined();
  });

  it("URL 是空的（attach 那一刻的常态）也返回 undefined，由调用方兜底", () => {
    expect(surfaceByUrl(pluginId, [PANEL, MODAL], "")).toBeUndefined();
  });

  it("插件 id 参与比较：别的插件的同一路径不会命中", () => {
    const foreign = surfaceUrl("dev.other.plugin", PANEL.entry);
    expect(surfaceByUrl(pluginId, [PANEL], foreign)).toBeUndefined();
  });

  it("入参的收窄结果被保住：传渲染层界面进来，拿到的那一份也带 panel | modal", () => {
    const declared = rendererSurfaces([PANEL, MODAL]);
    const hit = surfaceByUrl(pluginId, declared, surfaceUrl(pluginId, PANEL.entry));
    // 类型上就是 "panel" | "modal"，不需要调用方再判一次 kind
    expect(hit?.kind).toBe("panel");
  });
});
