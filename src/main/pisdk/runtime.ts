// 会话运行时：装配 AgentHarness、把 pi 事件桥接为 ChatEvent、维护运行/队列/审批门。

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentHarness,
  type AgentLane,
  type AgentMessage,
  type AgentToolResult,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  type ExecutionToolContext,
  type HarnessEvent,
  type HarnessEventType,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { dataDir } from "@/main/app/paths";
import type { ChatEvent, ChatSendOptions, QueuedMessage } from "@/shared/contracts/chat";
import type {
  ChatMessageUsage,
  ChatPart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import type { ApprovalService } from "./approvals";
import { createExecEnv } from "./exec-env";
import { assessToolRisk, createPermissionRuleStore, type PermissionRuleStore } from "./permissions";
import { buildProviders, resolveModel } from "./providers";
import type { SessionStore } from "./session-store";
import { buildTools, TOOL_NAMES } from "./tools";

export interface ChatRuntimeDeps {
  getSettings: () => Promise<Settings>;
  sessionStore: SessionStore;
  /** 发往渲染进程的事件（由 IPC 层注入，内部做好异常隔离） */
  emit: (event: ChatEvent) => void;
  approvals: ApprovalService;
  /** 会话工作目录解析；默认取索引 cwd，其次 settings.defaultWorkingDir */
  resolveWorkingDir: (sessionId: string) => Promise<string>;
}

/**
 * 当前 lane 的 tip（条目 id，可能为 null 表示空会话）。
 *
 * `known: false` 表示读取失败 —— 与「tip 是 null」是两回事，调用方必须能区分：
 * 把读失败当成 null 会让「回退到会话开头」被误判成「目标已是 tip」而跳过导航。
 */
async function currentTip(runtime: SessionRuntime): Promise<{ known: boolean; tipId: string | null }> {
  try {
    const info = await runtime.lane.inspectExecution(BACKGROUND_CONTEXT);
    return { known: true, tipId: info.tipId };
  } catch (error) {
    console.warn(`读取当前 tip 失败：${toErrorText(error)}`);
    return { known: false, tipId: null };
  }
}

export interface ChatRuntime {
  send(
    sessionId: string,
    text: string,
    images?: ImageContent[],
    messageId?: string,
    options?: ChatSendOptions,
  ): Promise<void>;
  stop(sessionId: string): Promise<void>;
  queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void>;
  compact(sessionId: string, instructions?: string): Promise<void>;
  isRunning(sessionId: string): boolean;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** before_tool 钩子判定结果：返回 block 即阻断工具调用 */
export interface ToolPermissionResult {
  block: { reason: string; terminate?: boolean };
}

type SessionHandle = NonNullable<Awaited<ReturnType<SessionStore["open"]>>>["session"];

/** 流式 assistant 消息的累积状态 */
interface AssistantStream {
  messageId: string;
  parts: ChatPart[];
  /** contentIndex → parts 下标，保证同一内容块增量合并 */
  partIndexByContent: Map<number, number>;
}

/** toolCallId → 消息中的 part 引用，供 tool_end / 权限门回填状态 */
interface ToolCallPartRef {
  messageId: string;
  partIndex: number;
  part: ToolCallPart;
}

interface SessionRuntime {
  sessionId: string;
  session: SessionHandle;
  harness: AgentHarness<ExecutionToolContext>;
  lane: AgentLane;
  env: ExecutionEnv;
  rules: PermissionRuleStore;
  running: boolean;
  /** 本次运行的本地 runId，保证 run-started 与 run-ended 对应 */
  runId?: string;
  /** run_end 事件是否已处理，避免 prompt 异常时重复发 run-ended */
  runEnded: boolean;
  stream?: AssistantStream;
  lastAssistantMessageId?: string;
  /**
   * 已建好但还没拿到 entryId 的消息，按建立顺序排队。
   *
   * 条目要到消息落盘时才产生（entry_added 事件），而渲染层需要 entryId 才有「分支」入口、
   * 重新生成也需要它作为回退点。**必须带角色**：一次运行会先落用户条目再落助手条目，
   * 只按顺序弹队首会把助手条目配到用户消息上（用户消息永远拿不到 id、助手拿到错 id，
   * 重新生成随即报 "target must differ from the current tip"）。
   */
  pendingEntries: PendingEntry[];
  /** 渲染层乐观用户消息 id：主进程回显同一条用户消息时复用，避免 UI 出现两条 */
  pendingUserMessageId?: string;
  toolParts: Map<string, ToolCallPartRef>;
  queue: QueuedMessage[];
  unsubscribers: Array<() => void>;
}

/** 等待 entry_added 配对的消息：id 与角色（角色用来和条目对齐） */
export interface PendingEntry {
  messageId: string;
  role: "user" | "assistant";
}

let defaultRuntime: ChatRuntime | null = null;
let sharedRuleStore: PermissionRuleStore | null = null;

/** 默认单例：bootstrap 装配时经 createChatRuntime 注册，IPC 层通过 getChatRuntime 取用 */
export function getChatRuntime(): ChatRuntime {
  if (!defaultRuntime) throw new Error("聊天运行时尚未初始化");
  return defaultRuntime;
}

function getRuleStore(): PermissionRuleStore {
  sharedRuleStore ??= createPermissionRuleStore(dataDir());
  return sharedRuleStore;
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function mapUsage(usage: Usage): ChatMessageUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    totalTokens: usage.totalTokens,
  };
}

/** 用户消息内容块 → ChatPart（文本 / 图片），与历史回读的映射保持一致 */
function mapUserParts(message: Extract<AgentMessage, { role: "user" }>): ChatPart[] {
  const parts: ChatPart[] = [];
  if (typeof message.content === "string") {
    if (message.content !== "") parts.push({ type: "text", text: message.content });
    return parts;
  }
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image",
        mimeType: block.mimeType,
        dataUrl: `data:${block.mimeType};base64,${block.data}`,
      });
    }
  }
  return parts;
}

function agentMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 工具结果 → UI 值：优先文本，其次 details，最后原样返回 */
function toolResultValue(result: AgentToolResult<unknown>): unknown {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text !== "") return text;
  if (result.details !== undefined) return result.details;
  return "";
}

/**
 * 条目落盘 → 配给哪条待配的消息，并把该消息移出队列。
 *
 * 按**角色**配对，而不是弹队首：运行会先落用户条目、后落助手条目，
 * 弹队首会让助手条目认领用户消息的 id（用户消息拿不到 entryId，助手拿到错的）。
 * 同一角色内部仍按 FIFO —— 一次运行的多轮工具调用会连续产生多条助手消息与多个条目。
 * 提到模块级是为了可测：这段判定在 createChatRuntime 的闭包里够不到。
 */
export function pairEntryWithMessage(
  pending: PendingEntry[],
  entry: { type: string; id: string; parentId: string | null; message?: { role?: string } },
): { messageId: string; patch: { entryId: string; parentId: string | null } } | null {
  if (entry.type !== "message") return null;
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant") return null;

  const index = pending.findIndex((item) => item.role === role);
  if (index < 0) return null;
  const [matched] = pending.splice(index, 1);
  if (matched === undefined) return null;
  return { messageId: matched.messageId, patch: { entryId: entry.id, parentId: entry.parentId } };
}

/**
 * tool_end 事件 → 该 part 的字段补丁（流式路径）。
 *
 * 文本结果会盖住 details，两者都留：工具的结构化详情（edit 的 patch 等）只有 details 里有，
 * 渲染层靠它决定展开面板用 diff 还是纯文本。
 * 提到模块级是为了可测：这段写入在 createChatRuntime 的闭包里够不到，
 * 与 message-mapper 的 applyToolResult（历史回读路径）对称，两条路径各有一个可测入口。
 */
export function applyToolEnd(
  part: ToolCallPart,
  result: AgentToolResult<unknown>,
  isError: boolean,
): void {
  part.result = toolResultValue(result);
  if (result.details !== undefined) part.details = result.details;
  part.isError = isError;
  part.status = isError ? "error" : "done";
}

