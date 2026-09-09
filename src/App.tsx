// 应用根组件：布局与全局状态编排
// src/App.tsx

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";

import { abortAgentThread, resetAgent } from "@/ai/agent";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { AskUserModal } from "@/components/AskUserModal";
import { ContentTopBar } from "@/components/ContentTopBar";
import { GlobalSessionSearch } from "@/components/GlobalSessionSearch";
import { ToastContainer } from "@/components/ToastContainer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AutoUpdateHandler } from "@/components/updates/AutoUpdateHandler";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/hooks/useTheme";
import { useLanguage } from "@/hooks/useLanguage";
import { initializeApp } from "@/lib/app-init";
import { type PageId } from "@/lib/navigation";
import { ProjectEditorModal } from "@/components/project/ProjectEditorModal";
import type { ProjectConfig } from "@/types/config";
import { ChatPage } from "@/pages/ChatPage";
import { HomePage } from "@/pages/HomePage";
import { KnowledgePage } from "@/pages/KnowledgePage";
import { SchedulePage } from "@/pages/SchedulePage";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { SkillsPage } from "@/pages/SkillsPage";
import { ToolsPage } from "@/pages/ToolsPage";
import {
  useChatStore,
  useThreadSummaries,
  useThreadTitle,
} from "@/stores/chat-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useConfigStore } from "@/stores/config-store";
import { useProjectsStore } from "@/stores/project/projects-store";

