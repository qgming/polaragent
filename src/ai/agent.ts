// Agent 运行时 —— 基于 @earendil-works/pi-agent-core 的 AgentHarness
// src/ai/agent.ts
//
// 每个对话线程一个 AgentHarness（绑定该线程的 pi Session）。这里用
// harness.prompt() 驱动多轮工具调用，把：
//   - 流式 text_delta 与有序 parts 经 rAF 合批后回传 onStreamUpdate
//     （每帧最多一次写 store，避免高频 token 把主线程打满）
//   - tool_start / tool_update / tool_end 事件聚合为工具调用片段
//   - run_end 时从累积的 AssistantMessage.content 有序 block 提取 parts
//     （text/thinking/tool 顺序），合并工具结果摘要，回传 onDone 持久化
// 历史上下文由 pi Session 原生管理，无需手动注入。

import { agentManager } from "./agent-manager";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import {
  BACKGROUND_CONTEXT,
  type AgentMessage,
  type HarnessEvent,
} from "@earendil-works/pi-agent-core";
import {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  estimateContextTokens,
  shouldCompact,
} from "@/lib/session/compaction";
import { toolDisplayName } from "./tools";
import { initializeAiRuntime } from "@/lib/app-init";
import { readBase64File, readFile } from "@/lib/electron/electron-api";
import { appendGuidanceMessage } from "@/lib/session/personal";
import type { ChatAttachment, ChatMessagePart, ToolResultSummary } from "@/lib/chat";
import { extractMessageParts } from "@/lib/chat";
import type { ToolPermissionMode } from "@/types/permissions";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { RETRY_DELAYS, MAX_RETRIES, sleep } from "./retry";

export interface AgentResult {
  content: ChatMessagePart[];
  model: string;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  // 当前上下文大小（最后一轮的 input，用于上下文压缩判断）
  contextTokens: number;
  providerCacheHit?: boolean;
}

export interface AgentHandlers {
  // 流式合批更新：每帧最多一次，携带本帧最新有序 parts（完整快照，非增量）
  onStreamUpdate: (update: { parts?: ChatMessagePart[] }) => void;
  onDone: (result: AgentResult) => void;
  onError: (message: string) => void;
  // 重试回调：attempt 从 1 开始
  onRetry?: (attempt: number) => void;
}

export interface PromptOptions {
  threadId: string;
  workingDir?: string;
  // 当前这轮 assistant 消息 id，用于把工具步骤轨迹归属到该条消息
  messageId?: string;
  // 输入框 "@" 选中的文件绝对路径。发送时读取其内容拼到发送内容里（后台注入），
  // 不进入 UI 显示——UI 只展示用户原始问题与文件 chip 标记。
  filePaths?: string[];
  attachments?: ChatAttachment[];
  permissionMode?: ToolPermissionMode;
}

/**
 * 把「选中文件的内容 + 图片附件占位 + 用户问题」拼成发给模型的实际输入。
 * 文件块为 <file path="…">…全文…</file>，末尾接用户问题。
 * 文件内容在发送时才读取（reads-on-send），保证拿到最新内容、避免选中即占内存。
 * 无任何注入时原样返回用户输入。
 */
async function buildModelInput(
  input: string,
  filePaths?: string[],
  imageAttachments?: ChatAttachment[],
): Promise<string> {
  const blocks: string[] = [];

  for (const path of filePaths ?? []) {
    try {
      const content = await readFile(path);
      const name = path.split(/[\\/]/).pop() || path;
      blocks.push(
        `<file path="${path}" name="${name}">\n${content}\n</file>`,
      );
    } catch (error) {
      console.error(`读取附件文件失败，已跳过: ${path}`, error);
    }
  }

  for (const attachment of imageAttachments ?? []) {
    blocks.push(
      `<image path="${attachment.path}" name="${attachment.name}">图片附件已随本消息以多模态内容发送。</image>`,
    );
  }

  if (blocks.length === 0) return input;
  return `${blocks.join("\n\n")}\n\n${input}`;
}

