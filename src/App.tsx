// 应用根组件：布局与全局状态编排
// src/App.tsx

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";

import { abortAgentThread, resetAgent } from "@/ai/agent";
import { abortTeamThread } from "@/ai/team";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { AskUserModal } from "@/components/AskUserModal";
import { GlobalSessionSearch } from "@/components/GlobalSessionSearch";
import { TitleBar } from "@/components/TitleBar";
import { ToastContainer } from "@/components/ToastContainer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/hooks/useTheme";
import { initializeApp, initializeAiRuntime } from "@/lib/app-init";
import { type PageId } from "@/lib/navigation";
import { resolveSkillSelection } from "@/lib/skill/skill-selection";
import { TeamEditorModal } from "@/components/team/TeamEditorModal";
import type { TeamConfig } from "@/types/config";
import { AgentsPage } from "@/pages/AgentsPage";
import { ChatPage } from "@/pages/ChatPage";
import { HomePage } from "@/pages/HomePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { TeamPage } from "@/pages/TeamPage";
import { TeamChatPage } from "@/pages/TeamChatPage";
import { ToolsPage } from "@/pages/ToolsPage";
import {
  useChatStore,
  useThreadAgentId,
  useThreadSummaries,
  useThreadTitle,
} from "@/stores/chat-store";
import { useConfigStore } from "@/stores/config-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useTeamChatStore } from "@/stores/team/team-chat-store";
import { clearTeamSessions } from "@/lib/session/session-operations";
import type { SettingsSection } from "@/pages/SettingsPage";

