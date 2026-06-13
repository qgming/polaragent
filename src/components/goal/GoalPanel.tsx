// 旧入口兼容：目标面板统一由 GoalSection 实现。
// src/components/goal/GoalPanel.tsx

import { GoalSection } from "./GoalSection";

export function GoalPanel({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}) {
  return <GoalSection threadId={threadId} agentId={agentId} />;
}
