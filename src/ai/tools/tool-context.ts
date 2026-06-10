// 工具上下文与共享辅助
// src/ai/tools/tool-context.ts
//
// 所有内置工具共享的执行上下文与路径/文本辅助函数。

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-agent-core";
import type { AgentConfig, TeamConfig } from "@/types/config";
import type { ToolPermissionMode } from "@/types/permissions";

// 工具执行时的会话上下文：把产物/待办归属到正确的会话与工作目录
export interface ToolContext {
  threadId: string;
  workingDir?: string;
  permissionMode: ToolPermissionMode;
  isTeam?: boolean;
  requester?: {
    id: string;
    name: string;
  };
  // 当前助手/团队上下文允许使用的技能。技能工具只能读取这里列出的技能。
  skills?: Skill[];
  // 当前会话选中的知识库 ID 列表
  knowledgeBaseIds?: string[];
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

// 路径分隔符归一为 "/"，并解析掉 "." 与 ".." 段（纯字符串实现，前端无 Node path）。
// 不触碰文件系统，仅做词法规范化。
function normalizeSegments(input: string): { prefix: string; parts: string[] } {
  const unified = input.replace(/\\/g, "/");
  // 提取盘符（C:/）或根（/）前缀，其余按 "/" 切段
  const driveMatch = unified.match(/^([a-zA-Z]:)\//);
  let prefix = "";
  let rest = unified;
  if (driveMatch) {
    prefix = `${driveMatch[1]}/`;
    rest = unified.slice(driveMatch[0].length);
  } else if (unified.startsWith("/")) {
    prefix = "/";
    rest = unified.slice(1);
  }
  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return { prefix, parts };
}

// 把相对路径解析到工作目录下；绝对路径原样使用。
// 设置了 workingDir 时，校验最终路径不逃逸出工作目录（防止 ".." 或绝对路径写到目录外）。
export function resolvePath(ctx: ToolContext, path: string): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (!ctx.workingDir) {
    if (isAbsolute) return path;
    throw new Error(
      `当前会话未设置工作目录，无法访问相对路径「${path}」。请先选择工作目录，或使用会话临时目录后再试。`,
    );
  }
  const base = ctx.workingDir.replace(/[\\/]+$/, "");
  const resolved = isAbsolute ? path : `${base}/${path}`;

  // 规范化后做前缀校验：解析路径必须落在工作目录之内（或正好等于工作目录）
  const baseNorm = normalizeSegments(base);
  const targetNorm = normalizeSegments(resolved);
  const within =
    baseNorm.prefix === targetNorm.prefix &&
    targetNorm.parts.length >= baseNorm.parts.length &&
    baseNorm.parts.every((part, i) => part === targetNorm.parts[i]);
  if (!within) {
    throw new Error(
      `路径越界：「${path}」超出了工作目录范围（${ctx.workingDir}），出于安全已拒绝访问。`,
    );
  }
  return resolved;
}

// 取路径中的文件名
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
