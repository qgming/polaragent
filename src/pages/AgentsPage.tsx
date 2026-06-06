// Agents 管理页面
// src/pages/AgentsPage.tsx

import { useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  Bot,
  Check,
  MessageCircle,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { AgentEditorModal } from "@/components/AgentEditorModal";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/useToast";
import { initializeAiRuntime } from "@/lib/app-init";
import { useConfigStore } from "@/stores/config-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useAgentsMarketStore } from "@/stores/agents-market-store";
import type { AgentConfig } from "@/types/config";
import type { MarketAgent } from "@/lib/electron/electron-api";
import { cn } from "@/lib/utils";

type AgentTab = "market" | "builtin" | "custom";

export function AgentsPage({
  onStartChat,
}: {
  onStartChat: (agentId: string) => void;
}) {
  const agents = useConfigStore((state) => state.agents);
  const updateAgent = useConfigStore((state) => state.updateAgent);
  const addAgent = useConfigStore((state) => state.addAgent);
  const skills = useSkillsStore((state) => state.skills);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const [activeTab, setActiveTab] = useState<AgentTab>("market");
  const [search, setSearch] = useState("");
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const builtinAgents = useMemo(
    () => agents.filter((agent) => (agent.type ?? (agent.id === "default" ? "builtin" : "custom")) === "builtin"),
    [agents],
  );
  const customAgents = useMemo(
    () => agents.filter((agent) => (agent.type ?? (agent.id === "default" ? "builtin" : "custom")) === "custom"),
    [agents],
  );

  const visibleBuiltin = filterAgents(builtinAgents, search);
  const visibleCustom = filterAgents(customAgents, search);

  // 现有助手名集合（用于助手广场标记「已添加」）
  const installedNames = useMemo(
    () =>
      new Set(
        agents.map((agent) => agent.name.toLowerCase().replace(/\s+/g, "")),
      ),
    [agents],
  );

  const handleSaveAgent = async (agent: AgentConfig) => {
    await updateAgent(agent.id, agent);
    initializeAiRuntime();
    setEditingAgent(null);
  };

  const handleCreateAgent = () => {
    setCreatingAgent(true);
  };

  const handleSaveNewAgent = async (agent: AgentConfig) => {
    await addAgent(agent);
    initializeAiRuntime();
    setCreatingAgent(false);
  };

  // 创建空白助手模板
  const createEmptyAgent = (): AgentConfig => ({
    id: uuidv4(),
    name: "新建助手",
    avatar: "⚡",
    description: "",
    version: "1.0.0",
    type: "custom",
    config: {
      provider: "",
      model: "",
      systemPrompt: "",
      enabledSkills: [],
    },
  });

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <TopToolbar search={search} setSearch={setSearch} onCreateAgent={handleCreateAgent} />

        <PageHero
          title="助手"
          description="管理不同任务场景中的工作助手、模型策略和启用技能。"
          bannerTitle="给不同的活安排不同的人设"
          bannerDescription="写文案、查资料、做计划都可以交给专门的助手，常用任务不用每次重新解释。"
        />

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AgentTab)}>
          <TabsList className="mt-6 h-10 bg-transparent p-0">
            <TabTrigger value="market">助手广场</TabTrigger>
            <TabTrigger value="builtin">内置</TabTrigger>
            <TabTrigger value="custom">
              已安装
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {customAgents.length}
              </span>
            </TabTrigger>
          </TabsList>
        </Tabs>

        {activeTab === "market" ? (
          <AgentMarketView installedNames={installedNames} search={search} />
        ) : null}

        {activeTab === "builtin" ? (
          <AgentList
            agents={visibleBuiltin}
            emptyTitle="没有找到内置助手"
            onEdit={setEditingAgent}
            onStartChat={onStartChat}
          />
        ) : null}

        {activeTab === "custom" ? (
          <AgentList
            agents={visibleCustom}
            custom
            emptyTitle="还没有自定义助手"
            onEdit={setEditingAgent}
            onStartChat={onStartChat}
          />
        ) : null}
      </div>

      {editingAgent ? (
        <AgentEditorModal
          agent={editingAgent}
          skills={skills}
          onClose={() => setEditingAgent(null)}
          onSave={handleSaveAgent}
          onStartChat={onStartChat}
        />
      ) : null}

      {creatingAgent ? (
        <AgentEditorModal
          agent={createEmptyAgent()}
          skills={skills}
          onClose={() => setCreatingAgent(false)}
          onSave={handleSaveNewAgent}
          onStartChat={onStartChat}
        />
      ) : null}
    </div>
  );
}

