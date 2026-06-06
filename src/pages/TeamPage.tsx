// 团队管理页：所有团队的列表 + 新建/编辑/清空/删除
// 仿 AgentsPage 结构（TopToolbar + PageHero + 卡片网格）
// src/pages/TeamPage.tsx

import { useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { FolderOpen, Pencil, Plus, Search, Users } from "lucide-react";

import { TeamActionsMenu } from "@/components/team/TeamActionsMenu";
import { TeamEditorModal } from "@/components/team/TeamEditorModal";
import { Button } from "@/components/ui/button";
import { initializeAiRuntime } from "@/lib/app-init";
import { clearTeamSessions } from "@/lib/session/session-operations";
import { useConfigStore } from "@/stores/config-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import type { TeamConfig } from "@/types/config";

export function TeamPage() {
  const teams = useTeamsStore((state) => state.teams);
  const addTeam = useTeamsStore((state) => state.addTeam);
  const updateTeam = useTeamsStore((state) => state.updateTeam);
  const removeTeam = useTeamsStore((state) => state.removeTeam);
  const agents = useConfigStore((state) => state.agents);

  const [search, setSearch] = useState("");
  const [editingTeam, setEditingTeam] = useState<TeamConfig | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);

  const visibleTeams = useMemo(
    () => filterTeams(teams, search),
    [teams, search],
  );

  // agentId -> avatar，用于卡片头像簇
  const avatarOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) map.set(agent.id, agent.avatar || "⚡");
    return map;
  }, [agents]);

  const handleSaveNew = async (team: TeamConfig) => {
    await addTeam(team);
    initializeAiRuntime();
    setCreatingTeam(false);
  };

  const handleSaveEdit = async (team: TeamConfig) => {
    await updateTeam(team.id, team);
    initializeAiRuntime();
    setEditingTeam(null);
  };

  const handleClear = (teamId: string) => {
    void clearTeamSessions(teamId);
  };

  const handleDelete = (teamId: string) => {
    void clearTeamSessions(teamId);
    void removeTeam(teamId);
  };

  // 创建空白团队模板
  const createEmptyTeam = (): TeamConfig => ({
    id: uuidv4(),
    name: "新建团队",
    avatar: "👥",
    description: "",
    version: "1.0.0",
    mode: "leader",
    leaderId: "",
    memberIds: [],
    systemPrompt: "",
    enabledSkills: [],
    maxRounds: 8,
  });

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <TopToolbar
          search={search}
          setSearch={setSearch}
          onCreateTeam={() => setCreatingTeam(true)}
        />

        <PageHero />

        {visibleTeams.length > 0 ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleTeams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                avatarOf={avatarOf}
                onEdit={() => setEditingTeam(team)}
                onClear={() => handleClear(team.id)}
                onDelete={() => handleDelete(team.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </div>

      {creatingTeam ? (
        <TeamEditorModal
          team={createEmptyTeam()}
          onClose={() => setCreatingTeam(false)}
          onSave={handleSaveNew}
        />
      ) : null}

      {editingTeam ? (
        <TeamEditorModal
          team={editingTeam}
          onClose={() => setEditingTeam(null)}
          onSave={handleSaveEdit}
        />
      ) : null}
    </div>
  );
}

function TeamCard({
  team,
  avatarOf,
  onEdit,
  onClear,
  onDelete,
}: {
  team: TeamConfig;
  avatarOf: Map<string, string>;
  onEdit: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const visibleMemberIds = team.memberIds.slice(0, 5);
  const hiddenMemberCount = Math.max(
    0,
    team.memberIds.length - visibleMemberIds.length,
  );
  const countLabel =
    team.memberIds.length > 5
      ? `+${hiddenMemberCount}`
      : `${team.memberIds.length}`;
  const modeLabel =
    team.mode === "leader"
      ? "领导调度"
      : team.mode === "parallel"
        ? "并行协作"
        : "头脑风暴";

  return (
    <div className="group flex flex-col rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm">
      <div className="flex items-center gap-2.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-2xl">
          {team.avatar || "👥"}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{team.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {modeLabel} · {team.memberIds.length} 名成员
          </p>
        </div>
        {/* 右上角「更多」：hover 出现 */}
        <span className="opacity-0 transition-opacity group-hover:opacity-100">
          <TeamActionsMenu
            teamName={team.name}
            onEdit={onEdit}
            onClear={onClear}
            onDelete={onDelete}
          />
        </span>
      </div>

      <p className="mt-2 line-clamp-2 h-10 overflow-hidden text-sm leading-5 text-muted-foreground">
        {team.description || "暂无描述"}
      </p>

      {/* 成员头像簇：5 个头像 + 1 个数量圆，圆形随卡片宽度自动缩放。 */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          成员
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {team.memberIds.length > 0 ? (
            <>
              {visibleMemberIds.map((id) => (
                <span
                  key={id}
                  className="flex aspect-square min-w-0 items-center justify-center rounded-full border border-border bg-background text-[clamp(0.875rem,2vw,1.125rem)] shadow-sm"
                >
                  {avatarOf.get(id) || "⚡"}
                </span>
              ))}
              {Array.from({ length: 5 - visibleMemberIds.length }).map(
                (_, index) => (
                  <span
                    key={`empty-${index}`}
                    className="aspect-square min-w-0"
                    aria-hidden="true"
                  />
                ),
              )}
              <span className="flex aspect-square min-w-0 items-center justify-center rounded-full border border-border bg-muted text-center text-[clamp(0.6875rem,1.5vw,0.8125rem)] font-semibold leading-none tabular-nums text-muted-foreground shadow-sm">
                {countLabel}
              </span>
            </>
          ) : (
            <>
              {Array.from({ length: 5 }).map((_, index) => (
                <span
                  key={`empty-${index}`}
                  className="aspect-square min-w-0"
                  aria-hidden="true"
                />
              ))}
              <span className="flex aspect-square min-w-0 items-center justify-center rounded-full border border-dashed border-border bg-muted text-center text-[clamp(0.6875rem,1.5vw,0.8125rem)] font-semibold leading-none tabular-nums text-muted-foreground">
                0
              </span>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end pt-0.5">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="size-4" />
          编辑团队
        </Button>
      </div>
    </div>
  );
}

function TopToolbar({
  search,
  setSearch,
  onCreateTeam,
}: {
  search: string;
  setSearch: (value: string) => void;
  onCreateTeam: () => void;
}) {
  return (
    <div className="mb-12 flex flex-wrap items-center justify-end gap-2">
      <div className="relative w-[300px] max-w-full">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-ring"
          placeholder="搜索团队"
        />
      </div>
      <Button onClick={onCreateTeam}>
        <Plus className="size-4" />
        新建团队
      </Button>
    </div>
  );
}

function PageHero() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-normal">团队</h1>
      <p className="mt-3 text-base text-muted-foreground">
        把多个助手编排成协作小组，分工完成复杂任务。
      </p>
      <div className="mt-6 overflow-hidden rounded-lg bg-accent">
        <div className="relative min-h-[116px] px-7 py-7">
          <h2 className="text-lg font-semibold">把复杂任务分给一组助手</h2>
          <p className="mt-3 max-w-[580px] text-sm text-muted-foreground">
            让不同助手各做擅长的部分，适合需要讨论、分工和反复推进的任务。
          </p>
          <div className="absolute right-10 top-4 hidden rotate-[10deg] rounded-md border border-border bg-card px-5 py-4 shadow-sm md:block">
            <Users className="size-7" />
            <p className="mt-2 text-xs font-medium">Team Kit</p>
          </div>
        </div>
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
      <FolderOpen className="size-9 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold">还没有团队</h3>
      <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
        点击右上角「新建团队」，挑选成员、选择协作模式，保存你的协作配置。
      </p>
    </div>
  );
}

function filterTeams(teams: TeamConfig[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return teams;
  return teams.filter((team) =>
    `${team.name} ${team.description}`.toLowerCase().includes(query),
  );
}
