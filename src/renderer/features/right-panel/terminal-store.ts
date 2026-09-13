import { create } from "zustand";
import type { TerminalInfo } from "@/shared/contracts/terminal";

/**
 * 终端的渲染层状态。
 *
 * 为什么另立一个 store 而不挂进 chat-store：终端的生命周期与「会话」不是一对一 ——
 * 用户可以在一个会话里开三个终端、切到别的会话去看一眼、再切回来。
 * 挂进 chat-store 就要多一层 sessionId → terminalId 的映射，而目前并没有
 * 「每个会话各自的终端」这个需求（面板是全局的一排标签）。
 *
 * 主进程才是唯一真相（进程表在那里）；这里只是一份镜像，
 * 靠 terminal-changed / terminal-removed 事件保持同步（见 applyEvent）。
 */
interface TerminalState {
  /** 全部终端（最老在前，与主进程 list 的顺序一致） */
  terminals: TerminalInfo[];
  /** 当前显示的那一个；null = 没有终端，或还没选 */
  activeId: string | null;
  /** 最近一次操作的失败原因（PTY 不可用、数量超限等）；null = 无 */
  error: string | null;
  /** 首次拉列表是否还在飞（面板据此显示占位而不是空态） */
  loading: boolean;

  /** 拉一次全量列表；面板挂载时调用 */
  load(): Promise<void>;
  /** 新建终端；失败时写 error，不抛（调用方是 UI，抛了没人接） */
  create(cwd: string, size?: { cols: number; rows: number }): Promise<string | null>;
  /** 关闭一个终端；连带选中态的转移 */
  close(id: string): Promise<void>;
  setActive(id: string | null): void;
  /** 事件驱动的状态收敛（终端的增删改都走这里） */
  applyEvent(event: { type: string; id?: string } & Record<string, unknown>): void;
  clearError(): void;
}

/**
 * 选中的邻居：关掉某个终端后接管 activeId 的那个。
 *
 * 取**右侧**的下一个（没有才往左回退）：标签栏是从左往右读的，关掉中间一个之后
 * 视线本来就落在右边那个身上；回退到最左边会让人以为「跳到了第一个」。
 */
function neighbourId(terminals: readonly TerminalInfo[], removedId: string): string | null {
  const index = terminals.findIndex((item) => item.id === removedId);
  if (index < 0) return terminals[0]?.id ?? null;
  const next = terminals[index + 1] ?? terminals[index - 1];
  return next?.id ?? null;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  terminals: [],
  activeId: null,
  error: null,
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const terminals = await window.oint.terminal.list();
      set((state) => ({
        terminals,
        // 只在「还没有选中」时自动选第一个：否则每次重挂载都会把用户的选择冲掉
        activeId:
          state.activeId !== null && terminals.some((t) => t.id === state.activeId)
            ? state.activeId
            : (terminals[0]?.id ?? null),
      }));
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      set({ loading: false });
    }
  },

  async create(cwd, size) {
    set({ error: null });
    try {
      const info = await window.oint.terminal.create({
        cwd,
        ...(size === undefined ? {} : { cols: size.cols, rows: size.rows }),
      });
      set((state) => ({
        // 主进程也会推 terminal-changed，但那次推送不保证先到 —— 这里先乐观插入，
        // applyEvent 的 upsert 是幂等的，重复一次没有副作用
        terminals: state.terminals.some((t) => t.id === info.id)
          ? state.terminals
          : [...state.terminals, info],
        activeId: info.id,
      }));
      return info.id;
    } catch (failure) {
      // 主进程的消息已经是可读的中文（「终端数量已达上限…」「PTY 运行库加载失败…」），
      // 这里不再包一层，免得变成「新建终端失败：终端数量已达上限」（两个冒号）
      set({ error: failure instanceof Error ? failure.message : String(failure) });
      return null;
    }
  },

  async close(id) {
    set((state) => {
      const terminals = state.terminals.filter((item) => item.id !== id);
      return {
        terminals,
        activeId: state.activeId === id ? neighbourId(state.terminals, id) : state.activeId,
      };
    });
    try {
      await window.oint.terminal.close(id);
    } catch (failure) {
      // 关不掉（进程已消失等）不该挡住界面：记录原因，本地已移除
      set({ error: failure instanceof Error ? failure.message : String(failure) });
    }
  },

  setActive(id) {
    set({ activeId: id });
  },

  applyEvent(event) {
    switch (event.type) {
      case "terminal-changed": {
        const info = event.terminal as TerminalInfo | undefined;
        if (info === undefined) return;
        set((state) => ({
          terminals: state.terminals.some((t) => t.id === info.id)
            ? state.terminals.map((t) => (t.id === info.id ? info : t))
            : [...state.terminals, info],
          // 第一个终端到达时自动选中（新建后马上收到推送的情形）
          activeId: state.activeId ?? info.id,
        }));
        return;
      }
      case "terminal-removed": {
        const id = typeof event.id === "string" ? event.id : undefined;
        if (id === undefined) return;
        set((state) => ({
          terminals: state.terminals.filter((t) => t.id !== id),
          activeId: state.activeId === id ? neighbourId(state.terminals, id) : state.activeId,
        }));
        return;
      }
      default:
        // terminal-data 由 xterm 视图自己消化（它要按 id 找到实例），不经这里
        return;
    }
  },

  clearError: () => set({ error: null }),
}));
