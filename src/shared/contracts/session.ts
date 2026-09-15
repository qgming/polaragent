/**
 * 会话种类。
 *
 * 左侧栏只列 `chat`：`subagent` 是**从属会话**，它的价值在「关联到发起它的主会话」，
 * 而不是在会话列表里占一行 —— 子智能体的一次运行所承载的转录（见 shared/contracts/subagent.ts）
 * 不进左侧栏。
 *
 * 缺省（undefined）一律按 `chat` 处理：旧索引里没有这个字段。
 */
export type SessionKind = "chat" | "subagent";

/** 只有这个种类的会话会出现在左侧栏 */
export const VISIBLE_SESSION_KIND: SessionKind = "chat";

/** 该种类的会话是否应当从左侧栏列表里隐藏 */
export function isHiddenSessionKind(kind: SessionKind | undefined): boolean {
  return kind !== undefined && kind !== VISIBLE_SESSION_KIND;
}

/**
 * 新建会话的入参。
 *
 * 从属会话（subagent）必须同时带上归属信息，否则「点开子智能体组件跳到它的记录」
 * 就只能靠再扫一遍全部会话来找 —— 关联关系必须在写入时就固定下来。
 */
export interface SessionCreateOptions {
  cwd?: string;
  title?: string;
  kind?: SessionKind;
  /** 发起它的主会话 id（subagent 用） */
  parentSessionId?: string;
  /** 子智能体运行时：派发它的那次 Task 工具调用 id */
  parentToolCallId?: string;
  /** 子智能体运行时：子智能体名 */
  agentName?: string;
  /** 子智能体运行时：运行 id（与 parentToolCallId 相同，冗余一份便于按会话查） */
  delegationId?: string;
}

import type { ModelRef } from "./common";

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  /** 会话种类；缺省按 "chat"。从属会话（subagent）不出现在左侧栏 */
  kind?: SessionKind;
  /** 发起它的主会话 id（kind 为从属会话时有效，等价于 kind !== "chat"） */
  parentSessionId?: string;
  /** 子智能体运行：派发它的那次 Task 工具调用 id 与子智能体名 */
  parentToolCallId?: string;
  agentName?: string;
  archived: boolean;
  /** 置顶：置顶的会话只出现在侧栏「置顶」分组，不再出现在项目/最近分组 */
  pinned: boolean;
  messageCount: number;
  /**
   * 该会话自己指定的模型；null = 跟随设置里的默认模型。
   *
   * 与 cwd 同一个模式：会话级选择优先，没有就回落到全局默认。持久化在会话索引里，
   * 所以重启后仍然生效。
   */
  model: ModelRef | null;
}

/** 切换会话模型失败的原因：界面据此给出具体说明，而不是笼统的「失败」 */
export type SessionModelFailure =
  /** 正在运行：中途换模型会让同一段对话里的工具调用/思考历史跨供应商，先停下再换 */
  | "running"
  /** 目标模型在当前设置里不存在（服务被删、模型被删，或压根没配） */
  | "no-model";

export type SetSessionModelResult = { ok: true } | { ok: false; reason: SessionModelFailure };

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** 流式期间可能尚未解析完成，保留原始文本；args 为解析成功后的结果 */
  argsText: string;
  args?: unknown;
  result?: unknown;
  /** 工具自己声明的结构化详情（如 edit 的 diff/patch）；形状由工具决定，渲染层按工具名取用 */
  details?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error" | "pending-approval" | "denied";
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  dataUrl: string;
}

export type ChatPart = TextPart | ReasoningPart | ToolCallPart | ImagePart;

export interface ChatMessageUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: string;
  /** 关联的会话存储条目 id；本地临时消息可为空 */
  entryId?: string;
  /**
   * pi 条目树里的父条目 id。渲染层据此把它交给 assistant-ui 的分支仓库，
   * 同一父条目下的多条助手回复即成为可切换的分支（重新生成会产生这种兄弟关系）。
   */
  parentId?: string | null;
  role: "user" | "assistant";
  /**
   * 这条消息是谁「说」的：用户亲手发的，还是系统内部产生的（目前只有后台作业的结束通知）。
   *
   * 为什么必须与 role 分开：`role` 决定**模型怎么读**（作业通知确实要以 user 身份进上下文，
   * 模型下一轮才看得见），而 `origin` 决定**界面怎么画** —— 作业通知不是用户说的话，
   * 画成普通用户气泡等于替用户发言（他会看到一句自己从没打过的话）。
   * 缺省（undefined）按 "user" 处理：历史消息与所有既有路径都不带这个字段。
   *
   * 跨重启存活：值来自 pi 的 custom 消息（customType 见 main/pisdk/runtime.ts 的
   * SYNTHETIC_MESSAGE_TYPE），历史回读时由 message-mapper 重新解析，因此不依赖内存。
   */
  origin?: "user" | "system";
  createdAt: number;
  parts: ChatPart[];
  status: "complete" | "streaming" | "error";
  usage?: ChatMessageUsage;
  error?: string;
}

/** 会话消息分页结果：nextCursor 存在时表示还能继续向上加载更早消息 */
export interface SessionMessagesPage {
  messages: ChatMessage[];
  compactionSummaries: string[];
  nextCursor?: number;
}

export interface LoadSessionMessagesOptions {
  limit?: number;
  beforeSeq?: number;
}
