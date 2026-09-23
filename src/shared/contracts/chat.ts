import type { ApprovalDecision, ApprovalRequest } from "./approval";
import type { AskOutcome, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type {
  ChatMessage,
  ChatPart,
  ContextBreakdown,
  SessionStats,
  SessionTokenUsage,
} from "./session";

/** 待发送队列项：steer 立即插入当前轮次，followUp 在当前轮结束后发送 */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: "steer" | "followUp";
}

/** 发送时的额外控制：编辑用户消息要先把 lane 回退到该消息的父条目 */
export interface ChatSendOptions {
  /**
   * 回退到该条目再运行；`null` 表示回退到会话开头。不传则是一次普通发送。
   * 回退后必须随之追加一条消息（`text`）—— pi 拒收空 prompt，见 runtime 的 send。
   */
  rewindToEntryId?: string | null;
}

/**
 * 流式 part 的增量：只带新增的那一小段文本。
 *
 * 为什么必须有它：`part-upsert` 携带的是**整段累积文本**，模型每吐一个 token 都发一条，
 * 一条 50KB 的回复在流式期间要重复序列化/传输几十上百次（O(n²) 的 IPC 负载），
 * 渲染层每收到一条还要整篇重渲染。增量只传新增长度，IPC 负载降为 O(n)。
 *
 * 权威性：增量只是**优化通道**。对应 part 的创建 / 收尾仍由 part-upsert 全量给出
 *（text_end / toolcall_end 等），因此丢一条增量只会短暂少几个字，随后被全量校正；
 * 缺口过大时渲染层也可以用快照（chat:snapshot）整条补齐。
 */
export interface PartDeltaEvent {
  type: "part-delta";
  messageId: string;
  partIndex: number;
  /** 追加到 part 的哪个字段：正文 / 推理用 text，工具参数用 argsText */
  kind: "text" | "reasoning" | "args";
  delta: string;
}

/**
 * 工具运行期间的输出快照（内核 `tool_update` 事件的转发）。
 *
 * **语义是「替换」而不是「追加」**，所以它不能并进 `part-delta`（那个是拼字符串）。
 * 两个原因：
 * 1. 内核给的 `partialResult` 是**累计快照**（每次都是「到目前为止的全部输出」）；
 * 2. shell 捕获用 `retain: "tail"` —— 超过上限后早期内容会从**头部**丢掉。
 *
 * 于是「本次文本」与「上次文本」既不是前缀关系也不是追加关系，按「取新增部分」
 * 算出来的增量必然是错的（截断发生后会重复或错位）。所以这里整份下发，
 * 由渲染层覆盖 `ToolCallPart.partialOutput`。
 *
 * 主进程侧按工具调用节流：内核的推送频率跟随进程输出，不节流会把 IPC 打爆。
 */
export interface PartOutputEvent {
  type: "part-output";
  messageId: string;
  partIndex: number;
  /** 截至此刻的累计输出（可能已被内核按 tail 截断，**不是**完整输出） */
  text: string;
}

/**
 * 某会话当前流式消息的完整快照（没有在流的消息时为 null）。
 *
 * 渲染层错过创建事件（窗口重载、早于订阅达到等）时用它整条补齐 ——
 * 增量协议下「只收到后半段增量」会拼出错误文本，快照是唯一的权威修复手段。
 */
export interface ChatStreamSnapshot {
  messageId: string;
  parts: ChatPart[];
  createdAt: number;
}

/**
 * 压缩为什么发生。内核的 `compaction_start` / `compaction_end` 都带这个字段：
 * - `manual`：用户敲了 `/compact`；
 * - `threshold`：自动——估算上下文超过 `contextWindow − reserveTokens`；
 * - `overflow`：自动——供应商报了上下文溢出后的兜底（每代限一次）。
 *
 * 界面必须把它显示出来：同样是「压缩中」，用户主动触发的和后台自动发生的，
 * 解释完全不同。
 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** 压缩的结局。`declined` 是内核主动放弃（例如准备阶段发现没什么可压） */
export type CompactionStatus = "completed" | "declined" | "aborted" | "failed";

/**
 * `/compact` 的失败原因（IPC 用结果对象传递，不用抛异常）。
 *
 * 为什么要有稳定的 code：错误文案要按语言渲染，而主进程抛出的中文 message
 * 在英文界面里是错的语言；渲染层拿到 code 自己查词条，未知 code 再回落到 message。
 */
export type CompactFailureCode =
  /** lane 上压着别的操作（正在跑一轮、或已在压缩） */
  | "busy"
  /** 没有可压缩的历史（对话还很短） */
  | "nothing"
  /** 其他失败：message 里是主进程给出的人话原因 */
  | "failed";

export type CompactOutcome =
  | { ok: true }
  | { ok: false; code: CompactFailureCode; message: string };