function imageMimeType(path: string): string {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}

async function buildImageInputs(attachments?: ChatAttachment[]): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "image") continue;
    try {
      images.push({
        type: "image",
        data: await readBase64File(attachment.path),
        mimeType: imageMimeType(attachment.path),
      });
    } catch (error) {
      console.error(`读取图片附件失败，已跳过: ${attachment.path}`, error);
    }
  }
  return images;
}

// 思考级别：支持 0.80 新增的 xhigh 档位（部分模型支持）
// 钳位由 clampThinkingLevel 在调用处完成，确保不向模型发送不支持的级别
function selectThinkingLevel(input: string): ModelThinkingLevel {
  const wordCount = input.split(/\s+/).length;
  const hasCode = /```|`\w+`/.test(input);
  const hasComplexQuery = /如何|怎么|为什么|设计|实现|优化|架构/.test(input);
  const hasMultiStepReasoning = /步骤|流程|方案|对比|分析|评估|排查|调试|重构|迁移/.test(input);
  const hasLongOutput = /文档|报告|总结|生成.*完整|写.*全部/.test(input);

  if (wordCount < 10 && !hasCode && !hasComplexQuery) return "minimal";
  if (wordCount < 30 && !hasComplexQuery) return "low";
  if (wordCount < 100 || hasCode) return "medium";
  // 超长输入 + 多步推理/架构设计/复杂对比 → xhigh（部分模型支持，clampThinkingLevel 会自动降级）
  if (wordCount > 300 && (hasMultiStepReasoning || hasLongOutput)) return "xhigh";
  return "high";
}

/** rAF 合批器：流式 token 高频到达时按帧合并更新，避免每 token 一次写 store */
function createRafBatcher(handler: (update: { parts?: ChatMessagePart[] }) => void) {
  let pendingParts: ChatMessagePart[] | null = null;
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (pendingParts) {
      handler({ parts: pendingParts });
      pendingParts = null;
    }
  };

  const schedule = () => {
    if (rafId !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(flush);
    } else {
      rafId = setTimeout(flush, 16) as unknown as number;
    }
  };

  const cancel = () => {
    if (rafId === null) return;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    } else {
      clearTimeout(rafId);
    }
    rafId = null;
  };

  return {
    pushParts: (parts: ChatMessagePart[]) => { pendingParts = parts; schedule(); },
    reset: () => { pendingParts = null; },
    cancel,
    flush,
  };
}

/**
 * 用选定的 Agent 发送一条消息（含历史上下文与真实工具）。
 */
export async function promptAgent(
  input: string,
  handlers: AgentHandlers,
  options: PromptOptions,
) {
  let settled = false;
  // Provider 响应缓存命中标记（由 after_provider_response 事件填充）
  let providerCacheHit = false;
  // 收集本轮工具结果摘要：toolCallId -> label/status/result/details
  const toolResults = new Map<string, ToolResultSummary>();

  // —— rAF 合批：流式 token 高频到达，若每个 token 都写 store 会把主线程打满
  // （多会话并行时尤甚）。这里用 createRafBatcher 按帧合并：缓存最新 parts，
  // 每帧最多 flush 一次，把「每 token 一次」的更新降到「每帧一次」。
  const batcher = createRafBatcher(handlers.onStreamUpdate);

  try {
    let harness: AgentHarness;
    try {
      harness = await agentManager.getOrCreateHarness(options.threadId, {
        workingDir: options.workingDir,
        permissionMode: options.permissionMode,
      });
    } catch (error) {
      // 运行时未初始化时兜底重建一次
      initializeAiRuntime();
      harness = await agentManager.getOrCreateHarness(options.threadId, {
        workingDir: options.workingDir,
        permissionMode: options.permissionMode,
      });
    }

    const runtimeModelId = agentManager.getRuntimeModelId();
    // 本次 run 内按真实顺序产生的可渲染过程：assistant 轮次 + 中途引导状态。
    // 必须聚合全部轮次，否则只取最后一条会丢掉前面轮次已输出的正文/思考。
    const runItems: Array<
      | { type: "assistant"; message: AgentMessage & { role: "assistant" } }
      | { type: "guidance"; text: string; createdAt: number }
    > = [];
    // 当前正在进行的轮次的 partial assistant 消息（尚未 turn_end）。
    let livePartial: (AgentMessage & { role: "assistant" }) | null = null;

    // 把「已完成轮次 + 当前 partial」聚合为有序 parts，缓存等待按帧 flush。
    // partial 与已完成轮次不重叠：turn_end 时把 partial 落入 runMessages 并清空。
    const emitParts = () => {
      const parts: ChatMessagePart[] = [];
      for (const item of runItems) {
        if (item.type === "assistant") {
          parts.push(...extractMessageParts(item.message, toolResults));
        } else {
          parts.push({
            type: "data-polar-guidance",
            data: { text: item.text, createdAt: item.createdAt },
          });
        }
      }
      if (livePartial) {
        parts.push(...extractMessageParts(livePartial, toolResults));
      }
      if (parts.length > 0) {
        batcher.pushParts(parts);
      }
    };

    // 把 "@" 选中文件的内容 + 图片附件占位拼到用户问题前一起发给模型（后台注入），
    // UI 显示的仍是用户原始问题（startExchange 时已用纯文本建消息）。
    const modelInput = await buildModelInput(
      input,
      options.filePaths,
      options.attachments?.filter((attachment) => attachment.kind === "image"),
    );

    // 记录发送给 AI 的内容组成
    const fileCount = options.filePaths?.length ?? 0;
    const imageCount = options.attachments?.filter((a) => a.kind === "image").length ?? 0;
    console.log(
      `[AI输入] 会话 ${options.threadId} 内容组成:`,
      {
        用户输入: input.length,
        文件数: fileCount,
        文件: options.filePaths,
        图片数: imageCount,
        总长度: modelInput.length,
      },
    );

    // 动态调整 thinking level：先按输入复杂度选档，再用 clampThinkingLevel 钳位到模型实际支持的范围
    // 0.85.0: 单会话操作已迁至 AgentLane（harness.lane("main", ctx)）
    const lane = await harness.lane("main", BACKGROUND_CONTEXT);
    const rawThinkingLevel = selectThinkingLevel(modelInput);
    // 0.84.4: getModel() 为异步方法；0.85.0 位于 AgentLane 且可能返回 undefined
    const model = await lane.getModel(BACKGROUND_CONTEXT);
    const thinkingLevel = model ? clampThinkingLevel(model, rawThinkingLevel) : rawThinkingLevel;
    await lane.setThinkingLevel(thinkingLevel, BACKGROUND_CONTEXT);

    const imageInputs = await buildImageInputs(options.attachments);

    // 0.84.4: before_provider_payload / after_provider_response 事件已移除，
    // 改用 harness.hooks 上的 before_payload / after_response 钩子（harness 级，注册一次）。
    // 钩子载荷类型为 unknown，以下均做防御性提取；取不到字段时退化为不记录/不判定。

    // LLM 请求元信息计数：只记录消息数/工具数/系统提示词长度，不打印 payload 本体
    // （避免 console 长期持有引用阻碍 GC，以及泄漏会话内容与系统提示词）。
    harness.hooks.on("before_payload", (event) => {
      const record = (event ?? {}) as Record<string, unknown>;
      const payload = (record.payload ?? record) as Record<string, unknown>;
      const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
      const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
      const system = typeof payload.system === "string" ? payload.system : undefined;
      console.log(
        `[AI请求] 会话 ${options.threadId} LLM 请求: 消息数=${messages?.length ?? 0} 工具数=${tools?.length ?? 0} 系统提示词长度=${system?.length ?? 0}`,
      );
      return undefined;
    });

    // Provider 响应缓存命中检测：响应头可能含缓存相关字段，取到则记录，
    // 供 agent_end 时附加到结果；取不到时保持 providerCacheHit=false。
    harness.hooks.on("after_response", (event) => {
      const record = (event ?? {}) as Record<string, unknown>;
      const headers =
        (record.headers && typeof record.headers === "object"
          ? (record.headers as Record<string, unknown>)
          : undefined) ??
        (record.response && typeof record.response === "object"
          ? ((record.response as Record<string, unknown>).headers as Record<string, unknown> | undefined)
          : undefined);
      if (headers) {
        const cacheHeader =
          headers["x-cache"] ??
          headers["cf-cache-status"] ??
          headers["anthropic-cache-hit"];
        if (cacheHeader) {
          providerCacheHit = String(cacheHeader).toLowerCase().includes("hit");
        }
      }
      return undefined;
    });

    // --- 重试循环 ---
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // 每次重试前清空累积状态
      runItems.length = 0;
      livePartial = null;
      toolResults.clear();
      batcher.reset();
      settled = false;
      providerCacheHit = false;

      // 每次 attempt 独立的 AbortController，用于取消旧 events 监听回调中的异步操作
      const attemptController = new AbortController();

      // 0.84.4: harness.subscribe 已移除，改为 harness.events.on(type, listener) 按事件类型订阅。
      // 0.85.0: 事件类型重命名（tool_execution_* → tool_*、agent_end → run_end），
      // 监听器签名变为 (event, context)，事件载荷携带 lane/runId 字段。
      const unsubscribers: Array<() => void> = [];
      // 简化引导识别：每次 run 的首条 user 消息视为原始输入，其后的 user 消息视为引导消息
      let sawInitialUserMessage = false;

      unsubscribers.push(
        harness.events.on("message_start", async (event) => {
          const messageEvent = event as Extract<HarnessEvent, { type: "message_start" }>;
          // 0.84.4: queue_update 事件已移除，无法再跟踪引导队列状态。简化近似：
          // 首条 user 消息为原始输入，其后的 user 消息（steering/followUp/nextRun 注入）
          // 一律视为引导消息，持久化并展示为 guidance 段。
          if (messageEvent.message.role === "user") {
            if (!sawInitialUserMessage) {
              sawInitialUserMessage = true;
              return;
            }
            const text = agentUserMessageText(messageEvent.message);
            if (text.trim() && !attemptController.signal.aborted) {
              await persistGuidance(options, text);
            }
            runItems.push({
              type: "guidance",
              text,
              createdAt: Date.now(),
            });
            emitParts();
          }
        }),
      );

      unsubscribers.push(
        harness.events.on("message_update", (event) => {
          const messageEvent = event as Extract<HarnessEvent, { type: "message_update" }>;
          // 更新当前轮次的 partial，并实时重建 parts（思考/工具/正文有序）。
          // 思考增量(thinking_delta)无需单独累积——partial.content 已含有序 block。
          if (messageEvent.message.role === "assistant") {
            livePartial = messageEvent.message as AgentMessage & { role: "assistant" };
            emitParts();
          }
        }),
      );

      unsubscribers.push(
        harness.events.on("turn_end", (event) => {
          const turnEvent = event as Extract<HarnessEvent, { type: "turn_end" }>;
          // 每轮结束收集该轮的 assistant 消息（仅本次 run 新增，不含历史）
          if (turnEvent.message.role === "assistant") {
            runItems.push({
              type: "assistant",
              message: turnEvent.message as AgentMessage & { role: "assistant" },
            });
          }
          // 该轮已落地，清空 partial，避免与 runMessages 重复计入
          livePartial = null;
          emitParts();
        }),
      );

      unsubscribers.push(
        harness.events.on("tool_update", (event) => {
          const toolEvent = event as Extract<HarnessEvent, { type: "tool_update" }>;
          // 工具执行中间进度：partialResult 含中间结果，回填到 tool-call 展示文本
          const partialLabel = summarizePartialResult(toolEvent.toolName, toolEvent.partialResult);
          if (partialLabel) {
            toolResults.set(toolEvent.toolCallId, {
              label: partialLabel,
              isError: false,
              pending: true,
              details: extractToolDetails(toolEvent.partialResult),
            });
            emitParts();
          }
        }),
      );

      unsubscribers.push(
        harness.events.on("tool_end", (event) => {
          const toolEvent = event as Extract<HarnessEvent, { type: "tool_end" }>;
          const label = summarizeToolResult(toolEvent.toolName, toolEvent.result, toolEvent.isError);
          const resultDetails = extractToolDetails(toolEvent.result);
          toolResults.set(toolEvent.toolCallId, {
            label,
            isError: toolEvent.isError,
            resultText: toolResultText(toolEvent.result),
            details: resultDetails,
          });
          // 工具结果到位后，已渲染的工具段标签/状态需要刷新
          emitParts();
        }),
      );

      unsubscribers.push(
        harness.events.on("run_end", () => {
          settled = true;
          batcher.cancel();
          batcher.reset();

          // 0.85.0: run_end 不再携带 messages 字段，assistant 消息全部来自
          // 本 run 期间累积的 runItems（turn_end 已逐轮收集）。
          let assistants = runItems
            .filter(
              (item): item is Extract<(typeof runItems)[number], { type: "assistant" }> =>
                item.type === "assistant",
            )
            .map((item) => item.message);

          const lastAssistant = assistants[assistants.length - 1];
          if (lastAssistant?.stopReason === "error") {
            handlers.onError(lastAssistant.errorMessage ?? "响应已中断");
            return;
          }

          const result = buildAgentEndResult(
            runItems, runtimeModelId, toolResults, providerCacheHit,
          );
          if (result) handlers.onDone(result);
        }),
      );

      const unsubscribe = () => {
        for (const unsub of unsubscribers) unsub();
      };

      try {
        // 0.84.4: prompt 签名改为 (text, images?) 或 (message | message[])
        // 0.85.0: prompt 位于 AgentLane，需传 context
        if (imageInputs.length > 0) {
          await lane.prompt(modelInput || "请查看这些图片。", imageInputs, BACKGROUND_CONTEXT);
        } else {
          await lane.prompt(modelInput, undefined, BACKGROUND_CONTEXT);
        }
        await lane.waitForIdle(BACKGROUND_CONTEXT);

        // 检查是否需要自动压缩上下文
        try {
          // 通过最后一次 assistant 消息的 usage 估算当前上下文
          const lastAssistant = runItems
            .filter((item): item is Extract<(typeof runItems)[number], { type: "assistant" }> => item.type === "assistant")
            .map((item) => item.message)
            .pop();

          if (lastAssistant?.usage) {
            // 0.84.4: getModel() 为异步方法；0.85.0 位于 AgentLane 且可能返回 undefined
            const model = await lane.getModel(BACKGROUND_CONTEXT);
            const contextWindow = model?.contextWindow ?? 128000;
            // 官方口径 calculateContextTokens = totalTokens || input+output+cacheRead+cacheWrite。
            // 必须包含 cacheWrite：prompt caching 首写/过期轮的上下文几乎全部计入 cacheWrite，
            // 漏算会导致该压缩时不压缩，下一轮请求直接超出模型窗口。
            const estimatedContext = calculateContextTokens(lastAssistant.usage);

            if (shouldCompact(estimatedContext, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
              console.log(
                `[压缩] 会话 ${options.threadId} 触发自动压缩: ${estimatedContext} tokens (窗口 ${contextWindow})`,
              );
              await lane.compact(undefined, BACKGROUND_CONTEXT);
            }
          }
        } catch (error) {
          console.warn("[压缩] 自动压缩检查失败:", error);
        }

        attemptController.abort(); // 取消旧回调中可能残留的异步操作
        unsubscribe();
        batcher.cancel();
        break; // 成功，退出重试循环
      } catch (error) {
        attemptController.abort(); // 取消旧回调中可能残留的异步操作
        unsubscribe();
        batcher.cancel();

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt];
          console.warn(
            `Agent调用失败，${delay}ms 后重试 (${attempt + 1}/${MAX_RETRIES}):`,
            error instanceof Error ? error.message : String(error),
          );
          await sleep(delay);
          // 通知 UI 更新重试状态
          handlers.onRetry?.(attempt + 1);
          continue;
        }

        // 已耗尽重试次数
        if (!settled) {
          // 0.84.4: AgentHarnessError 已移除，统一按普通 Error 处理
          handlers.onError(error instanceof Error ? error.message : String(error));
        }
        break;
      }
    }
  } catch (error) {
    batcher.cancel();
    if (!settled) {
      // 0.84.4: AgentHarnessError 已移除，统一按普通 Error 处理
      handlers.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

async function persistGuidance(options: PromptOptions, text: string): Promise<void> {
  await appendGuidanceMessage(options.threadId, text);
}

/** 构建 run_end 事件的最终 AgentResult（0.85.0: run_end 不再携带 messages，全部取自 runItems） */
function buildAgentEndResult(
  runItems: Array<
    | { type: "assistant"; message: AgentMessage & { role: "assistant" } }
    | { type: "guidance"; text: string; createdAt: number }
  >,
  runtimeModelId: string,
  toolResults: Map<string, ToolResultSummary>,
  providerCacheHit: boolean,
): AgentResult | null {
  // 从 runItems 中提取 assistant 消息
  const assistants = runItems
    .filter(
      (item): item is Extract<(typeof runItems)[number], { type: "assistant" }> =>
        item.type === "assistant",
    )
    .map((item) => item.message);

  if (assistants.length === 0) {
    return {
      content: [],
      model: runtimeModelId,
      usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
    };
  }

  // 聚合所有轮次的 parts，保持轮次与块的真实顺序
  const parts: ChatMessagePart[] = [];
  for (const item of runItems) {
    if (item.type === "assistant") {
      parts.push(...extractMessageParts(item.message, toolResults));
    } else {
      parts.push({
        type: "data-polar-guidance",
        data: { text: item.text, createdAt: item.createdAt },
      });
    }
  }

  const lastAssistant = assistants[assistants.length - 1];

  // 累加所有 assistant 轮次的 usage（input/output/cacheRead/cacheWrite）
  // 多轮工具调用中，每轮都有独立的 usage
  // Anthropic API: input = 新增输入, cacheRead = 缓存读取, 两者独立
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let finalTotalTokens = 0;
  for (const assistant of assistants) {
    totalInput += assistant.usage?.input ?? 0;
    totalOutput += assistant.usage?.output ?? 0;
    totalCacheRead += assistant.usage?.cacheRead ?? 0;
    totalCacheWrite += assistant.usage?.cacheWrite ?? 0;
    // 每轮总量用官方口径（totalTokens || 四字段和），与会话重载路径（message-parser）保持一致
    finalTotalTokens += assistant.usage ? calculateContextTokens(assistant.usage) : 0;
  }
  // 使用 estimateContextTokens 计算真实的当前上下文大小
  // 0.85.0: run_end 不再携带全部消息，这里用本 run 累积的 assistant 消息近似估算
  const allMessages = assistants as AgentMessage[];
  const contextTokens = estimateContextTokens(allMessages).tokens;

  return {
    content: parts,
    model: lastAssistant.model?.trim() || runtimeModelId,
    usage: {
      input: totalInput,
      output: totalOutput,
      totalTokens: finalTotalTokens,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
    contextTokens,
    providerCacheHit,
  };
}

function agentUserMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// 从工具结果中提取 details 对象
function extractToolDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: Record<string, unknown> }).details;
  return details && typeof details === "object" ? details : undefined;
}

// 工具中间进度 -> 单行摘要（tool_update 事件用）
function summarizePartialResult(toolName: string, partial: unknown): string | undefined {
  void toolName;
  if (!partial || typeof partial !== "object") return undefined;
  const details = (partial as { details?: Record<string, unknown> }).details;
  if (details) {
    if (typeof details.summary === "string" && details.summary.trim()) {
      return details.summary.trim();
    }
    // 其他工具的中间进度：如果有 content 文本，取前 60 字符
    const content = (partial as { content?: unknown[] }).content;
    if (Array.isArray(content)) {
      const firstText = content.find(
        (c): c is { type: "text"; text: string } =>
          c != null && typeof c === "object" && (c as { type?: string }).type === "text",
      );
      if (firstText) {
        const snippet = firstText.text.slice(0, 60);
        return snippet.length < firstText.text.length ? `${snippet}...` : snippet;
      }
    }
  }
  return undefined;
}

// 工具结果 -> 单行摘要。只覆盖 pisdk 原生四件套（bash/read/write/edit）。
function summarizeToolResult(toolName: string, result: unknown, isError = false): string {
  const base = toolDisplayName(toolName);
  if (result && typeof result === "object") {
    const details = (result as { details?: Record<string, unknown> }).details;
    if (details) {
      const suffix = formatDurationSuffix(details.durationMs);
      if (toolName === "bash" && typeof details.exitCode === "number") {
        return isError
          ? `命令执行失败（退出码 ${details.exitCode}）${suffix}`
          : `命令执行完成${suffix}`;
      }
      if (toolName === "write" && typeof details.path === "string") {
        return `已写入 ${String(details.path).split(/[\\/]/).pop()}${suffix}`;
      }
      if (toolName === "edit" && typeof details.path === "string") {
        return `已编辑 ${String(details.path).split(/[\\/]/).pop()}${suffix}`;
      }
      if (toolName === "read" && typeof details.path === "string") {
        return `已读取 ${String(details.path).split(/[\\/]/).pop()}${suffix}`;
      }
    }
  }
  return isError ? `${base}执行失败` : base;
}

function formatDurationSuffix(durationMs: unknown): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "";
  }
  if (durationMs < 1000) return `（${Math.round(durationMs)}ms）`;
  return `（${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s）`;
}

// 工具结果 -> 完整可读文本（供步骤项点击展开查看）
// 优先取面向模型的 content 文本，其次把 details 结构化对象 JSON 化
function toolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as {
    content?: unknown;
    details?: unknown;
  };

  // content 通常是 [{ type: "text", text }] 数组，拼接其文本
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  } else if (typeof record.content === "string" && record.content.trim()) {
    return record.content.trim();
  }

  // content 为空时：若 details 带有正文字段（如 markdown），优先展示正文，
  // 而非把整个 details 结构 JSON 化（那样只会看到元信息，看不到正文内容）。
  if (record.details && typeof record.details === "object") {
    const markdown = (record.details as { markdown?: unknown }).markdown;
    if (typeof markdown === "string" && markdown.trim()) {
      return markdown.trim();
    }
  }

  // 退而展示结构化 details
  if (record.details && typeof record.details === "object") {
    try {
      return JSON.stringify(record.details, null, 2);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** 中止指定线程的 Agent 运行（用户在该会话内主动点「停止」时调用）。
 *  仅影响该线程，其它并行会话继续在后台运行。 */
export function abortAgentThread(threadId: string) {
  agentManager.abortThread(threadId);
}

/** 中止当前所有 Agent 运行（极端清理场景，如重置运行时）。 */
export function abortAgent() {
  agentManager.abortAll();
}

/** 重置某个线程的 harness 会话状态 */
export function resetAgent(threadId: string) {
  agentManager.disposeThread(threadId);
}
