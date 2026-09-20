// 后台作业（background job）的共享契约：主进程持有进程与输出缓冲，渲染层只读它的一份快照。
//
// 为什么把长任务摘出回合：内核的 bash 工具没有默认超时，一条 dev server / watch 命令会把
// 整轮运行无限期挂住。作业的语义就是**活过这一轮** —— 起一个后台进程，用工具去读输出、
// 列表、杀掉它，退出时再把通知送回模型上下文（见 main/pisdk/jobs.ts）。

/** 作业状态：running 只有进程还活着时成立，其余三种都是终态 */
export type JobStatus = "running" | "exited" | "failed" | "killed";

/**
 * 一个后台作业的完整信息（不含输出正文；输出走 job_output / jobs.read 的 drain 读取）。
 *
 * 全部字段都是原始类型：它会随 ChatEvent 过结构化克隆送进渲染进程。
 */
export interface JobInfo {
  /** 全局自增的可预测 id（跨会话不重复）：job-1、job-2 …… 模型可以直接把它写进后续调用 */
  id: string;
  sessionId: string;
  /** 原样保存的命令行（通知文案与 job_list 都靠它，不重新拼） */
  command: string;
  cwd: string;
  /** spawn 成功后才有；spawn 直接失败（如 cwd 不存在）时没有 */
  pid?: number;
  status: JobStatus;
  /** 进程退出码；被信号杀死或 spawn 失败时没有 */
  exitCode?: number;
  startedAt: number;
  /** 进入终态的时间戳 */
  endedAt?: number;
  /** 从进程收到的字节总数（**含已被丢弃的字节**，所以它只会单调增长） */
  totalBytes: number;
  /** 中间是否发生过输出丢弃（有界缓冲的 head+tail 采样，见 jobs.ts 的 DrainBuffer） */
  truncated: boolean;
}

/** 一次输出读取的结果：新内容 + 快照，供工具直接渲染 */
export interface JobReadResult {
  /** 读取时刻的作业快照（状态、退出码、截断标记都在里面） */
  job: JobInfo;
  /**
   * **上一次读之后**新增的输出文本（drain 语义）。
   *
   * 若这段区间里发生过丢弃，文本中会插入 `...[N bytes omitted]...` 明示缺口；
   * 已经没有新内容时是空串。
   */
  output: string;
  /** 读取这一刻进程是否仍在运行（waitMs 到点后常常还是 true） */
  running: boolean;
}
