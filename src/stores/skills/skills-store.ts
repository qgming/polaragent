// Skills Store - 管理 Skills 状态

import { create } from "zustand";
import type { SkillConfig } from "@/types/config";
import {
  deleteSkillByName as deleteSkillApi,
  patchSkill as patchSkillApi,
  writeSkill as writeSkillApi,
} from "@/lib/electron/electron-api";
import { skillLoader } from "@/lib/skill";

interface SkillsState {
  // 状态
  skills: SkillConfig[];
  isLoading: boolean;
  error: string | null;

  // 操作
  loadSkills: () => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => void;
  setSkillsEnabled: (ids: string[], enabled: boolean) => void;
  installSkill: (source: string, type: "git" | "local") => Promise<boolean>;
  uninstallSkill: (id: string) => Promise<boolean>;
  writeSkill: (name: string, content: string) => Promise<boolean>;
  patchSkill: (name: string, oldString: string, newString: string) => Promise<boolean>;
  deleteSkillByName: (name: string) => Promise<boolean>;
  getSkill: (id: string) => SkillConfig | undefined;
  getEnabledSkills: () => SkillConfig[];
  clearError: () => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  // 初始状态
  skills: [],
  isLoading: false,
  error: null,

  // 加载所有 Skills
  loadSkills: async () => {
    set({ isLoading: true, error: null });

    try {
      await skillLoader.initialize();
      const skills = skillLoader.getAllSkills();
      set({ skills, isLoading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "加载 Skills 失败";
      set({ error: message, isLoading: false });
      console.error("加载 Skills 失败:", error);
    }
  },

  // 启用/禁用 Skill
  toggleSkill: (id: string, enabled: boolean) => {
    skillLoader.toggleSkill(id, enabled);

    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === id ? { ...skill, enabled } : skill,
      ),
    }));
  },

  setSkillsEnabled: (ids: string[], enabled: boolean) => {
    if (ids.length === 0) return;

    const uniqueIds = Array.from(new Set(ids));
    const uniqueIdSet = new Set(uniqueIds);
    for (const id of uniqueIds) {
      skillLoader.toggleSkill(id, enabled);
    }

    set((state) => ({
      skills: state.skills.map((skill) =>
        uniqueIdSet.has(skill.id) ? { ...skill, enabled } : skill,
      ),
    }));
  },

  // 安装 Skill
  installSkill: async (source: string, type: "git" | "local") => {
    set({ isLoading: true, error: null });

    try {
      let success = false;

      if (type === "git") {
        success = await skillLoader.installSkillFromGit(source);
      } else {
        success = await skillLoader.installSkillFromLocal(source);
      }

      if (success) {
        // 重新加载 Skills
        const skills = skillLoader.getAllSkills();
        set({ skills, isLoading: false });
      } else {
        set({ error: "安装 Skill 失败", isLoading: false });
      }

      return success;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "安装 Skill 失败";
      set({ error: message, isLoading: false });
      return false;
    }
  },

  // 卸载 Skill
  uninstallSkill: async (id: string) => {
    set({ isLoading: true, error: null });

    try {
      const success = await skillLoader.uninstallSkill(id);

      if (success) {
        set((state) => ({
          skills: state.skills.filter((skill) => skill.id !== id),
          isLoading: false,
        }));
      } else {
        set({ error: "卸载 Skill 失败", isLoading: false });
      }

      return success;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "卸载 Skill 失败";
      set({ error: message, isLoading: false });
      return false;
    }
  },

  writeSkill: async (name: string, content: string) => {
    set({ isLoading: true, error: null });

    try {
      const result = await writeSkillApi(name, content);
      if (!result.success) {
        set({ error: result.message || "写入 Skill 失败", isLoading: false });
        return false;
      }

      await skillLoader.initialize();
      set({ skills: skillLoader.getAllSkills(), isLoading: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "写入 Skill 失败";
      set({ error: message, isLoading: false });
      return false;
    }
  },

  patchSkill: async (name: string, oldString: string, newString: string) => {
    set({ isLoading: true, error: null });

    try {
      const result = await patchSkillApi(name, oldString, newString);
      if (!result.success) {
        set({ error: result.message || "更新 Skill 失败", isLoading: false });
        return false;
      }

      await skillLoader.initialize();
      set({ skills: skillLoader.getAllSkills(), isLoading: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新 Skill 失败";
      set({ error: message, isLoading: false });
      return false;
    }
  },

  deleteSkillByName: async (name: string) => {
    set({ isLoading: true, error: null });

    try {
      const result = await deleteSkillApi(name);
      if (!result.success) {
        set({ error: result.message || "删除 Skill 失败", isLoading: false });
        return false;
      }

      await skillLoader.initialize();
      set({ skills: skillLoader.getAllSkills(), isLoading: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除 Skill 失败";
      set({ error: message, isLoading: false });
      return false;
    }
  },

  // 获取单个 Skill
  getSkill: (id: string) => {
    return get().skills.find((skill) => skill.id === id);
  },

  // 获取启用的 Skills
  getEnabledSkills: () => {
    return get().skills.filter((skill) => skill.enabled);
  },

  // 清除错误
  clearError: () => {
    set({ error: null });
  },
}));
