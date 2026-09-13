import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import { RightSidebar } from "@/renderer/features/right-panel/RightSidebar";
import { SearchModal } from "@/renderer/features/search";
import { SettingsModal } from "@/renderer/features/settings";
import { useGlobalShortcuts } from "@/renderer/hooks/useGlobalShortcuts";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { MainShell } from "./MainShell";
import { SidebarShell } from "./SidebarShell";
import { TitleBar } from "./TitleBar";

export function App() {
  // 全局快捷键在应用根部注册一次，模态与面板都由各自 store 控制显隐
  useGlobalShortcuts();

  useEffect(() => {
    // 启动加载：设置（含主题应用与系统主题监听）+ 会话列表 + 项目列表；IPC 失败不影响界面骨架
    void useSettingsStore
      .getState()
      .init()
      .catch(() => {});
    void useChatStore
      .getState()
      .loadSessions()
      .catch(() => {});
    // 项目列表决定侧栏「项目」分组的内容，与会话列表一起在启动时拉一次
    void useProjectsStore
      .getState()
      .load()
      .catch(() => {});
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      {/* reducedMotion="user"：JS 动效统一跟随系统偏好，与 CSS 侧的 prefers-reduced-motion 兜底对齐 */}
      <MotionConfig reducedMotion="user">
        {/* 左右两栏都从窗口顶边开始：侧栏自带顶行（品牌 + 折叠/搜索），内容区顶栏只横跨内容区，
            所以这里是「一行两栏」，而不是原来的「整宽顶栏 + 两栏」。 */}
        <div className="flex h-screen bg-background text-foreground">
          {/* 运行时包住侧栏与主区：侧栏的会话列表走官方 ThreadList primitives，需要 runtime 上下文 */}
          <OintRuntimeProvider>
            <SidebarShell />
            {/* 中间列：顶栏 + 主区。右栏放在这一列之外，让它的高度贯通整窗
                —— 右栏的顶行与左栏、内容区顶栏三者等高，三条横线才连成一致的一条。 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <TitleBar />
              <MainShell />
            </div>
            <RightSidebar />
          </OintRuntimeProvider>
        </div>
        {/* 浮层挂载在布局之外，避免受侧栏/主区的溢出裁剪 */}
        <SettingsModal />
        <SearchModal />
      </MotionConfig>
    </TooltipProvider>
  );
}
