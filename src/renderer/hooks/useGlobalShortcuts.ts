import { useEffect } from "react";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/** 组合键判定：统一要求 Ctrl 或 Cmd，避免与输入法/浏览器默认行为冲突 */
function matchesModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

/**
 * 全局快捷键（设计稿 F-14）：
 * Ctrl/Cmd+K 搜索模态窗、Ctrl/Cmd+N 新建对话、Ctrl/Cmd+, 打开设置、Ctrl/Cmd+B 折叠侧栏。
 * 监听挂在 window 上，输入框内同样生效——这些组合键不承担文本编辑职责。
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
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
