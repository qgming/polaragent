// Agent 运行时 —— 基于 @earendil-works/pi-agent-core 的 AgentHarness
// src/ai/agent.ts
//
// 每个对话线程一个 AgentHarness（绑定该线程的 pi Session）。这里用
// harness.prompt() 驱动多轮工具调用，把：
//   - 流式 text_delta 与有序 segments 经 rAF 合批后回传 onStreamUpdate
//     （每帧最多一次写 store，避免高频 token 把主线程打满）
//   - tool_execution_* 事件转发到「任务监控」面板（待办 / 产物 / 步骤轨迹）
//   - agent_end 时从最终 AssistantMessage.content 的有序 block 提取 segments
//     （text/thinking/tool 顺序），合并工具结果摘要，回传 onDone 持久化
// 历史上下文由 pi Session 原生管理，无需手动注入。

import { agentManager, type TeamContext } from "./agent-manager";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import { cancelAskUserRequestsForThread } from "./ask-user";
import { toolDisplayName } from "./tools";
import { formatSkillInvocationWithFiles } from "./tools/skills";
import { initializeAiRuntime } from "@/lib/app-init";
import { skillLoader } from "@/lib/skill";
import { readBase64File, readFile } from "@/lib/electron/electron-api";
import { appendGuidanceMessage } from "@/lib/session/personal";
import { appendTeamGuidanceMessage } from "@/lib/session/team";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import type { ChatAttachment, Segment } from "@/lib/chat";
import type { ToolPermissionMode } from "@/types/permissions";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentHarnessError,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";

export interface AgentResult {
  content: string;
  model: string;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
  };
  // 助手消息的有序过程结构（思考/工具/正文），用于渲染与持久化
  segments: Segment[];
  // Provider 缓存命中标记（0.80 after_provider_response 事件提取）
  providerCacheHit?: boolean;
}

export interface AgentHandlers {
  // 流式合批更新：每帧最多一次，携带本帧待追加文本与最新有序段
  onStreamUpdate: (update: { appendDelta?: string; segments?: Segment[] }) => void;
  onDone: (result: AgentResult) => void;
  onError: (message: string) => void;
}

export interface PromptOptions {
  threadId: string;
  workingDir?: string;
  // 当前这轮 assistant 消息 id，用于把工具步骤轨迹归属到该条消息
  messageId?: string;
  // 输入框 "/" 临时选中的技能 id。这些技能的 SKILL.md 全文会在后台拼到发送内容里
  // （方案 C），但不进入 UI 显示——UI 只展示用户原始问题与技能 chip 标记。
  skillIds?: string[];
  // 输入框 "@" 选中的文件绝对路径。发送时读取其内容拼到发送内容里（后台注入），
  // 同样不进入 UI 显示——UI 只展示用户原始问题与文件 chip 标记。
  filePaths?: string[];
  attachments?: ChatAttachment[];
  permissionMode?: ToolPermissionMode;
  // 当前会话选中的知识库 ID 列表
  knowledgeBaseIds?: string[];
  // 团队模式上下文：成员发言时叠加团队技能/系统提示词/身份前缀，并用团队会话仓库打开 session。
  teamContext?: TeamContext;
  // 项目级别的系统提示词（当对话属于某项目时注入）
  projectSystemPrompt?: string;
}

