// 会话自定义条目类型常量。
// pi 的 SessionMetadata 不可写自定义字段，这里用 appendCustomEntry 把
// 工作目录、知识库、目标、项目归属等信息作为会话条目落进 jsonl，
// 读取时取最后一条同类型条目的值（后写覆盖先写）。

// 工作目录
export const WORKING_DIR_ENTRY = "working_dir";
// 会话级工具权限模式
export const TOOL_PERMISSION_MODE_ENTRY = "tool_permission_mode";
// 会话选中的知识库 ID 列表
export const KNOWLEDGE_BASE_IDS_ENTRY = "knowledge_base_ids";
// 运行中用户插入的引导。写在对应 user message 之前，回读时合并为 guidance segment。
export const GUIDANCE_ENTRY = "guidance";
// 目标模式配置（goalText / successCriteria / constraints / budgets）
export const GOAL_CONFIG_ENTRY = "goal_config";
// 目标模式事件（状态变更、检测结果、续跑 prompt、错误）
export const GOAL_EVENT_ENTRY = "goal_event";
// 项目会话归属：把会话所属的 projectId 落为一条会话条目
export const PROJECT_REF_ENTRY = "project_ref";
// 会话级助手 ID：把会话当前使用的 agentId 落为一条会话条目
export const AGENT_ID_ENTRY = "agent_id";
