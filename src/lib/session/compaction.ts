// 上下文压缩 - 基于 pi-agent-core 官方 API
// src/lib/session/compaction.ts
//
// pi-agent-core 0.80 的 AgentHarness 内置了自动压缩机制，
// 当上下文超过阈值时会自动触发 session_compact 事件。
// 这里仅导出官方 API 供外部使用（如需自定义压缩逻辑）。

export {
  estimateContextTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
