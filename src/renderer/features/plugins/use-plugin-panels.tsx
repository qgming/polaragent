// 把**已启用插件贡献的面板**同步进右侧面板注册表。
//
// ## 为什么需要"同步"而不是"注册一次"
//
// 面板注册表是进程内的一张静态表（第二轮做的），而插件是**运行期可增删启停**的：
// 用户装一个插件、启用它，它的面板就该出现在右栏的选择列表里；停用之后要消失。
// 所以这里做的事是**差分**：算出"现在应该有哪些"，与"已经注册了哪些"比对，
// 该加的加、该撤的撤。
//
// ## 为什么放在一个 hook 里，而不是让插件 store 直接注册
//
// 因为 `registerPanel` 的第二个参数要一个 **React 组件**（面板的内容），
// 而 store 是纯状态、不该 import 组件。放 hook 里也让"什么时候同步"这件事
// 只有一个答案：**跟着 `plugins:list` 的结果走**。
//
// ## 视图 id 的形状
//
// `plugin:<pluginId>:<surfaceId>` —— 三段式。第二轮做面板注册表时就把这个形状
// 写进了 PanelDescriptor.view 的注释（"让'这是谁的面板'在 id 里就能读出来"），
// 这里只是把它实现出来。它同时是 `closeAllSurfacesOfPlugin` 那类批量操作的对齐点。

import { Plug } from "lucide-react";
import { useEffect } from "react";
import { type PanelDescriptor, registerPanel } from "@/renderer/features/right-panel/panels";
import type { PluginSurfaceInfo, PluginView } from "@/shared/contracts/plugin";
import { PluginSurfacePanel } from "./PluginSurfacePanel";

/** 插件面板在注册表里的视图 id */
export function pluginPanelViewId(pluginId: string, surfaceId: string): string {
  return `plugin:${pluginId}:${surfaceId}`;
}

/**
 * 已注册的插件面板：视图 id → 注销函数。
 *
 * 放模块级而不是 `useRef`：同一份注册表是**全应用唯一**的，两个组件各持一个 ref
 * 会各自以为自己是唯一的管理者，于是重复注册抛错（而那个错看起来像"插件坏了"）。
 * 这个模块是那份表唯一的管理者，所以状态也放这里。
 */
const disposers = new Map<string, () => void>();

/** 当前应该存在的插件面板：从 `plugins:list` 的结果算出来 */
function wantedPanels(
  views: readonly PluginView[],
): Map<string, { descriptor: PanelDescriptor; surface: PluginSurfaceInfo }> {
  const wanted = new Map<string, { descriptor: PanelDescriptor; surface: PluginSurfaceInfo }>();
  for (const view of views) {
    /*
      **只有启用且清单合法的插件贡献面板。**
      `invalid` 的那一类 `surfaces` 是空的（映射不出来），所以这里判 enabled 就够；
      但显式写上 state 的判断是为了让"坏插件不贡献任何东西"这条规则在代码里看得见。
    */
    if (!view.enabled || view.state === "invalid") continue;
    for (const surface of view.surfaces) {
      if (surface.kind !== "panel") continue;
      const id = pluginPanelViewId(view.id, surface.id);
      wanted.set(id, {
        surface,
        descriptor: {
          view: id,
          // 占位键：真正的名字走 labelText。留一个**存在的**键而不是空串，
          // 万一有别的路径读了 labelKey，显示的是一个可读的词条而不是空白
          labelKey: "plugins.panelFallbackLabel",
          labelText: surface.title,
          /*
            插件面板的图标：目前统一用插件图标。
            清单里已经有 `icon` 这个 token 字段（封闭集合），接上它要先把
            token → Lucide 组件的映射表建出来，而那属于"图标 token 表"那件事，
            与面板槽不是一回事。**先给一个正确的默认，而不是让它没有图标。**
          */
          Icon: Plug,
          chooseable: true,
          /*
            `resident: false`（缺省）：切走即卸载。
            插件面板要不要常驻由插件自己决定吗？不 —— 常驻的代价是**内存与后台活动**
            （一个 guest 进程一直活着），那是用户该决定的事，而宿主还没给他这个开关。
            所以默认瞬时；等有了"固定面板"这个功能再让它可选。
          */
          content: () => <PluginSurfacePanel surface={surface} />,
        },
      });
    }
  }
  return wanted;
}

/** 把注册表对齐到"当前应该有哪些"。幂等，可以反复调用 */
export function syncPluginPanels(views: readonly PluginView[]): void {
  const wanted = wantedPanels(views);

  // 先撤：不再需要的
  for (const [id, dispose] of [...disposers]) {
    if (wanted.has(id)) continue;
    dispose();
    disposers.delete(id);
  }

  // 再补：新出现的
  for (const [id, entry] of wanted) {
    if (disposers.has(id)) continue;
    try {
      disposers.set(id, registerPanel(entry.descriptor));
    } catch {
      /*
        重复注册**吞掉**而不是让整个同步失败。
        什么情况下会走到这里：两个插件贡献了同一个 view id —— 而那要求两个插件的
        id 与 surfaceId 都相同，也就是**同一份清单被扫到两次**（开发插件同时挂在
        installed 里）。那种情况下注册表里已经有一份能用的，跳过即可；
        抛出会让这一次同步整个中断，连其它插件的面板都装不上。
      */
    }
  }
}

/**
 * 跟着插件列表同步面板注册表。
 *
 * 依赖的是 `views` 的**引用**：plugins-store 每次真的变了才换引用
 *（IPC 返回新数组），所以这个 effect 不会在无关的重渲染里空跑。
 */
export function usePluginPanels(views: readonly PluginView[] | null): void {
  useEffect(() => {
    syncPluginPanels(views ?? []);
  }, [views]);

  /*
    卸载时**不撤**任何东西。
    这个 hook 只在 App 根部调一次，它卸载等于整个应用卸载 ——
    那时撤注册表没有意义，反而会在测试里制造"前一个用例的清理影响了后一个"。
  */
}
