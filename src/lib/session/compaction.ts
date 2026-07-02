// 上下文压缩 - pi-agent-core 官方 API 的统一再导出层
// src/lib/session/compaction.ts
//
// 注意：AgentHarness 只提供手动 compact()，不会自动触发压缩。
// 自动压缩的触发点在本项目内：回合结束后（src/ai/agent.ts）与打开会话时
// （src/stores/chat-store.ts）。两处的阈值判断与上下文口径都必须经由
// 这里导出的官方 API（shouldCompact / calculateContextTokens /
// estimateContextTokens），避免各处手写公式导致口径漂移。

export {
  calculateContextTokens,
  estimateContextTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  getLastAssistantUsage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
