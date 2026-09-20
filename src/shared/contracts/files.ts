// 右侧面板「文件」用到的文件系统契约。
//
// 只有两个动作：列一层目录、读一个文件。刻意不做递归整树 ——
// 工作目录里常有 node_modules / .git 这种几万条目的子树，一次拉全树既慢又占内存，
// 而面板是逐个文件夹点开的，按需取一层就够。
//
// **根由主进程按 sessionId 解析**（会话绑定的工作目录），渲染层只能给会话 id、给不了路径。
// 这条边界是必须的：早先的实现让渲染层传 root，而主进程用「路径在它自己内部」来校验它 ——
// 那个判断恒真，等于没有校验，面板可以退化成任意路径读取器。
// 现在 root 的来源是服务端的会话索引，渲染层无法影响它（见 main/ipc/files.ts）。

/** 目录里的一项 */
export interface FileTreeEntry {
  /** 绝对路径（面板据此继续下钻与预览） */
  path: string;
  /** 展示名（不含父目录） */
  name: string;
  kind: "file" | "directory";
  /** 文件字节数；目录没有 */
  size?: number;
  /** 最后修改时间（毫秒）；取不到时没有 */
  mtime?: number;
  /** 是符号链接：面板上给一个小标记，避免用户以为是普通目录 */
  symlink?: boolean;
}

/** 列目录的结果 */
export interface DirectoryListing {
  /** 被列的目录绝对路径 */
  path: string;
  /** 允许访问的根（会话工作目录）；等于 path 时面板显示为树根 */
  root: string;
  /** 上一级目录；已经是 root 时为 null（面板据此禁用「返回上级」） */
  parent: string | null;
  entries: FileTreeEntry[];
  /** 因条目过多被截断（只返回前 N 条），面板提示用户用更深的目录 */
  truncated: boolean;
}

/** 读文件的结果 */
export interface FileContent {
  path: string;
  /** 等宽体预览的正文 */
  text: string;
  /** 内容超过上限被截断（面板显示提示，不假装文件就这么长） */
  truncated: boolean;
  /** 文件真实字节数（截断时它是完整大小，不是 text 的长度） */
  size: number;
  /** 文本按 UTF-8 解码时出现过替换字符：面板提示「可能是二进制文件」 */
  binary: boolean;
}
