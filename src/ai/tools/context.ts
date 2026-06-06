// 工具上下文与共享辅助
// src/ai/tools/context.ts
//
// 所有内置工具共享的执行上下文与路径/文本辅助函数。

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig, TeamConfig } from "@/types/config";

// 工具执行时的会话上下文：把产物/待办归属到正确的会话与工作目录
export interface ToolContext {
  threadId: string;
  workingDir?: string;
  isTeam?: boolean;
  requester?: {
    id: string;
    name: string;
  };
  // 团队成员工具上下文。存在时团队成员可发起投票。
  teamVote?: {
    team: TeamConfig;
    initiatorId: string;
  };
  // 团队流程控制上下文。存在时团队成员可用 control_team_flow 控制接力/结束。
  teamFlow?: {
    threadId: string;
    team: TeamConfig;
    currentAgentId: string;
    members: AgentConfig[];
  };
  // 团队投票收集阶段专用上下文。存在时只允许当前成员用 cast_team_vote 落票。
  teamCastVote?: {
    voteId: string;
    voterId: string;
    options: Array<{ id: string; label: string }>;
    onCast: (optionId: string) => void;
  };
}

// 构造返回给模型的文本内容
export function text(value: string): AgentToolResult<unknown>["content"] {
  return [{ type: "text", text: value }];
}

// 把相对路径解析到工作目录下；绝对路径原样返回
export function resolvePath(ctx: ToolContext, path: string): string {
  if (!ctx.workingDir) return path;
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbsolute) return path;
  const base = ctx.workingDir.replace(/[\\/]+$/, "");
  return `${base}/${path}`;
}

// 取路径中的文件名
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
