// 持久终端的共享契约：主进程持有 PTY 与回放缓冲，渲染层只消费快照与增量。
//
// 为什么另立一条通道，不复用 jobs（background job）：
// jobs 是给**模型**用的后台进程，stdio 是 ["ignore","pipe","pipe"] —— fd0 被丢弃，
// 没有任何写入口（见 main/pisdk/jobs.ts 的 spawn 与 JobService 接口）。它服务的是
// 「跑一条命令、读输出、杀掉」，天然是一次性的。
//
// 用户要的终端是**交互式**的：要能敲命令、要能看见 shell 提示符、要能 Ctrl+C、
// 要能改窗口大小。这四件事在 jobs 的模型里都不存在，所以这里用真 PTY 另起一套，
// 与 jobs 互不影响（作业面板照旧跑模型的后台任务）。

/** 终端状态：running 只在 PTY 进程还活着时成立；exited 是唯一终态 */
export type TerminalStatus = "running" | "exited";

/**
 * 一个终端会话的元信息（不含输出正文）。
 * 全部字段都是原始类型：它会随事件过结构化克隆送进渲染进程。
 */
export interface TerminalInfo {
  /** 全局自增的可预测 id：term-1、term-2 ……（与作业的 job-N 同一套编号习惯） */
  id: string;
  /** 展示名：取启动时的 shell 名 + 序号，面板标题用 */
  title: string;
  cwd: string;
  /** 实际启动的 shell 可执行文件路径，面板里作为提示显示 */
  shell: string;
  /** PTY 子进程 pid；杀进程树与调试都用它 */
  pid: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  /** 进程退出码；被信号杀死时可能没有 */
  exitCode?: number;
  startedAt: number;
  /** 进入终态的时间戳 */
  endedAt?: number;
  /** 累计从 PTY 收到的字节数（含已被环形缓冲淘汰的部分，所以只会单调增长） */
  totalBytes: number;
  /** 因超出回放缓冲上限而被丢弃的字节数（> 0 表示最早那段输出已经取不回来了） */
  droppedBytes: number;
}

/**
 * 回放缓冲里的一段输出。
 *
 * seq 是**绝对**序号（自增、不随淘汰回退），这是「按游标回放」的关键：
 * 渲染层记着自己消费到哪个 seq，重连时带着它来要增量，中间丢没丢一眼可见 ——
 * 不需要在主进程里为每个消费者维护游标（那样每多一个视图就多一份状态）。
 */
export interface TerminalChunk {
  seq: number;
  data: string;
}

/** 一次回放查询的结果：元信息 + 该游标之后的输出 + 下一次该带的游标 */
export interface TerminalReplay {
  terminal: TerminalInfo;
  /** fromSeq 之后的新增输出（按 seq 升序）；没有新增时是空数组 */
  chunks: TerminalChunk[];
  /** 下次回放应带的游标；等于「已返回的最后一段 seq + 1」 */
  nextSeq: number;
}

/** 主进程推送的终端事件（走单向通道，与 chat:event 同一套信封习惯） */
export type TerminalEvent =
  /** 某终端有新输出；data 与 seq 直接喂给 xterm 的 write */
  | { type: "terminal-data"; id: string; seq: number; data: string }
  /** 元信息变了（起、停、resize、淘汰）：面板据它更新标题栏与状态点 */
  | { type: "terminal-changed"; terminal: TerminalInfo }
  /** 终端被移除（用户关掉或进程退出后被清理）：面板据此关标签 */
  | { type: "terminal-removed"; id: string };
