import type {
  ChatAttachment,
  ChatMessageStatus,
  ChatRole,
  ChatSkillRef,
  Segment,
} from "@/lib/chat";
import type { ToolPermissionMode } from "@/types/permissions";

export interface TeamMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
  model?: string;
  tokenCount?: number;
  // 输入 token 数
  inputTokens?: number;
  // 输出 token 数
  outputTokens?: number;
  // 缓存写入 token 数
  cacheWriteTokens?: number;
  // 缓存读取 token 数
  cacheReadTokens?: number;
  // 当前上下文 token 数（官方口径：最后一轮 usage 的 totalTokens || 四字段和）
  contextTokens?: number;
  attachments?: ChatAttachment[];
  skillRefs?: ChatSkillRef[];
  segments?: Segment[];
  // 错误信息（不影响 content 显示）
  error?: string;
  // 当前重试次数
  retryAttempt?: number;
  speakerAgentId?: string;
  vote?: {
    topic: string;
    initiatorId: string;
    options: Array<{
      id: string;
      label: string;
    }>;
    votes: Array<{
      agentId: string;
      optionId: string;
      timestamp: number;
    }>;
    memberStatuses?: Array<{
      agentId: string;
      status: "pending" | "voting" | "voted" | "failed";
      updatedAt: number;
      error?: string;
    }>;
    status: "pending" | "completed" | "cancelled";
    result?: {
      topOptionIds: string[];
      maxVotes: number;
    };
  };
}

export interface TeamThread {
  id: string;
  teamId: string;
  title: string;
  messages: TeamMessage[];
  updatedAt: number;
  loaded?: boolean;
  autoTitled?: boolean;
  workingDir?: string;
  permissionMode: ToolPermissionMode;
  knowledgeBaseIds?: string[]; // 当前会话选中的知识库 ID 列表
}
