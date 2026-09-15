import { create } from "zustand";
import type { Project } from "@/shared/contracts";

/**
 * 项目列表（侧栏「项目」分组）。
 *
 * 项目不在渲染层落盘，唯一真源是主进程的 projects.json：
 * 这里只做「读一次 + 增删后就地更新」，避免界面与磁盘两份状态各自漂移。
 */
interface ProjectsState {
  projects: Project[];
  loading: boolean;
  load(): Promise<void>;
  /** 打开系统目录选择器并绑定选中的文件夹；用户取消时返回 null */
  addByPicker(): Promise<Project | null>;
  /** 解绑项目：只删项目本身，会话与其工作目录都不动 */
  remove(id: string): Promise<void>;
}

export const useProjectsStore = create<ProjectsState>()((set) => ({
  projects: [],
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const projects = await window.oint.projects.list();
      set({ projects });
    } finally {
      set({ loading: false });
    }
  },

  async addByPicker() {
    const picked = await window.oint.dialog.pickDirectory();
    if (picked === null) return null;

    const project = await window.oint.projects.add(picked);
    set((state) => ({
      // 主进程对同一路径返回已有项目：按 id 去重，避免侧栏出现两条同名项目
      projects: state.projects.some((item) => item.id === project.id)
        ? state.projects.map((item) => (item.id === project.id ? project : item))
        : [...state.projects, project],
    }));
    return project;
  },

  async remove(id) {
    await window.oint.projects.remove(id);
    set((state) => ({ projects: state.projects.filter((item) => item.id !== id) }));
  },
}));
