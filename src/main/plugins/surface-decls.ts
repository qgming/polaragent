// 界面**声明**的挑选判据：一堆 `surfaces[]` 里，哪一个对应这次要打开的 URL / 这个 webview。
//
// ## 为什么单独一个模块
//
// 这两条判据本来写在 `surfaces.ts` 里（那里创建窗口、装权限门、登记归属），
// 而那个文件 import electron —— 于是判据**没法在 node 环境的单测里跑**。
// 抽到这里之后它们是纯函数：同一个理由与 net-guard.ts / surface-url.ts 一样，
// 越界与错认这类错误必须能用单测钉住。
//
// ## 这两个函数在解决什么
//
// 宿主在渲染层的界面（面板 / 模态窗）都是主渲染层里的 `<webview>`，主进程要到
// `did-attach-webview` 才拿得到它的 webContents，而那一刻**导航还没提交、URL 往往是空的**。
// 于是"这是哪一个界面"这件事只能这样得到：
//
//   · **身份**（哪个插件）按分区判 —— 分区在 attach 时一定就绪，它本来就是权威来源；
//   · **surfaceId** 先取第一个渲染层界面占位，等 `did-navigate` 拿到 URL 后再按它修正。
//
// 修正不是安全边界（宿主的桥接判据只看 pluginId，见 surface-owners.ts），
// 但**不修正就会认错界面**：一个插件声明了两个模态窗时，第二个会被记成第一个的 id，
// 于是"关掉哪一个"会关错。这条曾经是写死的 `kind === "panel"` —— 一个只声明模态窗的
// 插件连归属都登记不上（它的界面会被当成普通浏览器 guest 接管）。

import type { PluginSurfaceDecl } from "@/shared/contracts/plugin";
import { surfaceUrl } from "./surface-url";

/** 宿主在渲染层的界面形态：面板与模态窗（`window` 由主进程建窗，不走这条路） */
export type RendererSurfaceDecl = PluginSurfaceDecl & { kind: "panel" | "modal" };

/**
 * 挑出**宿主在渲染层**的界面声明，按清单顺序。
 *
 * 返回空数组表示这个插件的界面全是独立窗口 —— 调用方据此判定"这个 guest 不是
 * 渲染层宿主的界面"（而不是把它当成第一个来凑数）。
 */
export function rendererSurfaces(surfaces: readonly PluginSurfaceDecl[]): RendererSurfaceDecl[] {
  return surfaces.filter((surface): surface is RendererSurfaceDecl => surface.kind !== "window");
}

/**
 * 这个 URL **精确**对应清单里的哪一份界面声明；没有精确匹配时返回 undefined。
 *
 * 比较的是完整 URL（由 `surfaceUrl` 唯一地生成，见那边的"一种形状，一个产地"），
 * 而不是路径后缀一类模糊判据：模糊匹配会把"插件页面自己导航到的另一个资源"
 * 认成某个界面声明。
 *
 * 注意**不做兜底**（不返回第一个）：兜底是调用方在 attach 时刻才需要的行为，
 * 而这条函数在 URL 修正那条路上必须能回答"没有匹配" —— 否则一次页面内导航
 * 会把 surfaceId 覆盖成错的。
 *
 * 泛型是为了**保住入参的收窄结果**：传 `RendererSurfaceDecl[]` 进来，
 * 拿到的那一份也是 `RendererSurfaceDecl`，调用方不必再判一次 kind。
 */
export function surfaceByUrl<T extends PluginSurfaceDecl>(
  pluginId: string,
  surfaces: readonly T[],
  url: string,
): T | undefined {
  return surfaces.find((surface) => surfaceUrl(pluginId, surface.entry) === url);
}