function App() {
  const { t } = useTranslation();
  const [activePage, setActivePage] = useState<PageId>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // 项目聊天视图：非空时主区域用 ChatPage 渲染（传入 subtitle + hideWorkingDirPicker）。
  const [projectChatView, setProjectChatView] = useState<{
    projectId: string;
    threadId: string;
  } | null>(null);
  // 侧边栏只订阅轻量摘要；当前会话的 title 单独按标量订阅。
  // 避免订阅整个 threads——否则任一后台会话吐 token 都会触发整个 App 重渲染。
  const threadSummaries = useThreadSummaries();
  const activeThreadId = useChatStore((state) => state.activeThreadId);
  const activeThreadTitle = useThreadTitle(activeThreadId);
  const composer = useChatStore((state) => state.composer);
  const applyStreamingUpdate = useChatStore(
    (state) => state.applyStreamingUpdate,
  );
  // 正在后台运行的会话 id 列表（驱动侧边栏会话项的加载图标）
  const runningThreadIds = useChatStore((state) => state.runningThreadIds);
  const clearThread = useChatStore((state) => state.clearThread);
  const createThread = useChatStore((state) => state.createThread);
  const deleteThread = useChatStore((state) => state.deleteThread);
  const failAssistant = useChatStore((state) => state.failAssistant);
  const finishAssistant = useChatStore((state) => state.finishAssistant);
  const setRetryAttempt = useChatStore((state) => state.setRetryAttempt);
  const selectThread = useChatStore((state) => state.selectThread);
  const renameThread = useChatStore((state) => state.renameThread);
  const setComposer = useChatStore((state) => state.setComposer);
  const showHome = useChatStore((state) => state.showHome);
  const startExchange = useChatStore((state) => state.startExchange);
  const chatFont = useConfigStore(
    (state) => state.settings.appearance.chatFont,
  );
  const chatFontSize = useConfigStore(
    (state) => state.settings.appearance.chatFontSize,
  );

  // 项目相关：列表 + 编辑弹窗状态
  const projects = useProjectsStore((state) => state.projects);
  const addProject = useProjectsStore((state) => state.addProject);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  // 新建/编辑项目弹窗：null 关闭；project 字段非空时为编辑模式
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null);
  const toasts = useToast((state) => state.toasts);
  const removeToast = useToast((state) => state.remove);

  useEffect(() => {
    void initializeApp();
  }, []);

  // 应用主题到 <html class="dark">
  useTheme();

  // 应用语言设置到 i18next
  useLanguage();

  // 将对话字体/字号映射为 CSS 变量写到 <html>，供 ChatMessage 的内容区消费
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

  // 后台并行运行：切换页面/会话不再中止正在运行的会话——它们继续在后台跑。
  // 只有用户在某会话内主动点「停止」，或清空/删除该会话时，才中止对应线程。

  const openPage = (page: PageId) => {
    if (page === "chat") {
      showHome();
    }
    // 切到任意主导航页面时退出项目聊天视图
    setProjectChatView(null);
    setActivePage(page);
  };

  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    // 项目会话走 projectChatView 独立视图
    const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
    if (thread?.projectId) {
      setProjectChatView({ projectId: thread.projectId, threadId });
      setActivePage("chat");
    } else {
      setProjectChatView(null);
      setActivePage("chat");
    }
  };

  // 清空指定会话：该会话的消息会被清空，需先中止其正在运行的线程并重置 agent 上下文
  const handleClearThread = (threadId: string) => {
    abortAgentThread(threadId);
    resetAgent(threadId);
    clearThread(threadId);
  };

  // 删除会话：先中止其后台运行，再删除；若删的是当前打开的会话，退出项目聊天视图
  const handleDeleteThread = (threadId: string) => {
    abortAgentThread(threadId);
    deleteThread(threadId);
    // 清理项目聊天视图：如果删除的正是当前项目聊天视图中的会话
    setProjectChatView((view) =>
      view?.threadId === threadId ? null : view,
    );
  };

  // ===== 项目相关 =====

  // 在项目内新建对话：传入 projectId 关联项目，切换到项目聊天视图
  const handleNewProjectThread = (projectId: string) => {
    const threadId = createThread(undefined, undefined, projectId);
    setProjectChatView({ projectId, threadId });
    setActivePage("chat");
  };

  // 清空某项目内的全部会话
  const handleClearProjectChats = (projectId: string) => {
    const projectThreads = useChatStore
      .getState()
      .threads.filter((thread) => thread.projectId === projectId);
    projectThreads.forEach((thread) => {
      abortAgentThread(thread.id);
      resetAgent(thread.id);
      clearThread(thread.id);
    });
    // 等待所有磁盘写入完成，失败时记录日志避免内存/磁盘不一致
    void Promise.allSettled(
      projectThreads.map((thread) =>
        useConversationStore.getState().clearConversation(thread.id),
      ),
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`清空项目会话磁盘失败 ${projectThreads[i].id}:`, r.reason);
        }
      });
    });
    // 若正处于该项目聊天页，退出
    setProjectChatView((view) => (view?.projectId === projectId ? null : view));
  };

  // 删除项目（清空该项目的全部会话后删除项目本身）
  const handleDeleteProject = (projectId: string) => {
    // 先中止并销毁该项目的全部会话
    const projectThreads = useChatStore
      .getState()
      .threads.filter((thread) => thread.projectId === projectId);
    projectThreads.forEach((thread) => {
      abortAgentThread(thread.id);
      resetAgent(thread.id);
      deleteThread(thread.id);
    });
    // 等待所有磁盘删除完成，失败时记录日志避免重启后旧会话"复活"
    void Promise.allSettled(
      projectThreads.map((thread) =>
        useConversationStore.getState().deleteConversation(thread.id),
      ),
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`删除项目会话磁盘失败 ${projectThreads[i].id}:`, r.reason);
        }
      });
    });
    void removeProject(projectId);
    // 若正处于该项目聊天页，退出
    setProjectChatView((view) => (view?.projectId === projectId ? null : view));
  };

  // 新建项目弹窗
  const handleNewProject = () => {
    setEditingProject(null);
    setProjectEditorOpen(true);
  };

  // 编辑项目弹窗
  const handleEditProject = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      setEditingProject(project);
      setProjectEditorOpen(true);
    }
  };

  // 保存项目（新建或编辑）
  const handleSaveProject = async (project: ProjectConfig) => {
    if (editingProject) {
      // 编辑模式
      await updateProject(project.id, project);
    } else {
      // 新建模式
      await addProject(project);
    }
    setProjectEditorOpen(false);
    setEditingProject(null);
  };

  // 非项目对话：侧边栏「会话」tab 显示的对话（过滤掉属于项目的）
  const orphanThreads = useMemo(
    () => threadSummaries.filter((thread) => !thread.projectId),
    [threadSummaries],
  );

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-white text-foreground dark:bg-background">
            <AnimatePresence initial={false}>
              {!sidebarCollapsed ? (
                <AppSidebar
                  key="app-sidebar"
                  activePage={activePage}
                  activeThreadId={activeThreadId}
                  onClearThread={handleClearThread}
                  onDeleteThread={handleDeleteThread}
                  onOpenPage={openPage}
                  onRenameThread={renameThread}
                  onSelectThread={handleSelectThread}
                  onToggleSidebar={() => setSidebarCollapsed(true)}
                  onOpenSearch={() => setSearchOpen(true)}
                  onNewProjectThread={handleNewProjectThread}
                  onEditProject={handleEditProject}
                  onDeleteProject={handleDeleteProject}
                  onClearProjectChats={handleClearProjectChats}
                  onNewProject={handleNewProject}
                  runningThreadIds={runningThreadIds}
                  threads={orphanThreads}
                />
              ) : null}
            </AnimatePresence>

            <div className="flex min-w-0 flex-1 flex-col">
              <ContentTopBar
                title={(() => {
                  if (projectChatView) {
                    const projectName = projects.find((p) => p.id === projectChatView.projectId)?.name;
                    return projectName && activeThreadTitle
                      ? `${projectName} · ${activeThreadTitle}`
                      : projectName || activeThreadTitle || "";
                  }
                  if (activePage === "chat" && activeThreadId) return activeThreadTitle || "";
                  return t(`nav:pages.${activePage}.title`, activePage);
                })()}
                onOpenSearch={() => setSearchOpen(true)}
                onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                showPanelToggle={
                  Boolean(projectChatView) || (activePage === "chat" && !!activeThreadId)
                }
                sidebarCollapsed={sidebarCollapsed}
                statsThreadId={projectChatView?.threadId ?? activeThreadId}
              />

              <main className="min-h-0 min-w-0 flex-1 bg-white dark:bg-background">
                {projectChatView ? (
                  <ChatPage
                    applyStreamingUpdate={applyStreamingUpdate}
                    composer={composer}
                    failAssistant={failAssistant}
                    finishAssistant={finishAssistant}
                    setComposer={setComposer}
                    startExchange={startExchange}
                    threadId={projectChatView.threadId}
                    hideWorkingDirPicker
                  />
                ) : (
                  <>
                    {activePage === "chat" && activeThreadId ? (
                      <ChatPage
                        applyStreamingUpdate={applyStreamingUpdate}
                        composer={composer}
                        failAssistant={failAssistant}
                        finishAssistant={finishAssistant}
                        setComposer={setComposer}
                        startExchange={startExchange}
                        threadId={activeThreadId}
                      />
                    ) : null}
                    {activePage === "chat" && !activeThreadId ? (
                      <HomePage
                        applyStreamingUpdate={applyStreamingUpdate}
                        composer={composer}
                        createThread={createThread}
                        failAssistant={failAssistant}
                        finishAssistant={finishAssistant}
                        setRetryAttempt={setRetryAttempt}
                        setComposer={setComposer}
                        startExchange={startExchange}
                      />
                    ) : null}
                    {activePage === "skills" ? <SkillsPage /> : null}
                    {activePage === "tools" ? <ToolsPage /> : null}
                    {activePage === "knowledge" ? <KnowledgePage /> : null}
                    {activePage === "schedule" ? <SchedulePage /> : null}
                  </>
                )}
              </main>
            </div>

        {/* 新建/编辑项目弹窗 */}
        {projectEditorOpen ? (
          <ProjectEditorModal
            project={editingProject}
            onClose={() => {
              setProjectEditorOpen(false);
              setEditingProject(null);
            }}
            onSave={handleSaveProject}
          />
        ) : null}
        <GlobalSessionSearch
          onOpenChange={setSearchOpen}
          onOpenThread={handleSelectThread}
          open={searchOpen}
        />
        <SettingsModal />
        <AskUserModal />
        <AutoUpdateHandler />
        <ToastContainer toasts={toasts} onClose={removeToast} />
      </div>
    </TooltipProvider>
  );
}

export default App;