/**
 * always_allow 的规则模式：bash 取命令首词，write/edit 取路径首段（跳过盘符）；
 * 无法提取时返回 undefined，表示该工具全局放行。
 */
export function deriveRulePattern(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === TOOL_NAMES.bash) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const first = command.split(/\s+/)[0];
    return first === undefined || first === "" ? undefined : first;
  }
  if (toolName === TOOL_NAMES.write || toolName === TOOL_NAMES.edit) {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (target === "") return undefined;
    return target.split(/[\\/]+/).find((item) => item !== "" && !/^[a-zA-Z]:$/.test(item));
  }
  return undefined;
}

/** 系统提示：工作目录 + 基本规则 + 可选 AGENTS.md；保持简洁，不做复杂模板 */
export async function buildSystemPrompt(settings: Settings, cwd: string): Promise<string> {
  const replyLanguage = settings.language === "en-US" ? "英文" : "简体中文";
  const sections = [
    `你是 PolarAgent 桌面应用中的智能编程助手。当前会话工作目录：${cwd}，相对路径均基于该目录解析。`,
    [
      "工作规则：",
      "1. 修改代码前先阅读相关文件，不要凭空猜测；",
      "2. 通过工具完成文件读写与命令执行，不要编造执行结果；",
      `3. 使用${replyLanguage}回复用户。`,
    ].join("\n"),
  ];

  let custom = "";
  try {
    custom = (await readFile(path.join(dataDir(), "AGENTS.md"), "utf8")).trim();
  } catch {
    // AGENTS.md 不存在或不可读：静默忽略
    custom = "";
  }
  if (custom !== "") sections.push(`用户自定义指令（AGENTS.md）：\n${custom}`);
  return sections.join("\n\n");
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  const runtimes = new Map<string, SessionRuntime>();
  const creations = new Map<string, Promise<SessionRuntime>>();

  function emitSafe(event: ChatEvent): void {
    try {
      deps.emit(event);
    } catch (error) {
      console.warn(`发送聊天事件失败：${toErrorText(error)}`);
    }
  }

  function subscribe<T extends HarnessEventType>(
    runtime: SessionRuntime,
    type: T,
    handler: (event: Extract<HarnessEvent, { type: T }>) => void | Promise<void>,
  ): void {
    runtime.unsubscribers.push(
      runtime.harness.events.on(type, (event) => {
        void Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => {
            console.warn(`处理会话事件失败（${type}）：${toErrorText(error)}`);
          });
      }),
    );
  }

  function upsertPart(stream: AssistantStream, partIndex: number, part: ChatPart): void {
    emitSafe({ type: "part-upsert", messageId: stream.messageId, partIndex, part });
  }

  /** 取或创建文本 / 推理 part，保证 contentIndex 与 parts 下标一一对应 */
  function partFor(
    stream: AssistantStream,
    contentIndex: number,
    kind: "text" | "reasoning",
  ): { part: TextPart | ReasoningPart; index: number } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === kind) {
        return { part: existing as TextPart | ReasoningPart, index: existingIndex };
      }
    }
    const created: TextPart | ReasoningPart =
      kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" };
    stream.parts.push(created);
    const index = stream.parts.length - 1;
    stream.partIndexByContent.set(contentIndex, index);
    return { part: created, index };
  }

  /** 取或创建工具调用 part；工具流式期间允许参数文本增量追加 */
  function toolPartFor(
    stream: AssistantStream,
    contentIndex: number,
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  ): { part: ToolCallPart; index: number } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === "tool-call") {
        if (toolCall.name !== "") existing.toolName = toolCall.name;
        if (toolCall.id !== "") existing.toolCallId = toolCall.id;
        return { part: existing, index: existingIndex };
      }
    }
    const created: ToolCallPart = {
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argsText: "",
      status: "running",
    };
    stream.parts.push(created);
    const index = stream.parts.length - 1;
    stream.partIndexByContent.set(contentIndex, index);
    return { part: created, index };
  }

  function handleMessageStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_start" }>,
  ): void {
    const message = event.message;
    if (message.role === "assistant") {
      const messageId = randomUUID();
      runtime.stream = { messageId, parts: [], partIndexByContent: new Map() };
      runtime.lastAssistantMessageId = messageId;
      // 排队等 entry_added 把条目 id 配回来（渲染层的「分支」入口需要它）
      runtime.pendingEntries.push({ messageId, role: "assistant" });
      emitSafe({
        type: "message-added",
        message: {
          id: messageId,
          role: "assistant",
          createdAt: Date.now(),
          parts: [],
          status: "streaming",
        },
      });
      return;
    }
    if (message.role === "user") {
      // 复用渲染层乐观消息 id：upsertMessage 按 id 覆盖，避免同一条用户消息显示两次
      const reuseId = runtime.pendingUserMessageId;
      runtime.pendingUserMessageId = undefined;
      const messageId = reuseId ?? randomUUID();
      // 用户消息也要 entryId：重新生成要靠它把 lane 退回这条（退回后新回复成为兄弟条目）
      runtime.pendingEntries.push({ messageId, role: "user" });
      emitSafe({
        type: "message-added",
        message: {
          id: messageId,
          role: "user",
          createdAt: Date.now(),
          parts: mapUserParts(message),
          status: "complete",
        },
      });
    }
  }

  function handleMessageUpdate(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_update" }>,
  ): void {
    const stream = runtime.stream;
    if (!stream) return;
    const update = event.event;

    if (
      update.type === "text_start" ||
      update.type === "text_delta" ||
      update.type === "text_end"
    ) {
      const { part, index } = partFor(stream, update.contentIndex, "text");
      const textPart = part as TextPart;
      if (update.type === "text_delta") textPart.text += update.delta;
      else if (update.type === "text_end") textPart.text = update.content;
      upsertPart(stream, index, textPart);
      return;
    }

    // reasoning=false 时也可能出现 thinking 事件，这里完全按增量防御性处理
    if (
      update.type === "thinking_start" ||
      update.type === "thinking_delta" ||
      update.type === "thinking_end"
    ) {
      const { part, index } = partFor(stream, update.contentIndex, "reasoning");
      const reasoningPart = part as ReasoningPart;
      if (update.type === "thinking_delta") reasoningPart.text += update.delta;
      else if (update.type === "thinking_end") reasoningPart.text = update.content;
      upsertPart(stream, index, reasoningPart);
      return;
    }

    if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
      const content = update.partial.content[update.contentIndex];
      if (content?.type !== "toolCall") return;
      const { part, index } = toolPartFor(stream, update.contentIndex, content);
      if (update.type === "toolcall_delta") part.argsText += update.delta;
      runtime.toolParts.set(part.toolCallId, {
        messageId: stream.messageId,
        partIndex: index,
        part,
      });
      upsertPart(stream, index, part);
      return;
    }

    if (update.type === "toolcall_end") {
      const { part, index } = toolPartFor(stream, update.contentIndex, update.toolCall);
      part.toolCallId = update.toolCall.id;
      part.toolName = update.toolCall.name;
      part.args = update.toolCall.arguments;
      part.argsText = safeStringify(update.toolCall.arguments);
      runtime.toolParts.set(part.toolCallId, {
        messageId: stream.messageId,
        partIndex: index,
        part,
      });
      upsertPart(stream, index, part);
    }
    // start / done / error 等类型不需要额外动作
  }

  function handleMessageEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_end" }>,
  ): void {
    const message = event.message;
    const stream = runtime.stream;
    if (message.role !== "assistant" || !stream) return;
    const failed = message.stopReason === "error";
    emitSafe({
      type: "message-updated",
      messageId: stream.messageId,
      patch: {
        status: failed ? "error" : "complete",
        usage: mapUsage(message.usage),
        ...(failed ? { error: message.errorMessage ?? "模型返回错误" } : {}),
      },
    });
    runtime.lastAssistantMessageId = stream.messageId;
    runtime.stream = undefined;
  }

  function handleToolStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "tool_start" }>,
  ): void {
    const ref = runtime.toolParts.get(event.toolCallId);
    if (ref) {
      ref.part.toolName = event.toolName;
      ref.part.args = event.args;
      ref.part.argsText = safeStringify(event.args);
      emitSafe({
        type: "part-upsert",
        messageId: ref.messageId,
        partIndex: ref.partIndex,
        part: ref.part,
      });
      return;
    }
    // 防御：toolcall_end 缺失时补建 part，保证工具状态可见
    const stream = runtime.stream;
    if (!stream) return;
    const part: ToolCallPart = {
      type: "tool-call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsText: safeStringify(event.args),
      args: event.args,
      status: "running",
    };
    stream.parts.push(part);
    const index = stream.parts.length - 1;
    runtime.toolParts.set(event.toolCallId, {
      messageId: stream.messageId,
      partIndex: index,
      part,
    });
    emitSafe({ type: "part-upsert", messageId: stream.messageId, partIndex: index, part });
  }

  function handleToolEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "tool_end" }>,
  ): void {
    const ref = runtime.toolParts.get(event.toolCallId);
    if (!ref) return;
    applyToolEnd(ref.part, event.result, event.isError);
    emitSafe({
      type: "part-upsert",
      messageId: ref.messageId,
      partIndex: ref.partIndex,
      part: ref.part,
    });
  }

  function handleRunEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "run_end" }>,
  ): void {
    const stream = runtime.stream;
    if (stream) {
      const failed = event.status === "failed";
      emitSafe({
        type: "message-updated",
        messageId: stream.messageId,
        patch: {
          status: failed ? "error" : "complete",
          ...(failed ? { error: event.error.message } : {}),
        },
      });
      runtime.lastAssistantMessageId = stream.messageId;
      runtime.stream = undefined;
    } else if (event.status === "failed" && runtime.lastAssistantMessageId) {
      emitSafe({
        type: "message-updated",
        messageId: runtime.lastAssistantMessageId,
        patch: { status: "error", error: event.error.message },
      });
    }
    runtime.running = false;
    runtime.runEnded = true;
    runtime.queue = [];
    emitSafe({ type: "queue-updated", items: [] });
    emitSafe({ type: "run-ended", runId: runtime.runId ?? event.runId, reason: event.status });
    void touchSession(runtime);
  }

  function handleUsage(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "usage" }>,
  ): void {
    const messageId = runtime.stream?.messageId ?? runtime.lastAssistantMessageId;
    if (!messageId) return;
    emitSafe({
      type: "message-updated",
      messageId,
      patch: { usage: mapUsage(event.row.usage) },
    });
  }

  /** queue_update 是 lane 的真实队列，直接映射为 UI 队列项 */
  function handleQueueUpdate(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "queue_update" }>,
  ): void {
    const items = event.queues.flatMap((item): QueuedMessage[] => {
      if (item.type !== "message" || (item.kind !== "steer" && item.kind !== "followUp")) {
        return [];
      }
      return [{ id: item.entryId, text: agentMessageText(item.message), mode: item.kind }];
    });
    runtime.queue = items;
    emitSafe({ type: "queue-updated", items });
  }

  /** 压缩摘要预览：取不到时返回空串，不阻塞事件流 */
  async function compactionPreview(
    runtime: SessionRuntime,
    entryId: string | undefined,
  ): Promise<string> {
    if (entryId === undefined) return "";
    try {
      const entry = await runtime.session.getEntry(entryId, BACKGROUND_CONTEXT);
      if (entry?.type === "compaction") return entry.summary.slice(0, 200);
    } catch {
      // 摘要读取失败不影响压缩结果展示
      return "";
    }
    return "";
  }

  async function touchSession(runtime: SessionRuntime): Promise<void> {
    try {
      const stats = await runtime.session.getStats(BACKGROUND_CONTEXT);
      await deps.sessionStore.touch(runtime.sessionId, { messageCount: stats.messageCount });
    } catch (error) {
      console.warn(`更新会话统计失败 ${runtime.sessionId}：${toErrorText(error)}`);
    }
  }

  /**
   * 条目落盘：把 pi 的 entryId / parentId 配回对应的那条助手消息。
   *
   * 渲染层的「分支」入口要求消息带 entryId（主进程按条目 id 复制会话），
   * 而流式产生的消息一出生是没有的 —— 只有历史回读的消息才自带。
   * 按 FIFO 配对：一次运行里的多轮工具调用会交替产生多条助手消息与多个条目。
   */
  function handleEntryAdded(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "entry_added" }>,
  ): void {
    const paired = pairEntryWithMessage(runtime.pendingEntries, event.entry);
    if (paired === null) return;
    emitSafe({
      type: "message-updated",
      messageId: paired.messageId,
      patch: paired.patch,
    });
  }

  function registerEvents(runtime: SessionRuntime): void {
    subscribe(runtime, "message_start", (event) => handleMessageStart(runtime, event));
    subscribe(runtime, "message_update", (event) => handleMessageUpdate(runtime, event));
    subscribe(runtime, "message_end", (event) => handleMessageEnd(runtime, event));
    subscribe(runtime, "entry_added", (event) => handleEntryAdded(runtime, event));
    subscribe(runtime, "tool_start", (event) => handleToolStart(runtime, event));
    subscribe(runtime, "tool_end", (event) => handleToolEnd(runtime, event));
    subscribe(runtime, "run_end", (event) => handleRunEnd(runtime, event));
    subscribe(runtime, "usage", (event) => handleUsage(runtime, event));
    subscribe(runtime, "queue_update", (event) => handleQueueUpdate(runtime, event));
    subscribe(runtime, "compaction_start", () => emitSafe({ type: "compaction-started" }));
    subscribe(runtime, "compaction_end", async (event) => {
      const preview =
        event.status === "completed" ? await compactionPreview(runtime, event.entryId) : "";
      emitSafe({ type: "compaction-ended", summaryPreview: preview });
    });
  }

  /** 权限门：根据设置与风险评估决定放行、审批或阻断 */
  async function gateTool(
    runtime: SessionRuntime,
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolPermissionResult | undefined> {
    const settings = await deps.getSettings();
    if (settings.permissionMode === "full") return undefined;

    const risk = assessToolRisk(toolName, args);
    if (risk === "low") return undefined;

    // 「始终允许」规则优先于审批；default 与 ai_review 模式均生效
    const argsText = safeStringify(args);
    if (await runtime.rules.matches(toolName, argsText)) return undefined;

    const ref = runtime.toolParts.get(toolCallId);
    if (ref) {
      ref.part.status = "pending-approval";
      emitSafe({
        type: "part-upsert",
        messageId: ref.messageId,
        partIndex: ref.partIndex,
        part: ref.part,
      });
    }

    const decision = await deps.approvals.request({
      sessionId: runtime.sessionId,
      toolCallId,
      toolName,
      argsText,
      risk,
    });
    if (decision === "deny") {
      if (ref) {
        ref.part.status = "denied";
        emitSafe({
          type: "part-upsert",
          messageId: ref.messageId,
          partIndex: ref.partIndex,
          part: ref.part,
        });
      }
      return { block: { reason: "用户拒绝了该操作" } };
    }
    if (decision === "always_allow") {
      const pattern = deriveRulePattern(toolName, args);
      await runtime.rules.add({
        toolName,
        ...(pattern === undefined ? {} : { pattern }),
        createdAt: Date.now(),
      });
    }
    return undefined;
  }

  async function createRuntime(sessionId: string): Promise<SessionRuntime> {
    const opened = await deps.sessionStore.open(sessionId);
    if (!opened) throw new Error(`无法打开会话：${sessionId}`);

    const settings = await deps.getSettings();
    const cwd = await deps.resolveWorkingDir(sessionId);
    const env = await createExecEnv({ cwd, allowedRoots: [cwd, dataDir()] });

    const { models } = buildProviders(settings);
    const model = resolveModel(settings, settings.defaultModel);
    if (!model || models.getProviders().length === 0) {
      throw new Error("请先在设置中配置模型服务");
    }

    const created = await AgentHarness.create(
      {
        session: opened.session,
        models,
        model,
        systemPrompt: await buildSystemPrompt(settings, cwd),
        tools: buildTools(),
        toolContext: { env },
        thinkingLevel: settings.thinkingLevel,
        compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 40_000 },
      },
      BACKGROUND_CONTEXT,
    );
    if (created.open.length > 0) {
      console.warn(`会话 ${sessionId} 存在 ${created.open.length} 个未完成操作，已跳过自动恢复`);
    }
    const lane = await created.harness.lane("main", BACKGROUND_CONTEXT);

    const runtime: SessionRuntime = {
      sessionId,
      session: opened.session,
      harness: created.harness,
      lane,
      env,
      rules: getRuleStore(),
      running: false,
      runEnded: false,
      pendingEntries: [],
      toolParts: new Map(),
      queue: [],
      unsubscribers: [],
    };

    runtime.unsubscribers.push(
      created.harness.hooks.on("before_tool", async (event) => {
        try {
          return await gateTool(runtime, event.toolName, event.toolCallId, event.args);
        } catch (error) {
          // 任何异常都按安全侧默认拒绝
          console.warn(`工具权限校验失败（${event.toolName}）：${toErrorText(error)}`);
          return { block: { reason: "权限校验失败，已拒绝该操作" } };
        }
      }),
    );
    registerEvents(runtime);
    return runtime;
  }

  function ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const cached = runtimes.get(sessionId);
    if (cached) return Promise.resolve(cached);
    const creating = creations.get(sessionId);
    if (creating) return creating;
    const promise = (async () => {
      try {
        const runtime = await createRuntime(sessionId);
        runtimes.set(sessionId, runtime);
        return runtime;
      } finally {
        creations.delete(sessionId);
      }
    })();
    creations.set(sessionId, promise);
    return promise;
  }

  /** prompt 异常/失败时收尾：错误消息 + run-ended，保证 UI 不会一直转圈 */
  function emitRunFailure(runtime: SessionRuntime, runId: string, cause: unknown): void {
    if (runtime.runEnded) return;
    const text = toErrorText(cause);
    const stream = runtime.stream;
    if (stream) {
      emitSafe({
        type: "message-updated",
        messageId: stream.messageId,
        patch: { status: "error", error: text },
      });
      runtime.lastAssistantMessageId = stream.messageId;
      runtime.stream = undefined;
    } else {
      emitSafe({
        type: "message-added",
        message: {
          id: randomUUID(),
          role: "assistant",
          createdAt: Date.now(),
          parts: [],
          status: "error",
          error: text,
        },
      });
    }
    emitSafe({ type: "run-ended", runId, reason: "failed" });
  }

  async function send(
    sessionId: string,
    text: string,
    images?: ImageContent[],
    messageId?: string,
    options?: ChatSendOptions,
  ): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    // 运行中再 send 等价于 followUp 排队
    if (runtime.running) {
      await queue(sessionId, text, "followUp");
      return;
    }

    runtime.running = true;
    runtime.runEnded = false;
    // 上一次运行若因异常没能收到全部 entry_added，队列里会留下过期项：新一次运行先清空
    runtime.pendingEntries = [];
    // 记录渲染层乐观消息 id：主进程回显同一条用户消息时复用，避免 UI 出现两条
    runtime.pendingUserMessageId = messageId;
    const runId = randomUUID();
    runtime.runId = runId;
    emitSafe({ type: "run-started", runId });
    try {
      const rewound = options?.rewindToEntryId;
      if (rewound !== undefined) {
        // 编辑：先把 tip 退回该用户消息的**父**条目，下面再把 text 作为新用户消息发出。
        // 目标已经是 tip 时跳过导航：pi 对「导航到当前 tip」直接报
        // "Navigation target must differ from the current tip"。
        // tip 读不到时按「未知」处理，照常尝试导航，由 pi 给真实错误。
        const tip = await currentTip(runtime);
        if (!tip.known || tip.tipId !== rewound) {
          const nav = await runtime.lane.navigateTree(rewound, undefined, BACKGROUND_CONTEXT);
          if (!nav.ok) {
            emitRunFailure(runtime, runId, nav.error);
            return;
          }
        }
      }
      /**
       * 必须带上要追加的消息。
       *
       * 不能靠「回退 + 空 prompt 沿用已有用户消息」来省掉这次重发：pi 的 `acceptRun` 在
       * 「prompt 为空且无图片」时确实不追加消息，但紧接着就以
       * `InvalidMessage{reason:"empty"}`（"Acceptance must append at least one message"）拒收。
       * 所以 `text` 一律原样传下去。
       */
      const result = await runtime.lane.prompt(text, images, BACKGROUND_CONTEXT);
      if (!result.ok) emitRunFailure(runtime, runId, result.error);
    } catch (error) {
      emitRunFailure(runtime, runId, error);
    } finally {
      // 无论正常结束还是异常退出，都回收运行态并清空排队展示
      runtime.running = false;
      runtime.runId = undefined;
      runtime.queue = [];
      runtime.pendingUserMessageId = undefined;
      emitSafe({ type: "queue-updated", items: [] });
    }
  }

  async function stop(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    deps.approvals.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe({ type: "queue-updated", items: [] });
    try {
      const result = await runtime.lane.abort(BACKGROUND_CONTEXT);
      if (!result.ok) runtime.running = false;
    } catch (error) {
      runtime.running = false;
      console.warn(`停止运行失败 ${sessionId}：${toErrorText(error)}`);
    }
  }

  async function queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    // 空闲时直接按发送处理，避免消息无声挂起
    if (!runtime.running) {
      await send(sessionId, text);
      return;
    }
    const item: QueuedMessage = { id: randomUUID(), text, mode };
    runtime.queue = [...runtime.queue, item];
    emitSafe({ type: "queue-updated", items: [...runtime.queue] });
    try {
      const result =
        mode === "steer"
          ? await runtime.lane.steer(text, undefined, BACKGROUND_CONTEXT)
          : await runtime.lane.followUp(text, undefined, BACKGROUND_CONTEXT);
      if (!result.ok) throw new Error(`消息入队失败：${toErrorText(result.error)}`);
      // 已交给 lane：移除本地占位项，真实队列由 queue_update 事件同步
      runtime.queue = runtime.queue.filter((queued) => queued.id !== item.id);
      emitSafe({ type: "queue-updated", items: [...runtime.queue] });
    } catch (error) {
      runtime.queue = runtime.queue.filter((queued) => queued.id !== item.id);
      emitSafe({ type: "queue-updated", items: [...runtime.queue] });
      throw error;
    }
  }

  async function compact(sessionId: string, instructions?: string): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    const options =
      instructions === undefined || instructions === ""
        ? undefined
        : { customInstructions: instructions };
    const result = await runtime.lane.compact(options, BACKGROUND_CONTEXT);
    if (!result.ok) throw new Error(`压缩上下文失败：${toErrorText(result.error)}`);
  }

  function isRunning(sessionId: string): boolean {
    return runtimes.get(sessionId)?.running ?? false;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtimes.delete(sessionId);
    deps.approvals.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe({ type: "queue-updated", items: [] });
    for (const unsubscribe of runtime.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`取消事件订阅失败 ${sessionId}：${toErrorText(error)}`);
      }
    }
    try {
      await runtime.harness.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭 Agent 运行时失败 ${sessionId}：${toErrorText(error)}`);
    }
    try {
      await runtime.session.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭会话失败 ${sessionId}：${toErrorText(error)}`);
    }
  }

  async function dispose(): Promise<void> {
    await Promise.allSettled([...creations.values()]);
    for (const sessionId of [...runtimes.keys()]) {
      try {
        await closeSession(sessionId);
      } catch (error) {
        console.warn(`释放会话运行时失败 ${sessionId}：${toErrorText(error)}`);
      }
    }
    if (defaultRuntime === api) defaultRuntime = null;
  }

  const api: ChatRuntime = {
    send,
    stop,
    queue,
    compact,
    isRunning,
    closeSession,
    dispose,
  };
  defaultRuntime = api;
  return api;
}
