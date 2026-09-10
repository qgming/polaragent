// 会话自定义条目类型常量。
// pi 的 SessionMetadata 不可写自定义字段，这里用 appendCustomEntry 把
// 工作目录、工具权限模式等信息作为会话条目落进 jsonl，
// 读取时取最后一条同类型条目的值（后写覆盖先写）。

// 工作目录
export const WORKING_DIR_ENTRY = "working_dir";
// 会话级工具权限模式
export const TOOL_PERMISSION_MODE_ENTRY = "tool_permission_mode";
// 运行中用户插入的引导。写在对应 user message 之前，回读时合并为 guidance part。
export const GUIDANCE_ENTRY = "guidance";
