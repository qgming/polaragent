// 团队控制信号 —— 由 control_team_flow 工具写入，团队调度器在每轮结束后读取。
// 使用模块级 map 是为了避开成员 harness 缓存：工具闭包可能跨轮复用，但 key 稳定。

export type TeamFlowAction =
  | "continue"
  | "handoff"
  | "finish"
  | "blocked";

export interface TeamControlSignal {
  action: TeamFlowAction;
  nextAgentId?: string;
  nextAgentName?: string;
  privateMessage?: string;
  reason: string;
  confidence: number;
}

function keyOf(threadId: string, agentId: string): string {
  return `${threadId}::${agentId}`;
}

const signals = new Map<string, TeamControlSignal>();

export function clearTeamControlSignal(threadId: string, agentId: string): void {
  signals.delete(keyOf(threadId, agentId));
}

export function setTeamControlSignal(
  threadId: string,
  agentId: string,
  signal: TeamControlSignal,
): void {
  signals.set(keyOf(threadId, agentId), signal);
}

export function consumeTeamControlSignal(
  threadId: string,
  agentId: string,
): TeamControlSignal | null {
  const key = keyOf(threadId, agentId);
  const signal = signals.get(key) ?? null;
  signals.delete(key);
  return signal;
}
