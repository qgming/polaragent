// 团队配置 Store —— 镜像 config-store 的 agents CRUD
// src/stores/teams-store.ts
//
// 团队配置以本地文件为准（{dataDir}/teams/<id>.json，经 Rust 命令读写）。
// 这里只做内存镜像 + 增删改，落盘交给 Electron API。

import { create } from "zustand";

import {
  deleteTeamConfig,
  listTeams,
  readTeamConfig,
  writeTeamConfig,
} from "@/lib/electron-api";
import type { TeamConfig } from "@/types/config";

interface TeamsState {
  teams: TeamConfig[];
  isLoading: boolean;
  error: string | null;

  loadTeams: () => Promise<void>;
  addTeam: (team: TeamConfig) => Promise<void>;
  updateTeam: (id: string, updates: Partial<TeamConfig>) => Promise<void>;
  removeTeam: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useTeamsStore = create<TeamsState>((set, get) => ({
  teams: [],
  isLoading: false,
  error: null,

  // 加载团队列表 —— 完全以本地文件为准
  loadTeams: async () => {
    set({ isLoading: true, error: null });
    try {
      const ids = await listTeams();
      const loaded = await Promise.all(
        ids.map((id) => readTeamConfig<TeamConfig>(id)),
      );
      set({ teams: loaded.map(normalizeTeam) });
    } catch (error) {
      console.warn("无法加载团队", error);
      set({ teams: [] });
    } finally {
      set({ isLoading: false });
    }
  },

  // 添加团队
  addTeam: async (team) => {
    await writeTeamConfig(team.id, team);
    set((state) => ({ teams: [...state.teams, team] }));
  },

  // 更新团队
  updateTeam: async (id, updates) => {
    const teams = get().teams.map((t) =>
      t.id === id ? { ...t, ...updates } : t,
    );
    const team = teams.find((t) => t.id === id);
    if (team) {
      await writeTeamConfig(id, team);
    }
    set({ teams });
  },

  // 删除团队
  removeTeam: async (id) => {
    await deleteTeamConfig(id);
    set((state) => ({ teams: state.teams.filter((t) => t.id !== id) }));
  },

  clearError: () => {
    set({ error: null });
  },
}));

// 结构归一化：补齐缺失的可选字段，不覆盖磁盘内容
function normalizeTeam(team: TeamConfig): TeamConfig {
  return {
    ...team,
    mode: team.mode ?? "leader",
    memberIds: team.memberIds ?? [],
    enabledSkills: team.enabledSkills ?? [],
    maxRounds: team.maxRounds ?? 8,
  };
}
