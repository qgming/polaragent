// 原生工具装配：构建暴露给 Agent 的 bash/read/write/edit 四个 pi harness 工具。

import {
  type AgentHarnessTool,
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";

/** 工具名常量，供权限层与 UI 复用 */
export const TOOL_NAMES: { bash: "bash"; read: "read"; write: "write"; edit: "edit" } = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
};

/** bash 的 prepare 回调：工作目录固定为会话 ExecutionEnv.cwd，不受进程 cwd 影响 */
function prepareBash(execution: BashExecution, toolContext: ExecutionToolContext): void {
  execution.cwd = toolContext.env.cwd;
}

/** 构建本应用暴露给 Agent 的四个原生工具 */
export function buildTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return [
    createBashTool<ExecutionToolContext>({ prepare: prepareBash }),
    createReadTool<ExecutionToolContext>(),
    createWriteTool<ExecutionToolContext>(),
    createEditTool<ExecutionToolContext>(),
  ];
}
