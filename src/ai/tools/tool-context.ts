// 工具上下文与共享辅助
// src/ai/tools/tool-context.ts
//
// 所有内置工具共享的执行上下文与路径/文本辅助函数。

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-agent-core";
import type { ToolPermissionMode } from "@/types/permissions";

// 工具执行时的会话上下文：把产物/待办归属到正确的会话与工作目录
export interface ToolContext {
  threadId: string;
  projectId?: string;
  workingDir?: string;
  permissionMode: ToolPermissionMode;
  isSubagent?: boolean;
  parentThreadId?: string;
  parentAgentId?: string;
  isBackground?: boolean;
  requester?: {
    id: string;
    name: string;
  };
  // 当前助手上下文允许使用的技能。技能工具只能读取这里列出的技能。
  skills?: Skill[];
  // 当前会话选中的知识库 ID 列表
  knowledgeBaseIds?: string[];
  // 浏览器扩展是否已连接；未指定时默认可用，保持向后兼容
  browserExtensionConnected?: boolean;
  // Computer Use 是否可用（Windows + Worker 就绪）；未指定时默认可用，保持向后兼容
  computerUseAvailable?: boolean;
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
// 注意：已移除工作目录限制，AI 可以访问用户有权限的所有文件路径。
export function resolvePath(ctx: ToolContext, path: string): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);

  // 绝对路径直接使用
  if (isAbsolute) {
    return path;
  }

  // 相对路径需要工作目录来解析
  if (!ctx.workingDir) {
    throw new Error(
      `当前会话未设置工作目录，无法访问相对路径「${path}」。请先选择工作目录，或使用会话临时目录后再试。`,
    );
  }

  // 将相对路径解析到工作目录下
  const base = ctx.workingDir.replace(/[\\/]+$/, "");
  const resolved = `${base}/${path}`;

  // 规范化路径（处理 . 和 .. 段）
  const normalized = normalizeSegments(resolved);
  return `${normalized.prefix}${normalized.parts.join("/")}`;
}

// 取路径中的文件名
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
