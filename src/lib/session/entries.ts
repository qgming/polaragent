// 会话自定义条目类型常量。
// pi 的 SessionMetadata 不可写自定义字段，这里用 appendCustomEntry 把
// 工作目录/团队归属/发言成员/投票等信息作为会话条目落进 jsonl，
// 读取时取最后一条同类型条目的值（后写覆盖先写）。

// 团队会话归属：把会话所属的 teamId 落为一条会话条目
export const TEAM_REF_ENTRY = "team_ref";
// 工作目录
export const WORKING_DIR_ENTRY = "working_dir";
// 团队发言成员：运行时在每位成员发言前写入其 agentId
export const TEAM_SPEAKER_ENTRY = "team_speaker";
// 团队投票
export const TEAM_VOTE_ENTRY = "team_vote";
