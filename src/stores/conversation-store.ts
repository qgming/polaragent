// 会话持久化 Store —— 基于 pi Session（JsonlSessionRepo）
// src/stores/conversation-store.ts
//
// 说明：消息本身的落盘由 AgentHarness.prompt() 自动完成（写入该线程的 pi Session）。
// 本 store 只负责：
//   - 会话列表（id/标题/更新时间）的内存镜像与读取
//   - 会话的创建/删除/清空/重命名（落到 pi Session）
//   - 按需回读某会话的历史消息（从 pi Session 重建 ChatMessage[]）
// 因此 saveMessage 不再手动写消息（harness 已写），仅保留为兼容空操作。

import { create } from "zustand";
import type { ChatMessage } from "./chat-store";
import {
  deleteSession,
  listSessions,
  openOrCreateSession,
  setSessionTitle,
} from "@/lib/session/session-operations";
import { loadChatMessages } from "@/lib/session/message-parser";
import {
  removeTitleIndex,
  upsertTitleIndex,
} from "@/lib/session/title-index";

// 会话列表项（标题来自 pi Session 的 session name；缺省回退）
export interface ConversationMetaLite {
  id: string;
  title: string;
  updatedAt: number;
}

interface ConversationState {
  conversations: ConversationMetaLite[];
  isLoading: boolean;
  error: string | null;

  loadConversations: () => Promise<void>;
  loadConversation: (id: string) => Promise<ChatMessage[]>;
  // 兼容旧接口：消息已由 harness 自动持久化，这里不再手动写
  saveMessage: (
    conversationId: string,
    message: ChatMessage,
    agentId: string,
  ) => Promise<void>;
  createNewConversation: (
    id: string,
    title: string,
    agentId: string,
  ) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  clearConversation: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  isLoading: false,
  error: null,

  // 从 pi Session 仓库回读会话列表
  loadConversations: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await listSessions();
      const conversations: ConversationMetaLite[] = sessions.map((session) => ({
        id: session.id,
        title: session.title || "新对话",
        // 优先用索引里的 updatedAt（反映重命名/清空等活动），缺失则回退创建时间
        updatedAt: session.updatedAt ?? (Date.parse(session.createdAt) || 0),
      }));
      set({ conversations });
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载会话失败";
      set({ error: message });
      console.error("加载会话失败:", error);
    } finally {
      set({ isLoading: false });
    }
  },

  // 回读单个会话的历史消息（从 pi Session 重建，含 segments）
  loadConversation: async (id: string) => {
    try {
      return await loadChatMessages(id);
    } catch (error) {
      console.error(`加载会话失败 ${id}:`, error);
      return [];
    }
  },

  // 消息已由 AgentHarness 自动写入 pi Session，这里无需重复落盘
  saveMessage: async () => {
    // no-op：保留以兼容历史调用点
  },

  // 创建新会话：确保对应 pi Session 文件存在，并写入标题
  createNewConversation: async (id: string, title: string) => {
    try {
      await openOrCreateSession(id);
      if (title && title !== "新对话") {
        await setSessionTitle(id, title);
      }
      const updatedAt = Date.now();
      // 同步标题索引，使侧边栏下次启动走快路径（只读 titles.json）
      await upsertTitleIndex(id, title || "新对话", updatedAt);
      set((state) => ({
        conversations: [
          { id, title: title || "新对话", updatedAt },
          ...state.conversations.filter((c) => c.id !== id),
        ],
      }));
    } catch (error) {
      console.error("创建会话失败:", error);
      throw error;
    }
  },

  // 重命名会话（写入 pi Session 的 session name）
  renameConversation: async (id: string, title: string) => {
    try {
      await setSessionTitle(id, title);
      const updatedAt = Date.now();
      // 同步标题索引
      await upsertTitleIndex(id, title, updatedAt);
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title, updatedAt } : c,
        ),
      }));
    } catch (error) {
      console.error("重命名会话失败:", error);
      throw error;
    }
  },

  // 删除会话（连同 pi Session 文件）
  deleteConversation: async (id: string) => {
    try {
      await deleteSession(id);
      // 同步从标题索引移除
      await removeTitleIndex(id);
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
      }));
    } catch (error) {
      console.error("删除会话失败:", error);
      throw error;
    }
  },

  // 清空会话内容：删除旧 session 后重建一个同 id 的空 session
  clearConversation: async (id: string) => {
    try {
      await deleteSession(id);
      await openOrCreateSession(id);
      const updatedAt = Date.now();
      // 清空后标题保持不变，仅刷新更新时间
      set((state) => {
        const target = state.conversations.find((c) => c.id === id);
        void upsertTitleIndex(id, target?.title || "新对话", updatedAt);
        return {
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, updatedAt } : c,
          ),
        };
      });
    } catch (error) {
      console.error("清空会话失败:", error);
      throw error;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
