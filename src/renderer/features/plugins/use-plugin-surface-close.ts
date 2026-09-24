// 插件页面自己请求关闭（`window.oint.close()`）时，把渲染层这一侧的容器收掉。
//
// ## 为什么需要这一条
//
// 面板与模态窗的宿主都是渲染层的 React 组件。插件页面调 `close()` 时，主进程能做的只有
// 两件：摘掉归属登记（于是那个页面立刻调不动宿主），以及**请求**渲染层把容器收掉 ——
// 它没有句柄，关不掉。收容器这一步只能在这里完成。
//
// 不做的症状：用户点了插件页面里的"关闭"，界面照旧开着，而它此后每一次桥调用都被身份
// 闸门拒绝 —— 一个凭空的"点了没反应"，且没有任何地方会报错。
//
// ## 两种容器各收各的
//
//  - 面板：按 `plugin:<pluginId>:<surfaceId>` 关那个标签（标签不在就什么也不做，
//    `closeRightPanelTab` 本来就是这个语义）；
//  - 模态窗：**只有它正好是同一个界面时**才收 —— 无条件 `closePluginModal()` 的话，
//    一个面板的关闭事件会顺手把用户另一个插件的模态窗也关掉。
//
// 独立窗口不进这条路径：那类窗口由主进程建、也由主进程关
//（`PluginSurfaceClosedEvent` 的 kind 里根本没有 `window` 这个位置）。

import { useEffect } from "react";
import { useUiStore } from "@/renderer/stores/ui-store";
import { pluginPanelViewId } from "./use-plugin-panels";

/**
 * 订阅"插件界面自己关了"。
 *
 * 在 App 根部调一次。放在那里而不是各个宿主组件里：事件说的是"某个界面该收了"，
 * 而"这个界面现在开着没有、开在哪里"只有 store 知道 —— 让宿主组件各自订阅，
 * 一个没挂载的宿主就会漏掉属于它的那条事件。
 */
export function usePluginSurfaceClose(): void {
  const closeRightPanelTab = useUiStore((s) => s.closeRightPanelTab);

  useEffect(
    () =>
      window.oint.plugins.onSurfaceClosed((event) => {
        if (event.kind === "panel") {
          closeRightPanelTab(pluginPanelViewId(event.pluginId, event.surfaceId));
          return;
        }
        /*
          模态窗：用 `getState()` 而不是外层那个 hook —— 这个回调不是渲染过程的一部分，
          订阅一次就够（与 plugins-store 里跨 store 调用同一手法）。
        */
        const ui = useUiStore.getState();
        const current = ui.pluginModal;
        if (current?.pluginId === event.pluginId && current.surfaceId === event.surfaceId) {
          ui.closePluginModal();
        }
      }),
    [closeRightPanelTab],
  );
}
