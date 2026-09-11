import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import { SearchModal } from "@/renderer/features/search";
import { SettingsModal } from "@/renderer/features/settings";
import { useGlobalShortcuts } from "@/renderer/hooks/useGlobalShortcuts";
import { PolarRuntimeProvider } from "@/renderer/runtime/PolarRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { MainShell } from "./MainShell";
import { SidebarShell } from "./SidebarShell";
import { TitleBar } from "./TitleBar";

export function App() {
  // 全局快捷键在应用根部注册一次，模态与面板都由各自 store 控制显隐
  useGlobalShortcuts();

  useEffect(() => {
    // 启动加载：设置（含主题应用与系统主题监听）+ 会话列表；IPC 失败不影响界面骨架
    void useSettingsStore
      .getState()
      .init()
      .catch(() => {});
    void useChatStore
      .getState()
      .loadSessions()
      .catch(() => {});
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      {/* reducedMotion="user"：JS 动效统一跟随系统偏好，与 CSS 侧的 prefers-reduced-motion 兜底对齐 */}
      <MotionConfig reducedMotion="user">
        <div className="flex h-screen flex-col bg-background text-foreground">
          <TitleBar />
          {/* 运行时包住侧栏与主区：侧栏的会话列表走官方 ThreadList primitives，需要 runtime 上下文 */}
          <PolarRuntimeProvider>
            <div className="flex min-h-0 flex-1">
              <SidebarShell />
              <MainShell />
            </div>
          </PolarRuntimeProvider>
        </div>
        {/* 浮层挂载在布局之外，避免受侧栏/主区的溢出裁剪 */}
        <SettingsModal />
        <SearchModal />
      </MotionConfig>
    </TooltipProvider>
  );
}
