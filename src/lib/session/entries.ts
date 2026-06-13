// 会话自定义条目类型常量。
// pi 的 SessionMetadata 不可写自定义字段，这里用 appendCustomEntry 把
// 工作目录/团队归属/发言成员/投票等信息作为会话条目落进 jsonl，
// 读取时取最后一条同类型条目的值（后写覆盖先写）。

// 团队会话归属：把会话所属的 teamId 落为一条会话条目
export const TEAM_REF_ENTRY = "team_ref";
// 工作目录
export const WORKING_DIR_ENTRY = "working_dir";
// 会话级工具权限模式
export const TOOL_PERMISSION_MODE_ENTRY = "tool_permission_mode";
// 会话选中的知识库 ID 列表
export const KNOWLEDGE_BASE_IDS_ENTRY = "knowledge_base_ids";
// 运行中用户插入的引导。写在对应 user message 之前，回读时合并为 guidance segment。
export const GUIDANCE_ENTRY = "guidance";
// 团队发言成员：运行时在每位成员发言前写入其 agentId
export const TEAM_SPEAKER_ENTRY = "team_speaker";
// 团队投票
export const TEAM_VOTE_ENTRY = "team_vote";
// 目标模式配置（goalText / successCriteria / constraints / budgets）
export const GOAL_CONFIG_ENTRY = "goal_config";
// 目标模式事件（状态变更、检测结果、续跑 prompt、错误）
export const GOAL_EVENT_ENTRY = "goal_event";