/**
 * 渲染层维护的「这个会话最近一次压缩」。
 *
 * 由 `compaction-started` / `compaction-ended` 驱动（见 chat-store 的 applyEvent）。
 * 放在契约里而不是 store 里：store 与压缩条（ThreadToolbar）都要用，两处各写一份形状
 * 迟早会漂移。
 */
export interface SessionCompaction {
  /** 进行中 / 已完成 / 失败 / 已取消（declined 与 aborted 都归到 cancelled） */
  phase: "running" | "completed" | "failed" | "cancelled";
  reason: CompactionReason;
  startedAt: number;
  endedAt?: number;
  /** 完成时的摘要预览（前 200 字） */
  summaryPreview?: string;
  /** 完成时：压缩前估算的上下文 tokens */
  tokensBefore?: number;
  /** 完成时：压缩后保留的近期消息条数 */
  retainedCount?: number;
  /** 失败原因（主进程给的人话） */
  error?: string;
}

/** 主进程 → 渲染进程的聊天事件；渲染进程只消费，不反向发送 */
export type ChatEvent =
  | { type: "run-started"; runId: string }
  | { type: "message-added"; message: ChatMessage }
  | { type: "part-upsert"; messageId: string; partIndex: number; part: ChatPart }
  | PartDeltaEvent
  | PartOutputEvent
  | {
      type: "message-updated";
      messageId: string;
      patch: Partial<Pick<ChatMessage, "status" | "usage" | "error" | "entryId" | "parentId">>;
    }
  | { type: "queue-updated"; items: QueuedMessage[] }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string; decision: ApprovalDecision }
  /** 模型在关键分叉点上提问：渲染层把提问卡挂到消息流尾部，等用户作答 */
  | { type: "ask-requested"; request: AskRequest }
  | { type: "ask-resolved"; id: string; outcome: AskOutcome }
  /** 会话被 AI 自动命名（或改标题）：渲染层据此就地替换侧栏里的默认名 */
  | { type: "session-titled"; sessionId: string; title: string }
  /**
   * AI 预审出结论但不放行：请求仍挂起，等待用户覆盖。
   * 渲染层据此把审批卡从「审批中」切回可操作态，并显示 AI 给的理由。
   */
  | { type: "approval-reviewed"; id: string; reason: string }
  /**
   * 后台作业新建 / 状态变更 / 退出：渲染层据此维护作业列表
   * （服务见 main/pisdk/jobs.ts；退出时的模型通知见 runtime.ts 的作业唤醒预算）。
   */
  | { type: "job-changed"; job: JobInfo }
  /** 作业被淘汰，或随会话关闭 / 进程退出被清理：渲染层把它从列表里删掉 */
  | { type: "job-removed"; id: string }
  | {
      type: "compaction-started";
      reason: CompactionReason;
      startedAt: number;
    }
  | {
      type: "compaction-ended";
      reason: CompactionReason;
      status: CompactionStatus;
      endedAt: number;
      /** 完成时的摘要预览（前 200 字）；其他状态是空串 */
      summaryPreview: string;
      /** 完成时：压缩前估算的上下文 tokens（内核的 CompactionEntry.tokensBefore） */
      tokensBefore?: number;
      /** 完成时：压缩后保留的近期消息条数 */
      retainedCount?: number;
      /** 失败时的可读原因（主进程已经把内核的带 tag 错误转成人话） */
      error?: string;
    }
  /**
   * 会话级统计更新：turn/step 计数与 LLM/工具/TTFT/解码耗时。
   * 渲染层据此刷新输入框下方的状态条与「会话统计」弹层。
   */
  | { type: "session-stats"; stats: SessionStats }
  /**
   * 会话级 Token 用量合计更新：未缓存输入 / 缓存读取 / 缓存写入 / 输出。
   * 渲染层据此刷新「Token 用量」弹层与缓存命中率。
   */
  | { type: "token-usage"; usage: SessionTokenUsage }
  /**
   * 上下文占用分解更新：系统提示词 / 工具定义 / 对话消息三段的启发式估算。
   * 渲染层据此绘制输入框旁「上下文已用」环的展开面板。
   */
  | { type: "context-breakdown"; breakdown: ContextBreakdown }
  | { type: "run-ended"; runId: string; reason: string };

/**
 * 主进程 → 渲染进程的推送信封：事件 + 它属于哪个会话。
 *
 * 为什么归属要由主进程给出：主进程里每个会话各有独立的 harness / lane，可以同时在跑；
 * 渲染层不能再拿「当前打开的会话」去猜一条事件属于谁 —— 用户切走之后，后台会话的
 * 流式内容会被记到别的会话头上，侧栏的「运行中」也会跟着错。
 */
export interface ChatEventEnvelope {
  /** 事件所属会话 id */
  sessionId: string;
  event: ChatEvent;
}
