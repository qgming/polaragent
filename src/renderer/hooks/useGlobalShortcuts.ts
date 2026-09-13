import { useEffect } from "react";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/** 组合键判定：统一要求 Ctrl 或 Cmd，避免与输入法/浏览器默认行为冲突 */
function matchesModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

/**
 * 全局快捷键：
 * Ctrl/Cmd+K 搜索模态窗、Ctrl/Cmd+N 新建对话、Ctrl/Cmd+, 打开设置、
 * Ctrl/Cmd+B 折叠侧栏、Ctrl/Cmd+P 右侧「文件」、Ctrl/Cmd+T 右侧「浏览器」。
 * 监听挂在 window 上，输入框内同样生效 —— 这些组合键不承担文本编辑职责。
 *
 * 两个新键落在右侧面板上，是因为右栏的入口只有顶栏那颗按钮，没有快捷键时
 * 「看一眼文件树」这种高频小动作要经过「点按钮 → 点菜单」两步。
 * 提示标签由 RightPanelMenu 按同一份元数据渲染，两处不会漂移。
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!matchesModifier(event)) return;
      const ui = useUiStore.getState();

      switch (event.key.toLowerCase()) {
        case "k":
          event.preventDefault();
          if (ui.searchOpen) ui.closeSearch();
          else ui.openSearch();
          break;
        case "n":
          event.preventDefault();
          void useChatStore.getState().createSession();
          break;
        case ",":
          event.preventDefault();
          ui.openSettings();
          break;
        case "b":
          event.preventDefault();
          ui.toggleSidebar();
          break;
        // 右栏两个带快捷键的视图：Ctrl+P 文件、Ctrl+T 浏览器。
        // 与主流编辑器/浏览器的「快速打开文件」「新建标签页」同键，肌肉记忆直接可用。
        // 按键落到 openRightPanel 而不是直接开面板：它自带「再按一次收起」的开关语义。
        case "p":
          event.preventDefault();
          ui.openRightPanel("files");
          break;
        case "t":
          event.preventDefault();
          ui.openRightPanel("browser");
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
