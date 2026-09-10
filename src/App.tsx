// 应用根组件：布局与全局状态编排
// src/App.tsx

import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";

import { abortAgentThread, resetAgent } from "@/ai/agent";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { ContentTopBar } from "@/components/ContentTopBar";
import { GlobalSessionSearch } from "@/components/GlobalSessionSearch";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { ToastContainer } from "@/components/ToastContainer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/hooks/useTheme";
import { initializeApp } from "@/lib/app-init";
import { type PageId } from "@/lib/navigation";
import { ChatPage } from "@/pages/ChatPage";
import { PolarAgentRuntimeProvider } from "@/runtime/PolarAgentRuntimeProvider";
import { setNavHandlers } from "@/runtime/nav-bridge";
import { useChatStore, useThreadTitle } from "@/stores/chat-store";
import { useConfigStore } from "@/stores/config-store";

function App() {
  const [activePage, setActivePage] = useState<PageId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const activeThreadId = useChatStore((state) => state.activeThreadId);
  const activeThreadTitle = useThreadTitle(activeThreadId);
  // 正在后台运行的会话 id 列表（驱动侧边栏会话项的加载图标）
  const runningThreadIds = useChatStore((state) => state.runningThreadIds);
  const deleteThread = useChatStore((state) => state.deleteThread);
  const selectThread = useChatStore((state) => state.selectThread);
  const renameThread = useChatStore((state) => state.renameThread);
  const showHome = useChatStore((state) => state.showHome);
  const chatFont = useConfigStore(
    (state) => state.settings.appearance.chatFont,
  );
  const chatFontSize = useConfigStore(
    (state) => state.settings.appearance.chatFontSize,
  );
  const toasts = useToast((state) => state.toasts);
  const removeToast = useToast((state) => state.remove);

  useEffect(() => {
    void initializeApp();
  }, []);

  // 应用主题到 <html class="dark">
  useTheme();

  // 将对话字体/字号映射为 CSS 变量写到 <html>，供对话消息内容区消费
  useEffect(() => {
    const fontMap: Record<typeof chatFont, string> = {
      sans: "var(--font-sans)",
      serif: '"Georgia", "Songti SC", "思源宋体", "Noto Serif SC", serif',
      mono: '"Consolas", "SF Mono", "JetBrains Mono", monospace',
    };
    const sizeMap: Record<typeof chatFontSize, string> = {
      small: "13px",
      medium: "14px",
      large: "16px",
      xlarge: "18px",
    };
    const root = document.documentElement;
    root.style.setProperty("--chat-font", fontMap[chatFont]);
    root.style.setProperty("--chat-font-size", sizeMap[chatFontSize]);
  }, [chatFont, chatFontSize]);

  // 后台并行运行：切换会话不再中止正在运行的会话——它们继续在后台跑。
  // 只有用户在某会话内主动点「停止」，或删除该会话时，才中止对应线程。

  // Runtime ThreadList 回调 → App 导航
  useEffect(() => {
    setNavHandlers({
      onSelectThread: (threadId) => {
        setActivePage("chat");
        void threadId;
      },
      onNewThread: () => {
        setActivePage("chat");
      },
    });
    return () => setNavHandlers({});
  }, []);

  const openPage = (page: PageId) => {
    if (page === "chat") {
      showHome();
    }
    setActivePage(page);
  };

  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    setActivePage("chat");
  };

  // 删除会话：先中止其后台运行及其 harness，再删除（磁盘删除由 chat-store 负责）
  const handleDeleteThread = (threadId: string) => {
    abortAgentThread(threadId);
    resetAgent(threadId);
    deleteThread(threadId);
  };

  return (
    <TooltipProvider>
      <PolarAgentRuntimeProvider>
        <div className="flex h-screen overflow-hidden bg-white text-foreground dark:bg-background">
          <AnimatePresence initial={false}>
            {!sidebarCollapsed ? (
              <AppSidebar
                key="app-sidebar"
                activePage={activePage}
                activeThreadId={activeThreadId}
                onDeleteThread={handleDeleteThread}
                onOpenPage={openPage}
                onRenameThread={renameThread}
                onSelectThread={handleSelectThread}
                onToggleSidebar={() => setSidebarCollapsed(true)}
                onOpenSearch={() => setSearchOpen(true)}
                runningThreadIds={runningThreadIds}
              />
            ) : null}
          </AnimatePresence>

          <div className="flex min-w-0 flex-1 flex-col">
            <ContentTopBar
              title={
                activePage === "chat" && activeThreadId
                  ? activeThreadTitle || ""
                  : "PolarAgent"
              }
              onOpenSearch={() => setSearchOpen(true)}
              onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
              showStats={activePage === "chat" && !!activeThreadId}
              sidebarCollapsed={sidebarCollapsed}
              statsThreadId={activeThreadId}
            />

            <main className="min-h-0 min-w-0 flex-1 bg-white dark:bg-background">
              <ChatPage threadId={activeThreadId} />
            </main>
          </div>

          <GlobalSessionSearch
            onOpenChange={setSearchOpen}
            onOpenThread={handleSelectThread}
            open={searchOpen}
          />
          <SettingsModal />
          <ToastContainer toasts={toasts} onClose={removeToast} />
        </div>
      </PolarAgentRuntimeProvider>
    </TooltipProvider>
  );
}

export default App;