// ===== 助手广场视图 =====

function AgentMarketView({
  installedNames,
  search,
}: {
  installedNames: Set<string>;
  search: string;
}) {
  const agents = useAgentsMarketStore((state) => state.agents);
  const activeGroup = useAgentsMarketStore((state) => state.activeGroup);
  const setActiveGroup = useAgentsMarketStore((state) => state.setActiveGroup);
  const isLoading = useAgentsMarketStore((state) => state.isLoading);
  const isRefreshing = useAgentsMarketStore((state) => state.isRefreshing);
  const error = useAgentsMarketStore((state) => state.error);
  const updatedAt = useAgentsMarketStore((state) => state.updatedAt);
  const installingIds = useAgentsMarketStore((state) => state.installingIds);
  const install = useAgentsMarketStore((state) => state.install);
  const toast = useToast();

  // 所有 group 去重，作为分类 chip
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const agent of agents) {
      for (const g of agent.group) set.add(g);
    }
    return Array.from(set);
  }, [agents]);

  // 首次有数据后默认选中第一个分类（避免一次性渲染全部分类的卡片导致卡顿）
  useEffect(() => {
    if (!activeGroup && groups.length > 0) {
      setActiveGroup(groups[0]);
    }
  }, [activeGroup, groups, setActiveGroup]);

  // 先按分类筛选，再按搜索词本地过滤
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return agents.filter((agent) => {
      if (activeGroup && !agent.group.includes(activeGroup)) return false;
      if (!query) return true;
      return `${agent.name} ${agent.description} ${agent.prompt}`
        .toLowerCase()
        .includes(query);
    });
  }, [agents, activeGroup, search]);

  const isInstalled = (agent: MarketAgent) =>
    installedNames.has(agent.name.toLowerCase().replace(/\s+/g, ""));

  const waiting = isLoading || (agents.length === 0 && isRefreshing);

  const handleInstall = async (agent: MarketAgent) => {
    const ok = await install(agent);
    if (ok) {
      toast.success(`已添加助手：${agent.name}`);
    } else {
      toast.error(`添加助手失败：${agent.name}`);
    }
  };

  return (
    <div className="mt-5">
      {/* 分类 chip */}
      <div className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <GroupChip
            key={group}
            active={activeGroup === group}
            label={group}
            onClick={() => setActiveGroup(group)}
          />
        ))}
      </div>

      {/* 状态行 */}
      <div className="mt-4 flex h-5 items-center gap-2 text-xs text-muted-foreground">
        {isRefreshing ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" />
            正在后台更新助手广场…
          </span>
        ) : updatedAt > 0 ? (
          <span>更新于 {formatUpdatedAt(updatedAt)}</span>
        ) : null}
      </div>

      {/* 内容区 */}
      {error && agents.length === 0 ? (
        <MarketError message={error} />
      ) : waiting ? (
        <AgentGrid>
          {Array.from({ length: 6 }).map((_, index) => (
            <AgentCardSkeleton key={index} />
          ))}
        </AgentGrid>
      ) : visible.length > 0 ? (
        <AgentGrid>
          {visible.map((agent) => (
            <MarketAgentCard
              key={agent.id}
              agent={agent}
              installed={isInstalled(agent)}
              installing={installingIds.includes(agent.id)}
              onInstall={() => void handleInstall(agent)}
            />
          ))}
        </AgentGrid>
      ) : (
        <EmptyCloudState
          title="没有匹配的助手"
          description="换个分类或在上方搜索框输入关键词试试。"
        />
      )}
    </div>
  );
}

function GroupChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        active
          ? "border-transparent bg-[#f1eafb] text-[#5b3a9e]"
          : "border-border bg-card text-muted-foreground hover:border-[#9b6fe0]/30 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function AgentGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function MarketAgentCard({
  agent,
  installed,
  installing,
  onInstall,
}: {
  agent: MarketAgent;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-2xl">
          {agent.emoji}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {agent.name}
        </h3>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[40px] text-sm leading-5 text-muted-foreground">
        {agent.description || "暂无描述"}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap gap-1">
          {agent.group.slice(0, 3).map((group) => (
            <span
              key={group}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {group}
            </span>
          ))}
        </div>
        {installed ? (
          <Button variant="outline" size="sm" disabled>
            <Check className="size-4" />
            已添加
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            添加助手
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentCardSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="size-10 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        <div className="h-8 w-20 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function MarketError({ message }: { message: string }) {
  return (
    <div className="mt-5 flex flex-col items-center justify-center rounded-xl border border-dashed border-destructive/40 bg-destructive/5 px-6 py-12 text-center">
      <h3 className="text-base font-semibold">加载助手广场失败</h3>
      <p className="mt-2 max-w-[460px] text-sm leading-6 text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

// 把时间戳格式化为「刚刚 / X 小时前 / X 天前」
function formatUpdatedAt(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "刚刚";
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function TopToolbar({
  search,
  setSearch,
  onCreateAgent,
}: {
  search: string;
  setSearch: (value: string) => void;
  onCreateAgent: () => void;
}) {
  return (
    <div className="mb-12 flex flex-wrap items-center justify-end gap-2">
      <div className="relative w-[300px] max-w-full">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-ring"
          placeholder="搜索助手"
        />
      </div>
      <Button onClick={onCreateAgent}>
        <Plus className="size-4" />
        创建助手
      </Button>
    </div>
  );
}

function PageHero({
  bannerDescription,
  bannerTitle,
  description,
  title,
}: {
  bannerDescription: string;
  bannerTitle: string;
  description: string;
  title: string;
}) {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-normal">{title}</h1>
      <p className="mt-3 text-base text-muted-foreground">{description}</p>
      <div className="mt-6 overflow-hidden rounded-lg bg-accent">
        <div className="relative min-h-[116px] px-7 py-7">
          <h2 className="text-lg font-semibold">{bannerTitle}</h2>
          <p className="mt-3 max-w-[580px] text-sm text-muted-foreground">
            {bannerDescription}
          </p>
          <div className="absolute right-10 top-4 hidden rotate-[10deg] rounded-md border border-border bg-card px-5 py-4 shadow-sm md:block">
            <Bot className="size-7" />
            <p className="mt-2 text-xs font-medium">Agent Kit</p>
          </div>
        </div>
      </div>
    </>
  );
}

function TabTrigger({
  children,
  value,
}: {
  children: React.ReactNode;
  value: AgentTab;
}) {
  return (
    <TabsTrigger
      value={value}
      className="mr-7 h-10 gap-2 rounded-none bg-transparent px-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function AgentList({
  agents,
  custom,
  emptyTitle,
  onEdit,
  onStartChat,
}: {
  agents: AgentConfig[];
  custom?: boolean;
  emptyTitle: string;
  onEdit: (agent: AgentConfig) => void;
  onStartChat: (agentId: string) => void;
}) {
  if (agents.length === 0) {
    return (
      <EmptyCloudState
        compact
        title={emptyTitle}
        description="可从助手广场安装，或使用创建按钮新增。"
      />
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-card">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          custom={custom}
          onEdit={() => onEdit(agent)}
          onStartChat={() => onStartChat(agent.id)}
        />
      ))}
    </section>
  );
}

function AgentRow({
  agent,
  custom,
  onEdit,
  onStartChat,
}: {
  agent: AgentConfig;
  custom?: boolean;
  onEdit: () => void;
  onStartChat: () => void;
}) {
  return (
    <div className="grid min-h-[92px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex size-12 items-center justify-center rounded-lg border border-border bg-background text-2xl shadow-sm">
        {agent.avatar || "⚡"}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-semibold">{agent.name}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {agent.config.model || "未配置模型"}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {agent.description}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onStartChat}>
          <MessageCircle className="size-4" />
          开始对话
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Settings className="size-4" />
          编辑
        </Button>
        {custom ? (
          <Button variant="outline" size="sm">
            <Trash2 className="size-4" />
            删除
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyCloudState({
  compact,
  description,
  title,
}: {
  compact?: boolean;
  description: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "mt-4 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center",
        compact ? "min-h-[220px]" : "min-h-[320px]",
      )}
    >
      <FolderOpen className="size-9 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function filterAgents(agents: AgentConfig[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return agents;
  return agents.filter((agent) =>
    `${agent.name} ${agent.id} ${agent.description}`
      .toLowerCase()
      .includes(query),
  );
}
