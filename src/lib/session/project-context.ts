import { loadChatMessages } from "./message-parser";
import { readTitleIndex } from "./title-index";

export interface ProjectConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ProjectConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

interface ListProjectConversationsOptions {
  projectId: string;
  currentThreadId?: string;
  query?: string;
  limit?: number;
}

interface ReadProjectConversationOptions {
  projectId: string;
  conversationId: string;
  maxMessages?: number;
  maxMessageChars?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_READ_MESSAGES = 24;
const DEFAULT_MAX_MESSAGE_CHARS = 1200;

export async function listProjectConversations({
  projectId,
  currentThreadId,
  query,
  limit = DEFAULT_LIST_LIMIT,
}: ListProjectConversationsOptions): Promise<ProjectConversationSummary[]> {
  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId) return [];

  const normalizedQuery = query?.trim().toLowerCase();
  const titleIndex = await readTitleIndex("normal");
  return Object.entries(titleIndex)
    .filter(([threadId, entry]) => {
      if (entry.projectId !== trimmedProjectId) return false;
      if (currentThreadId && threadId === currentThreadId) return false;
      if (!normalizedQuery) return true;
      return entry.title.toLowerCase().includes(normalizedQuery);
    })
    .map(([id, entry]) => ({
      id,
      title: entry.title || "未命名对话",
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function readProjectConversation({
  projectId,
  conversationId,
  maxMessages = DEFAULT_READ_MESSAGES,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
}: ReadProjectConversationOptions): Promise<{
  summary: ProjectConversationSummary;
  messages: ProjectConversationMessage[];
} | null> {
  const trimmedProjectId = projectId.trim();
  const trimmedConversationId = conversationId.trim();
  if (!trimmedProjectId || !trimmedConversationId) return null;

  const titleIndex = await readTitleIndex("normal");
  const entry = titleIndex[trimmedConversationId];
  if (!entry || entry.projectId !== trimmedProjectId) return null;

  const loaded = await loadChatMessages(trimmedConversationId).catch(() => []);
  const messages = loaded
    .filter((message) => message.content.trim().length > 0)
    .slice(-Math.max(1, Math.min(200, maxMessages)))
    .map((message) => ({
      role: message.role,
      content: truncateText(message.content, maxMessageChars),
      createdAt: message.createdAt,
    }));

  return {
    summary: {
      id: trimmedConversationId,
      title: entry.title || "未命名对话",
      updatedAt: entry.updatedAt,
    },
    messages,
  };
}

export function formatProjectConversationList(
  conversations: ProjectConversationSummary[],
): string {
  if (conversations.length === 0) return "当前项目没有可读取的其他会话。";
  return conversations
    .map(
      (conversation, index) =>
        `${index + 1}. ${conversation.title}\nID: ${conversation.id}\n更新时间: ${formatTimestamp(conversation.updatedAt)}`,
    )
    .join("\n\n");
}

export function formatProjectConversationMessages(result: {
  summary: ProjectConversationSummary;
  messages: ProjectConversationMessage[];
}): string {
  const lines = result.messages.map((message, index) => {
    const role = message.role === "user" ? "用户" : "助手";
    return `### ${index + 1}. ${role} (${formatTimestamp(message.createdAt)})\n${message.content}`;
  });

  return [
    `会话：${result.summary.title}`,
    `ID：${result.summary.id}`,
    `更新时间：${formatTimestamp(result.summary.updatedAt)}`,
    "",
    lines.length > 0 ? lines.join("\n\n") : "该会话暂无可读取的文本消息。",
  ].join("\n");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "未知";
  return new Date(value).toLocaleString();
}