// 把「选中技能的全文与目录树 + 选中文件的内容 + 用户问题」拼成发给模型的实际输入（方案 C）。
// 技能块用 pi 的 formatSkillInvocation 生成 <skill>…全文…</skill>，
// 并追加 <skill_files> 目录树，方便模型知道 references/examples 等子文件路径。
// 文件块为 <file path="…">…全文…</file>，二者依次拼接，末尾接用户问题。
// 文件内容在发送时才读取（reads-on-send），保证拿到最新内容、避免选中即占内存。
// 无任何注入时原样返回用户输入。
async function buildModelInput(
  input: string,
  skillIds?: string[],
  filePaths?: string[],
  imageAttachments?: ChatAttachment[],
): Promise<string> {
  const blocks: string[] = [];

  // 1) 技能块：toPiSkills 仅返回启用且有 filePath 的技能；带 content（SKILL.md 全文）
  for (const id of skillIds ?? []) {
    const [skill] = skillLoader.toPiSkills([id]);
    if (skill) {
      blocks.push(await formatSkillInvocationWithFiles(skill));
    }
  }

  // 2) 文件块：发送时读取文件全文，读失败的文件跳过（不阻断发送）
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
function createRafBatcher(handler: (update: { appendDelta?: string; segments?: Segment[] }) => void) {
  let pendingDelta = "";
  let pendingSegments: Segment[] | null = null;
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (pendingDelta || pendingSegments) {
      handler({
        appendDelta: pendingDelta || undefined,
        segments: pendingSegments ?? undefined,
      });
      pendingDelta = "";
      pendingSegments = null;
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
    pushDelta: (delta: string) => { pendingDelta += delta; schedule(); },
    pushSegments: (segments: Segment[]) => { pendingSegments = segments; schedule(); },
    reset: () => { pendingDelta = ""; pendingSegments = null; },
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
  agentId: string,
  options: PromptOptions,
) {
  let settled = false;
  // Provider 响应缓存命中标记（由 after_provider_response 事件填充）
  let providerCacheHit = false;
  // 收集本轮工具结果摘要：toolCallId -> { label, isError, resultText, todos?, details? }
  const toolResults = new Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      todos?: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
      details?: Record<string, unknown>;
    }
  >();

  // —— rAF 合批：流式 token 高频到达，若每个 token 都写 store 会把主线程打满
  // （多会话并行时尤甚）。这里用 createRafBatcher 按帧合并：缓存待追加的文本与最新 segments，
  // 每帧最多 flush 一次，把「每 token 一次」的更新降到「每帧一次」。
  const batcher = createRafBatcher(handlers.onStreamUpdate);

  try {
    let harness: AgentHarness;
    try {
      harness = await agentManager.getOrCreateHarness(options.threadId, agentId, {
        workingDir: options.workingDir,
        permissionMode: options.permissionMode,
        knowledgeBaseIds: options.knowledgeBaseIds,
        teamContext: options.teamContext,
        projectSystemPrompt: options.projectSystemPrompt,
      });
    } catch (error) {
      // 运行时未初始化时兜底重建一次
      initializeAiRuntime();
      harness = await agentManager.getOrCreateHarness(options.threadId, agentId, {
        workingDir: options.workingDir,
        permissionMode: options.permissionMode,
        knowledgeBaseIds: options.knowledgeBaseIds,
        teamContext: options.teamContext,
        projectSystemPrompt: options.projectSystemPrompt,
      });
    }

    const runtimeModelId = agentManager.getRuntimeModelId(agentId);
    const monitor = useTaskMonitorStore.getState();
    let assistantText = "";
    // 本次 run 内按真实顺序产生的可渲染过程：assistant 轮次 + 中途引导状态。
    // 必须聚合全部轮次，否则只取最后一条会丢掉前面轮次已输出的正文/思考。
    const runItems: Array<
      | { type: "assistant"; message: AgentMessage & { role: "assistant" } }
      | { type: "guidance"; text: string; createdAt: number }
    > = [];
    // 当前正在进行的轮次的 partial assistant 消息（尚未 turn_end）。
    let livePartial: (AgentMessage & { role: "assistant" }) | null = null;
    let queuedGuidanceTexts: string[] = [];
    const consumedGuidanceTexts: string[] = [];

    // 把「已完成轮次 + 当前 partial」聚合为有序 segments，缓存等待按帧 flush。
    // partial 与已完成轮次不重叠：turn_end 时把 partial 落入 runMessages 并清空。
    const emitSegments = () => {
      const segments: Segment[] = [];
      for (const item of runItems) {
        if (item.type === "assistant") {
          segments.push(...extractSegments(item.message, toolResults));
        } else {
          segments.push({
            kind: "guidance",
            text: item.text,
            createdAt: item.createdAt,
          });
        }
      }
      if (livePartial) {
        segments.push(...extractSegments(livePartial, toolResults));
      }
      if (segments.length > 0) {
        batcher.pushSegments(segments);
      }
    };

    const unsubscribe = harness.subscribe(async (event) => {
      switch (event.type) {
        case "queue_update": {
          const nextQueued = event.steer.map((message) =>
            agentUserMessageText(message),
          );
          if (nextQueued.length < queuedGuidanceTexts.length) {
            consumedGuidanceTexts.push(
              ...queuedGuidanceTexts.slice(
                0,
                queuedGuidanceTexts.length - nextQueued.length,
              ),
            );
          }
          queuedGuidanceTexts = nextQueued;
          break;
        }

        case "message_start": {
          if (event.message.role === "user" && consumedGuidanceTexts.length > 0) {
            const text = consumedGuidanceTexts.shift() ?? agentUserMessageText(event.message);
            if (text.trim()) {
              await persistGuidance(options, text);
            }
            runItems.push({
              type: "guidance",
              text,
              createdAt: Date.now(),
            });
            emitSegments();
          }
          break;
        }

        case "message_update": {
          const inner = event.assistantMessageEvent;
          if (inner.type === "text_delta") {
            assistantText += inner.delta;
            // 缓存文本增量，按帧合并写入（不再每 token 调一次 onDelta）
            batcher.pushDelta(inner.delta);
          }
          // 更新当前轮次的 partial，并实时重建 segments（思考/工具/正文有序）。
          // 思考增量(thinking_delta)无需单独累积——partial.content 已含有序 block。
          if (event.message.role === "assistant") {
            livePartial = event.message as AgentMessage & { role: "assistant" };
            emitSegments();
          }
          break;
        }

        case "turn_end": {
          // 每轮结束收集该轮的 assistant 消息（仅本次 run 新增，不含历史）
          if (event.message.role === "assistant") {
            runItems.push({
              type: "assistant",
              message: event.message as AgentMessage & { role: "assistant" },
            });
          }
          // 该轮已落地，清空 partial，避免与 runMessages 重复计入
          livePartial = null;
          emitSegments();
          break;
        }

        case "tool_execution_start": {
          monitor.startStep(options.threadId, {
            id: event.toolCallId,
            toolName: event.toolName,
            messageId: options.messageId,
          });
          break;
        }

        case "tool_execution_update": {
          // 工具执行中间进度：partialResult 含中间结果，更新步骤面板的 label
          const partial = event.partialResult;
          const partialLabel = summarizePartialResult(event.toolName, partial);
          if (partialLabel) {
            monitor.updateStep(options.threadId, event.toolCallId, {
              label: partialLabel,
            });
          }
          break;
        }

        case "tool_execution_end": {
          const label = summarizeToolResult(event.toolName, event.result);
          const resultDetails = extractToolDetails(event.result);
          toolResults.set(event.toolCallId, {
            label,
            isError: event.isError,
            resultText: toolResultText(event.result),
            todos: extractTodos(event.toolName, event.result),
            details: resultDetails,
          });
          monitor.finishStep(options.threadId, event.toolCallId, {
            label,
            status: event.isError ? "error" : "done",
          });
          // 工具结果到位后，已渲染的工具段标签/状态需要刷新
          emitSegments();
          break;
        }

        case "agent_end": {
          settled = true;
          batcher.cancel();
          batcher.reset();

          // 从 runItems 提取最后一条 assistant 用于错误检测
          let assistants = runItems
            .filter(
              (item): item is Extract<(typeof runItems)[number], { type: "assistant" }> =>
                item.type === "assistant",
            )
            .map((item) => item.message);
          if (assistants.length === 0) {
            const last = [...event.messages]
              .reverse()
              .find((message) => message.role === "assistant");
            if (last && last.role === "assistant") {
              assistants = [last as AgentMessage & { role: "assistant" }];
            }
          }

          const lastAssistant = assistants[assistants.length - 1];
          if (lastAssistant?.stopReason === "error") {
            handlers.onError(lastAssistant.errorMessage ?? "响应已中断");
            return;
          }

          const result = buildAgentEndResult(
            event, runItems, assistantText, runtimeModelId, toolResults, providerCacheHit,
          );
          if (result) handlers.onDone(result);
          break;
        }

        case "after_provider_response": {
          // 提取缓存命中与延迟信息（0.80 新增事件）
          // 响应头中可能含缓存相关字段，记录供 agent_end 时附加到消息元信息
          const cacheHeader =
            event.headers["x-cache"] ??
            event.headers["cf-cache-status"] ??
            event.headers["anthropic-cache-hit"];
          if (cacheHeader) {
            providerCacheHit = String(cacheHeader).toLowerCase().includes("hit");
          }
          break;
        }
      }
    });

    // 方案 C：把选中技能的 SKILL.md 全文 + 选中文件的内容拼到用户问题前一起发给模型
    // （后台注入），UI 显示的仍是用户原始问题（startExchange 时已用纯文本建消息）。
    const modelInput = await buildModelInput(
      input,
      options.skillIds,
      options.filePaths,
      options.attachments?.filter((attachment) => attachment.kind === "image"),
    );

    // 动态调整 thinking level：先按输入复杂度选档，再用 clampThinkingLevel 钳位到模型实际支持的范围
    const rawThinkingLevel = selectThinkingLevel(modelInput);
    const model = harness.getModel();
    const thinkingLevel = clampThinkingLevel(model, rawThinkingLevel);
    await harness.setThinkingLevel(thinkingLevel);

    const imageInputs = await buildImageInputs(options.attachments);
    if (imageInputs.length > 0) {
      await harness.prompt(modelInput || "请查看这些图片。", {
        images: imageInputs,
      });
    } else {
      await harness.prompt(modelInput);
    }
    await harness.waitForIdle();
    unsubscribe();
    batcher.cancel();
  } catch (error) {
    batcher.cancel();
    if (!settled) {
      // 使用 0.80 结构化错误类型：AgentHarnessError 携带 code 字段
      if (error instanceof AgentHarnessError) {
        handlers.onError(`[AgentHarness:${error.code}] ${error.message}`);
      } else {
        handlers.onError(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

async function persistGuidance(options: PromptOptions, text: string): Promise<void> {
  const sessionId = options.teamContext?.sessionId ?? options.threadId;
  if (options.teamContext) {
    await appendTeamGuidanceMessage(sessionId, text);
  } else {
    await appendGuidanceMessage(sessionId, text);
  }
}

/** agent_end 事件中需要用到的字段 */
interface AgentEndEvent {
  messages?: Array<{ role?: string }>;
  [key: string]: unknown;
}

/** 构建 agent_end 事件的最终 AgentResult */
function buildAgentEndResult(
  event: AgentEndEvent,
  runItems: Array<
    | { type: "assistant"; message: AgentMessage & { role: "assistant" } }
    | { type: "guidance"; text: string; createdAt: number }
  >,
  assistantText: string,
  runtimeModelId: string,
  toolResults: Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
      details?: Record<string, unknown>;
    }
  >,
  providerCacheHit: boolean,
): AgentResult | null {
  // 从 runItems 中提取 assistant 消息
  let assistants = runItems
    .filter(
      (item): item is Extract<(typeof runItems)[number], { type: "assistant" }> =>
        item.type === "assistant",
    )
    .map((item) => item.message);

  if (assistants.length === 0) {
    const last = [...(event.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    if (last && last.role === "assistant") {
      assistants = [last as AgentMessage & { role: "assistant" }];
    }
  }

  if (assistants.length === 0) {
    return {
      content: assistantText,
      model: runtimeModelId,
      usage: { input: 0, output: 0, totalTokens: 0 },
      segments: assistantText ? [{ kind: "text", text: assistantText }] : [],
    };
  }

  // 聚合所有轮次的 segments，保持轮次与块的真实顺序
  const segments: Segment[] = [];
  for (const item of runItems) {
    if (item.type === "assistant") {
      segments.push(...extractSegments(item.message, toolResults));
    } else {
      segments.push({
        kind: "guidance",
        text: item.text,
        createdAt: item.createdAt,
      });
    }
  }

  const lastAssistant = assistants[assistants.length - 1];
  const content =
    segments
      .filter((seg) => seg.kind === "text")
      .map((seg) => (seg.kind === "text" ? seg.text : ""))
      .filter(Boolean)
      .join("\n") || assistantText;

  return {
    content,
    model: lastAssistant.model?.trim() || runtimeModelId,
    usage: {
      input: lastAssistant.usage?.input ?? 0,
      output: lastAssistant.usage?.output ?? 0,
      totalTokens: lastAssistant.usage?.totalTokens ?? 0,
    },
    segments,
    providerCacheHit,
  };
}

/**
 * 从最终的 AssistantMessage.content 有序 block 提取 segments。
 * pi 的 content 顺序即模型产出的真实顺序：text / thinking / toolCall 交错。
 * 工具调用的单行结果摘要从本轮收集的 toolResults 里按 toolCallId 取。
 */
function extractSegments(
  message: AgentMessage & { role: "assistant" },
  toolResults: Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      todos?: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
      details?: Record<string, unknown>;
    }
  >,
): Segment[] {
  const segments: Segment[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        segments.push({ kind: "text", text: block.text });
      }
    } else if (block.type === "thinking") {
      if (block.thinking.trim().length > 0) {
        segments.push({ kind: "thinking", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const result = toolResults.get(block.id);
      segments.push({
        kind: "tool",
        toolCallId: block.id,
        toolName: block.name,
        label: result?.label ?? toolDisplayName(block.name),
        // 结果未到位 = 仍在执行（流式中显示旋转图标）；到位后按成功/出错定状态
        status: result ? (result.isError ? "error" : "done") : "running",
        resultText: result?.resultText,
        todos: result?.todos,
        details: result?.details,
      });
    }
  }

  return segments;
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

// 从 update_todos 的结果里抽取完整待办快照（供按待办分组折叠）
function extractTodos(
  toolName: string,
  result: unknown,
):
  | Array<{ content: string; status: "pending" | "in_progress" | "completed" }>
  | undefined {
  if (toolName !== "update_todos") return undefined;
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: Record<string, unknown> }).details;
  if (!details || !Array.isArray(details.todos)) return undefined;

  const todos = details.todos
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as { content?: unknown; status?: unknown };
      const content =
        typeof record.content === "string" ? record.content : "";
      const status =
        record.status === "in_progress" || record.status === "completed"
          ? record.status
          : "pending";
      if (!content) return null;
      return { content, status } as const;
    })
    .filter(
      (
        item,
      ): item is {
        content: string;
        status: "pending" | "in_progress" | "completed";
      } => item !== null,
    );

  return todos.length > 0 ? todos : undefined;
}

// 从工具结果中提取 details 对象
function extractToolDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: Record<string, unknown> }).details;
  return details && typeof details === "object" ? details : undefined;
}

// 工具中间进度 -> 步骤面板里的单行摘要（tool_execution_update 事件用）
function summarizePartialResult(toolName: string, partial: unknown): string | undefined {
  if (!partial || typeof partial !== "object") return undefined;
  const details = (partial as { details?: Record<string, unknown> }).details;
  if (details) {
    // bash 执行中：显示 phase
    if (toolName === "run_bash" && typeof details.phase === "string") {
      return details.phase === "executing" ? "正在执行命令..." : undefined;
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

// 工具结果 -> 步骤面板里的单行摘要
function summarizeToolResult(toolName: string, result: unknown): string {
  const base = toolDisplayName(toolName);
  if (result && typeof result === "object") {
    const details = (result as { details?: Record<string, unknown> }).details;
    if (details) {
      if (toolName === "update_todos" && Array.isArray(details.todos)) {
        return `已更新待办 ${details.todos.length} 项`;
      }
      if (toolName === "write_file" && typeof details.path === "string") {
        return `已写入 ${String(details.path).split(/[\\/]/).pop()}`;
      }
      if (toolName === "create_office_document" && typeof details.path === "string") {
        return `已创建 ${String(details.path).split(/[\\/]/).pop()}`;
      }
      if (toolName === "edit_file" && typeof details.path === "string") {
        const name = String(details.path).split(/[\\/]/).pop();
        const replaced =
          typeof details.replaced === "number" ? details.replaced : 1;
        return `已编辑 ${name}（替换 ${replaced} 处）`;
      }
      if (toolName === "create_directory" && typeof details.path === "string") {
        return `已创建目录 ${String(details.path).split(/[\\/]/).pop()}`;
      }
      if (toolName === "delete_file" && typeof details.path === "string") {
        return `已删除 ${String(details.path).split(/[\\/]/).pop()}`;
      }
      if (toolName === "list_directory" && Array.isArray(details.entries)) {
        return `列出 ${details.entries.length} 个条目`;
      }
    }
  }
  return base;
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
  cancelAskUserRequestsForThread(threadId);
  agentManager.abortThread(threadId);
}

/**
 * 在 Agent 正在运行时插入用户引导。pi-agent 会在后续循环点消费 steering 消息，
 * 通常表现为当前工具/步骤完成后、下一轮模型请求前生效。
 */
export async function steerAgentThread(
  threadId: string,
  text: string,
): Promise<boolean> {
  const accepted = await agentManager.steerThread(threadId, text);
  return accepted > 0;
}

/** 中止当前所有 Agent 运行（极端清理场景，如重置运行时）。 */
export function abortAgent() {
  agentManager.abortAll();
}

/** 重置某个线程的 harness 会话状态 */
export function resetAgent(threadId: string) {
  cancelAskUserRequestsForThread(threadId);
  agentManager.disposeThread(threadId);
}
