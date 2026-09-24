import { useEffect } from "react";
// 从 panels.ts（唯一入口）导入：它会先跑内置面板的注册副作用，再暴露查询函数
import { panelShortcuts } from "@/renderer/features/right-panel/panels";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/**
 * 基础修饰键判定：必须带 Ctrl 或 Cmd，且不带 Alt。
 *
 * **Shift 刻意不在这里判**。修复前这里是 `(ctrl||meta) && !alt`，没有检查 shiftKey ——
 * 于是 `Ctrl+Shift+K` 也命中 `case "k"` 触发搜索（`event.key` 是 `"K"`，
 * `toLowerCase()` 之后就是 `"k"`），`Ctrl+Shift+N/B/P/T` 同理。当时没有快捷键依赖
 * Shift，所以没人报；但一旦新增一个 Shift 组合，这个「隐式容忍」就变成真冲突。
 *
 * 现在派发分成**两张表**（见 handler）：不带 Shift 的走主表，带 Shift 的走副表。
 * 这样「Shift 是否参与」在结构上成立，而不是靠每个 case 各自记得去判。
 */
function isBaseCombo(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

/**
 * 全局快捷键：
 * Ctrl/Cmd+K 搜索模态窗、Ctrl/Cmd+N 新建对话、Ctrl/Cmd+, 打开设置、
 * Ctrl/Cmd+B 折叠侧栏、Ctrl/Cmd+P 右侧「文件」、Ctrl/Cmd+T 右侧「浏览器」、
 * Ctrl/Cmd+Shift+X 插件管理。
 * 监听挂在 window 上，输入框内同样生效 —— 这些组合键不承担文本编辑职责。
 *
 * 两个新键落在右侧面板上，是因为右栏的入口只有顶栏那颗按钮，没有快捷键时
 * 「看一眼文件树」这种高频小动作要经过「点按钮 → 点菜单」两步。
 * 提示标签由 RightPanelChooser 按同一份元数据渲染，两处不会漂移。
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isBaseCombo(event)) return;
      const ui = useUiStore.getState();
      const key = event.key.toLowerCase();

      /*
        带 Shift 的副表。

        Ctrl/Cmd+Shift+X 与 VS Code 的扩展面板同键，肌肉记忆直接可用。
        它**只在这一张表里** —— 主表里的六个键都不接受 Shift，
        所以 Ctrl+Shift+K 不会再误触搜索。
      */
      if (event.shiftKey) {
        switch (key) {
          case "x":
            event.preventDefault();
            if (ui.pluginsOpen) ui.closePlugins();
            else ui.openPlugins();
            break;
          default:
            break;
        }
        return;
      }

      switch (key) {
        case "k":
          event.preventDefault();
          if (ui.searchOpen) ui.closeSearch();
          else ui.openSearch();
          return;
        case "n":
          event.preventDefault();
          void useChatStore.getState().createSession();
          return;
        case ",":
          event.preventDefault();
          ui.openSettings();
          return;
        case "b":
          event.preventDefault();
          ui.toggleSidebar();
          return;
        default:
          break;
      }

      /*
        右栏面板的快捷键**来自注册表**，不在这里写死。

        过去这里有两行 `case "p"` / `case "t"` 硬编码到 `openRightPanel("files")` /
        `("browser")`，于是"给面板加个快捷键"要改两处（描述子里写一遍、这里再写一遍），
        而漏改的症状是"提示里显示了键，按下去没反应"。

        按键落到 `openRightPanel`：它展开面板并切到那个视图的标签，已有标签就复用 ——
        所以 Ctrl+T 是「切到浏览器」（没有再建一个），多开走面板上的「+」，
        不让同一个键在「切过去」和「再开一个」之间二选一。

        **顺序是刻意的：全局键在上面，面板键在这里。** 反过来的话，一个插件注册一个
        `Ctrl+K` 的面板就能顶掉全局搜索 —— 内置的六个全局键不该被任何扩展遮蔽。
        每次按键现查（而不是启动时建表）：插件是运行期注册的，缓存会让它的快捷键失效。
      */
      const panelView = panelShortcuts().find((entry) => entry.key === key)?.view;
      if (panelView !== undefined) {
        event.preventDefault();
        ui.openRightPanel(panelView);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
