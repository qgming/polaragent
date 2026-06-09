import type {
  ChatAttachment,
  ChatMessageStatus,
  ChatRole,
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
  attachments?: ChatAttachment[];
  segments?: Segment[];
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
}
