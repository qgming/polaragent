// 工具层 —— 只装配 pi-agent-core 原生工具（bash / read / write / edit）
// src/ai/tools/index.ts
//
// 语义：本应用不自研工具，Agent 可见的工具面完全等于 pisdk 原生四件套。
// 文件与命令能力由 ElectronExecutionEnv（经 IPC 落到主进程安全层）提供，
// 审查与拦截由 harness 的 before_tool 钩子 + tool-permissions 统一负责。

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

export type { ExecutionEnv };

/** harness 注入的工具执行上下文：只需满足 pisdk 原生工具的 env 声明。 */
export interface ToolContext {
  env: ExecutionEnv;
}

/** 工具名 -> 中文展示标签（供权限审查文案与轨迹展示复用） */
export const TOOL_LABELS: Record<string, string> = {
  bash: "执行命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
};

export function toolDisplayName(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/**
 * 构建会话工具集：固定 4 个 pisdk 原生工具，无条件全量装配。
 * 不做开关、不按上下文过滤 —— 工具面收窄后无需再维护注册表与开关状态。
 */
export function buildAgentTools(): AgentHarnessTool<ToolContext, any, any>[] {
  return [
    createBashTool<ToolContext>(),
    createReadTool<ToolContext>(),
    createWriteTool<ToolContext>(),
    createEditTool<ToolContext>(),
  ] as AgentHarnessTool<ToolContext, any, any>[];
}