function App() {
  const [activePage, setActivePage] = useState<PageId>("chat");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("preferences");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"tasks" | "team">("tasks");
  // 团队聊天视图：非空时主区域渲染 TeamChatPage（覆盖普通页面内容）。
  const [teamChatView, setTeamChatView] = useState<{
    teamId: string;
    threadId: string;
  } | null>(null);
  // 侧边栏只订阅轻量摘要；当前会话的 title/agentId 单独按标量订阅。
  // 避免订阅整个 threads——否则任一后台会话吐 token 都会触发整个 App 重渲染。
  const threadSummaries = useThreadSummaries();
  const activeThreadId = useChatStore((state) => state.activeThreadId);
  const activeThreadTitle = useThreadTitle(activeThreadId);
  const activeThreadAgentId = useThreadAgentId(activeThreadId);
  const composer = useChatStore((state) => state.composer);
  const applyStreamingUpdate = useChatStore(
    (state) => state.applyStreamingUpdate,
  );
  // 正在后台运行的会话 id 列表（驱动侧边栏会话项的加载图标）
  const runningThreadIds = useChatStore((state) => state.runningThreadIds);
  const runningTeamThreadIds = useTeamChatStore(
    (state) => state.runningThreadIds,
  );
  const clearThread = useChatStore((state) => state.clearThread);
  const createThread = useChatStore((state) => state.createThread);
  const deleteThread = useChatStore((state) => state.deleteThread);
  const failAssistant = useChatStore((state) => state.failAssistant);
  const finishAssistant = useChatStore((state) => state.finishAssistant);
  const selectThread = useChatStore((state) => state.selectThread);
  const renameThread = useChatStore((state) => state.renameThread);
  const setComposer = useChatStore((state) => state.setComposer);
  const showHome = useChatStore((state) => state.showHome);
  const startExchange = useChatStore((state) => state.startExchange);
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const setActiveAgent = useChatStore((state) => state.setActiveAgent);
  const chatFont = useConfigStore(
    (state) => state.settings.appearance.chatFont,
  );
  const chatFontSize = useConfigStore(
    (state) => state.settings.appearance.chatFontSize,
  );
  const agents = useConfigStore((state) => state.agents);

  // 团队相关：列表 + 删除（编辑用弹窗）、团队会话 store 动作
  const teams = useTeamsStore((state) => state.teams);
  const removeTeam = useTeamsStore((state) => state.removeTeam);
  const updateTeam = useTeamsStore((state) => state.updateTeam);
  const hydrateTeamThreads = useTeamChatStore(
    (state) => state.hydrateTeamThreads,
  );
  const createTeamThread = useTeamChatStore((state) => state.createTeamThread);
  const selectTeamThread = useTeamChatStore((state) => state.selectTeamThread);
  const renameTeamThread = useTeamChatStore((state) => state.renameTeamThread);
  const deleteTeamThread = useTeamChatStore((state) => state.deleteTeamThread);
  const clearTeamThreadsOfTeam = useTeamChatStore(
    (state) => state.clearTeamThreadsOfTeam,
  );
  // 侧边栏「编辑团队」用的弹窗状态
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const toasts = useToast((state) => state.toasts);
  const removeToast = useToast((state) => state.remove);

  useEffect(() => {
    void hydrateTeamThreads();
  }, [hydrateTeamThreads]);

  useEffect(() => {
    void initializeApp();
  }, []);

  // 应用主题到 <html class="dark">
  useTheme();

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

  // 当前会话所用 Agent 启用的技能（用于右侧监控面板「技能与 MCP」展示）
  const skills = useSkillsStore((state) => state.skills);
  const chatEnabledSkills = useMemo(() => {
    const agentId = activeThreadAgentId || activeAgentId;
    const agent = agents.find((item) => item.id === agentId);
    const ids = agent?.config.enabledSkills ?? [];
    const enabledSkillIds = skills
      .filter((skill) => skill.enabled)
      .map((skill) => skill.id);
    return resolveSkillSelection(ids, enabledSkillIds).map((id) => {
      const skill = skills.find((item) => item.id === id);
      return {
        id,
        name: skill?.name ?? id,
      };
    });
  }, [activeThreadAgentId, activeAgentId, agents, skills]);

  // 后台并行运行：切换页面/会话不再中止正在运行的会话——它们继续在后台跑。
  // 只有用户在某会话内主动点「停止」，或清空/删除该会话时，才中止对应线程。

  const openPage = (page: PageId) => {
    if (page === "chat") {
      showHome();
    }
    // 切到任意主导航页面时退出团队聊天视图
    setTeamChatView(null);
    setActivePage(page);
  };

  const openSettingsSection = (section: SettingsSection) => {
    setSettingsSection(section);
    setTeamChatView(null);
    setActivePage("settings");
  };

  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    setTeamChatView(null);
    setActivePage("chat");
  };

  // 清空指定会话：该会话的消息会被清空，需先中止其正在运行的线程并重置 agent 上下文
  const handleClearThread = (threadId: string) => {
    abortAgentThread(threadId);
    resetAgent(threadId);
    clearThread(threadId);
  };

  // 删除会话：先中止其后台运行，再删除
  const handleDeleteThread = (threadId: string) => {
    abortAgentThread(threadId);
    deleteThread(threadId);
  };

  // ===== 团队相关 =====

  // 在团队聊天页内新建会话
  const handleNewTeamThread = (teamId: string) => {
    const threadId = createTeamThread(teamId);
    setTeamChatView({ teamId, threadId });
  };

  // 在团队聊天页内切换历史会话
  const handleSelectTeamThread = (teamId: string, threadId: string) => {
    selectTeamThread(threadId);
    setTeamChatView({ teamId, threadId });
    setActivePage("chat");
  };

  // 重命名某团队会话（侧边栏会话子项）
  const handleRenameTeamThread = (threadId: string, title: string) => {
    renameTeamThread(threadId, title);
  };

  // 删除某团队会话；若删的是当前打开的会话，退出团队聊天视图
  const handleDeleteTeamThread = (threadId: string) => {
    abortTeamThread(threadId);
    deleteTeamThread(threadId);
    setTeamChatView((view) =>
      view?.threadId === threadId ? null : view,
    );
  };

  // 清空某团队的全部会话（磁盘 + 内存）
  const handleClearTeam = (teamId: string) => {
    useTeamChatStore
      .getState()
      .threads.filter((thread) => thread.teamId === teamId)
      .forEach((thread) => abortTeamThread(thread.id));
    void clearTeamSessions(teamId);
    clearTeamThreadsOfTeam(teamId);
    // 若正处于该团队聊天页，退出
    setTeamChatView((view) => (view?.teamId === teamId ? null : view));
  };

  // 删除团队（连同其全部会话）
  const handleDeleteTeam = (teamId: string) => {
    useTeamChatStore
      .getState()
      .threads.filter((thread) => thread.teamId === teamId)
      .forEach((thread) => abortTeamThread(thread.id));
    void clearTeamSessions(teamId);
    clearTeamThreadsOfTeam(teamId);
    void removeTeam(teamId);
    setTeamChatView((view) => (view?.teamId === teamId ? null : view));
  };

  // 保存团队编辑（侧边栏「编辑团队」入口）
  const editingTeam = teams.find((t) => t.id === editingTeamId) ?? null;
  const handleSaveEditingTeam = async (team: TeamConfig) => {
    await updateTeam(team.id, team);
    initializeAiRuntime();
    setEditingTeamId(null);
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar
          onOpenAbout={() => openSettingsSection("about")}
          onOpenSearch={() => setSearchOpen(true)}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          showPanelToggle={
            teamChatView ? true : activePage === "chat" && !!activeThreadId
          }
          sidebarCollapsed={sidebarCollapsed}
          teamPanelThreadId={teamChatView?.threadId}
        />

        {activePage === "settings" ? (
          <main className="min-h-0 flex-1 bg-background">
            <SettingsPage
              initialSection={settingsSection}
              onBack={() => setActivePage("chat")}
            />
          </main>
        ) : (
          <div className="flex min-h-0 flex-1">
            <AnimatePresence initial={false}>
              {!sidebarCollapsed ? (
                <AppSidebar
                  key="app-sidebar"
                  activePage={activePage}
                  activeThreadId={activeThreadId}
                  activeTeamId={teamChatView?.teamId}
                  activeTeamThreadId={teamChatView?.threadId}
                  onClearThread={handleClearThread}
                  onDeleteThread={handleDeleteThread}
                  onOpenPage={openPage}
                  onRenameThread={renameThread}
                  onSelectThread={handleSelectThread}
                  onEditTeam={(teamId) => setEditingTeamId(teamId)}
                  onClearTeam={handleClearTeam}
                  onDeleteTeam={handleDeleteTeam}
                  onSelectTeamThread={handleSelectTeamThread}
                  onNewTeamThread={handleNewTeamThread}
	                  onRenameTeamThread={handleRenameTeamThread}
	                  onDeleteTeamThread={handleDeleteTeamThread}
	                  runningThreadIds={runningThreadIds}
	                  runningTeamThreadIds={runningTeamThreadIds}
	                  sidebarTab={sidebarTab}
                  setSidebarTab={setSidebarTab}
                  threads={threadSummaries}
                />
              ) : null}
            </AnimatePresence>

            <main className="min-w-0 flex-1 bg-background">
              {teamChatView ? (
                <TeamChatPage
                  teamId={teamChatView.teamId}
                  threadId={teamChatView.threadId}
                />
              ) : (
                <>
              {activePage === "chat" && activeThreadId ? (
                <ChatPage
                  activeThreadTitle={activeThreadTitle}
                  agentId={activeThreadAgentId || activeAgentId}
                  applyStreamingUpdate={applyStreamingUpdate}
                  composer={composer}
                  enabledSkills={chatEnabledSkills}
                  failAssistant={failAssistant}
                  finishAssistant={finishAssistant}
                  setComposer={setComposer}
                  startExchange={startExchange}
                  threadId={activeThreadId}
                />
              ) : null}
              {activePage === "chat" && !activeThreadId ? (
                <HomePage
                  activeAgentId={activeAgentId}
                  agents={agents}
                  applyStreamingUpdate={applyStreamingUpdate}
                  composer={composer}
                  createThread={createThread}
                  failAssistant={failAssistant}
                  finishAssistant={finishAssistant}
                  setActiveAgent={setActiveAgent}
                  setComposer={setComposer}
                  startExchange={startExchange}
                />
              ) : null}
              {activePage === "skills" ? <SkillsPage /> : null}
              {activePage === "tools" ? <ToolsPage /> : null}
              {activePage === "agent" ? (
                <AgentsPage
                  onStartChat={(agentId) => {
                    setActiveAgent(agentId);
                    createThread(agentId);
                    setActivePage("chat");
                  }}
                />
              ) : null}
              {activePage === "team" ? <TeamPage /> : null}
                </>
              )}
            </main>
          </div>
        )}

        {/* 侧边栏「编辑团队」弹窗 */}
        {editingTeam ? (
          <TeamEditorModal
            team={editingTeam}
            onClose={() => setEditingTeamId(null)}
            onSave={handleSaveEditingTeam}
          />
        ) : null}
        <GlobalSessionSearch
          onOpenChange={setSearchOpen}
          onOpenTeamThread={handleSelectTeamThread}
          onOpenThread={handleSelectThread}
          open={searchOpen}
        />
        <AskUserModal />
        <ToastContainer toasts={toasts} onClose={removeToast} />
      </div>
    </TooltipProvider>
  );
}

export default App;
