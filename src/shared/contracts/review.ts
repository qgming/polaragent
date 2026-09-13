// 右侧面板「审查」用到的契约：本次会话改动过的文件 + 逐文件补丁。
//
// 数据来源是**会话里已发生的写操作**，不是 git 工作树。
// 理由：仓库目前没有任何 git 集成（package.json 里没有 simple-git/isomorphic-git，
// main 侧也没有命令封装），而模型每次 write / edit 都会把 patch 放进工具结果，
// 那份 patch 就是「这次会话改了什么」最权威的记录 —— 它不依赖用户是否 git init、
// 是否已经提交过，也不需要再去跑一次 git diff 对齐。
//
// 代价必须说清楚：面板显示的是**本会话的改动**，不是「工作树相对 HEAD 的差异」。
// 用户在外部编辑器改的文件不会出现在这里。这是刻意的取舍，
// 因为前者能与对话一一对应（每条改动都能追到是哪次工具调用），后者不能。

/** 一处改动的形态 */
export type ChangeKind =
  /** 新建文件（write 了一个原先不存在的路径） */
  | "added"
  /** 修改已有文件（edit 改行，或 write 覆盖了已存在的路径） */
  | "modified";

/** 某次工具调用对某个文件做过的一次改动 */
export interface FileChange {
  /** 文件绝对路径（相对路径会按会话工作目录解析后归一） */
  path: string;
  /** 工作目录内的展示路径：能用相对路径就相对，跨目录时才回落绝对路径 */
  displayPath: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  /** 触发这次改动的工具名（write / edit），面板在行上标注来源 */
  tool: string;
  /** 该次工具调用的 id，用于在对话里定位这条记录 */
  toolCallId: string;
  /** 发生时间（消息 createdAt，毫秒） */
  at: number;
  /** 统一 diff 文本（供 DiffViewer 直接渲染）；取不到补丁时为 null */
  patch: string | null;
}

/** 审查面板的完整数据 */
export interface ReviewSummary {
  /** 允许访问的根（会话工作目录） */
  root: string;
  /** 按文件聚合后的改动，同一路径可能有多条（每次写操作一条，便于看清演进顺序） */
  changes: FileChange[];
  /** 去重后的文件数（面板顶部的「N 个文件」用，与 changes.length 不是一回事） */
  fileCount: number;
  /** 所有改动的增删行合计 */
  additions: number;
  deletions: number;
}
