// 会话历史回读与解析：把 jsonl 的 message/toolResult/custom 条目重建为 UI 用的
// ChatMessage[]（含 assistant 的有序 segments），以及任务监控快照（待办 + 产物）。
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@/lib/session/compaction";
import { skillLoader } from "@/lib/skill";
import type { ChatAttachment, ChatMessage, ChatSkillRef, Segment } from "@/lib/chat";
import type { ArtifactItem, TodoItem } from "@/stores/task-monitor-store";
import type { TeamMessage } from "@/lib/team";
import { toolDisplayName } from "@/ai/tools";
import { getRepo, getTeamRepo } from "./session-repo";
import { pickBestMeta } from "./meta-selection";
import { openOrCreateSession } from "./personal";
import { GUIDANCE_ENTRY, TEAM_SPEAKER_ENTRY, TEAM_VOTE_ENTRY } from "./entries";

// 团队会话消息：在普通 ChatMessage 基础上附带发言成员 id / 投票信息。
export type TeamChatMessage = ChatMessage & Pick<TeamMessage, "speakerAgentId" | "vote">;

/**
 * 回读某会话的「任务监控」快照（待办 + 产物），供重启后恢复右侧面板。
 *
 * 数据与消息回读同源（都来自 jsonl 的工具调用），按时间顺序遍历 assistant 的
 * toolCall block 的 arguments 重建：
 *   - update_todos → 覆盖待办（最后一次调用生效，与运行时 setTodos 语义一致）
 *   - write_file   → 产物（kind 按入参 final 区分 最终/工作 文件）
 *   - edit_file    → 产物（工作文件）
 *   - delete_file  → 从产物快照移除对应文件或目录下全部文件
 * 产物以路径为唯一键去重，后写覆盖先写（含 kind）。
 */
export async function loadThreadMonitor(
  sessionId: string,
): Promise<{ todos: TodoItem[]; artifacts: ArtifactItem[] }> {
  try {
    const session = await openOrCreateSession(sessionId);
    const branch = await session.getBranch().catch(() => []);

    let todos: TodoItem[] = [];
    // 路径 -> 产物，保留插入顺序由下方数组维护
    const artifactMap = new Map<string, ArtifactItem>();
    const toolResultPaths = new Map<string, string>();
    let order = 0; // 用作 updatedAt 的单调序，避免依赖 Date.now()

    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult") continue;
      const details = message.details;
      if (!details || typeof details !== "object") continue;
      const path = (details as Record<string, unknown>).path;
      if (typeof path === "string" && path.trim()) {
        toolResultPaths.set(message.toolCallId, path);
      }
    }

    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "assistant") continue;

      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const args = (block.arguments ?? {}) as Record<string, unknown>;

        if (block.name === "update_todos" && Array.isArray(args.todos)) {
          todos = args.todos
            .map((item, index) => {
              if (!item || typeof item !== "object") return null;
              const record = item as { content?: unknown; status?: unknown };
              const content =
                typeof record.content === "string" ? record.content : "";
              const status =
                record.status === "in_progress" ||
                record.status === "completed"
                  ? record.status
                  : "pending";
              if (!content) return null;
              return { id: `todo-${index}`, content, status } as TodoItem;
            })
            .filter((t): t is TodoItem => t !== null);
        } else if (
          (block.name === "write_file" ||
            block.name === "edit_file" ||
            block.name === "delete_file") &&
          typeof args.path === "string" &&
          args.path.trim()
        ) {
          const path = toolResultPaths.get(block.id) ?? args.path;
          if (block.name === "delete_file") {
            const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
            const prefix = `${normalized}/`;
            for (const key of Array.from(artifactMap.keys())) {
              const itemPath = key.replace(/\\/g, "/").replace(/\/+$/, "");
              if (itemPath === normalized || itemPath.startsWith(prefix)) {
                artifactMap.delete(key);
              }
            }
            continue;
          }
          const name = path.split(/[\\/]/).pop() || path;
          const kind: ArtifactItem["kind"] =
            block.name === "write_file" && args.final === true
              ? "final"
              : "working";
          artifactMap.set(path, { path, name, kind, updatedAt: order++ });
        }
      }
    }

    return { todos, artifacts: Array.from(artifactMap.values()) };
  } catch (error) {
    console.error(`回读会话任务监控失败 ${sessionId}:`, error);
    return { todos: [], artifacts: [] };
  }
}

/**
 * 回读某会话的历史消息，重建为 UI 用的 ChatMessage[]（含 assistant 的 segments）。
 *
 * pi 的 session 把每条 user / assistant / toolResult 作为独立 message 存储。
 * 这里按顺序遍历：
 *   - user      -> 一条用户 ChatMessage（取纯文本）
 *   - assistant -> 一条助手 ChatMessage，content 取 text block，segments 取有序 block
 *   - toolResult-> 不单独成条，按 toolCallId 回填到对应 assistant 的 tool segment 标签
 */
export async function loadChatMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  return loadChatMessagesImpl(sessionId, getRepo);
}

/**
 * 团队会话版：回读团队会话历史，并为每条 assistant 消息附带发言成员 speakerAgentId。
 * 发言成员来自运行时在每位成员发言前写入的 team_speaker 自定义条目（按出现顺序跟踪）。
 */
export async function loadTeamChatMessages(
  sessionId: string,
): Promise<TeamChatMessage[]> {
  return loadChatMessagesImpl(sessionId, getTeamRepo, { trackSpeaker: true });
}

async function loadChatMessagesImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
  opts?: { trackSpeaker?: boolean },
): Promise<TeamChatMessage[]> {
  const repo = await repoGetter();
  const metas = await repo.list().catch(() => []);
  const hits = metas.filter((meta) => meta.id === sessionId);
  if (hits.length === 0) return [];

  // 同 id 多条时读「内容最多」的那条，确保回读到有消息的会话而非空壳
  const best = await pickBestMeta(hits);
  const session = await repo.open(best);
  const branch = await session.getBranch().catch(() => []);

  // 先收集所有 toolResult，按 toolCallId 建索引，供 assistant 的 tool segment 回填
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
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, {
        label: summarizeToolResultContent(message.toolName, message.details),
        isError: message.isError,
        resultText: toolResultDetailsText(message.details),
        // 还原 update_todos 的待办快照，供重启后历史对话仍能按任务分组折叠
        todos: extractTodosFromDetails(message.toolName, message.details),
        // 保存完整的 details 对象，供语音合成等功能恢复使用
        details: extractDetails(message.details),
      });
    }
  }

  const messages: TeamChatMessage[] = [];
  const voteMessageIndexes = new Map<string, number>();

  // 团队模式下跟踪「当前发言成员」：每遇到一条 team_speaker 自定义条目就更新。
  // 不变量：写入端 appendTeamAssistantMessage 始终「先写 team_speaker、再写该成员的
  // assistant 消息」成对落盘，因此每条 assistant 消息都有正确的前置 speaker。
  // 若未来新增其它 assistant 写入路径，务必同样先写 speaker，否则归属会沿用上一位。
  let currentSpeaker: string | undefined;

  // 一次用户提问可能触发 agent 多轮调用，产生多条相邻的 assistant 消息
  // （中间夹着 toolResult）。这里把「相邻的 assistant」合并为一条 ChatMessage，
  // segments 按序拼接，与实时运行时聚合为「一整条消息」的结构保持一致。
  // 遇到 user 消息即断开。
  let pending: {
    id: string;
    createdAt: number;
    segments: Segment[];
    model?: string;
    tokenCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    contextTokens?: number;
    speakerAgentId?: string;
  } | null = null;
  const pendingGuidance: Array<{ text: string; createdAt: number }> = [];

  // 把累积中的助手消息落地为一条 ChatMessage
  const flushPending = () => {
    if (!pending || pending.segments.length === 0) {
      pending = null;
      return;
    }
    const content = pending.segments
      .filter((seg): seg is Extract<Segment, { kind: "text" }> => seg.kind === "text")
      .map((seg) => seg.text)
      .filter(Boolean)
      .join("\n");
    messages.push({
      id: pending.id,
      role: "assistant",
      content,
      createdAt: pending.createdAt,
      status: "complete",
      model: pending.model,
      tokenCount: pending.tokenCount,
      inputTokens: pending.inputTokens,
      outputTokens: pending.outputTokens,
      cacheWriteTokens: pending.cacheWriteTokens,
      cacheReadTokens: pending.cacheReadTokens,
      contextTokens: pending.contextTokens,
      segments: pending.segments,
      speakerAgentId: pending.speakerAgentId,
    });
    pending = null;
  };

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === GUIDANCE_ENTRY) {
      const data = entry.data as { text?: unknown; createdAt?: unknown } | undefined;
      if (data && typeof data.text === "string" && data.text.trim()) {
        pendingGuidance.push({
          text: data.text.trim(),
          createdAt:
            typeof data.createdAt === "number"
              ? data.createdAt
              : Date.parse(entry.timestamp) || 0,
        });
      }
      continue;
    }

    if (
      opts?.trackSpeaker &&
      entry.type === "custom" &&
      entry.customType === TEAM_VOTE_ENTRY
    ) {
      flushPending();
      const message = parseTeamVoteEntry(entry.data);
      if (message) {
        const existingIndex = voteMessageIndexes.get(message.id);
        if (existingIndex === undefined) {
          voteMessageIndexes.set(message.id, messages.length);
          messages.push(message);
        } else {
          messages[existingIndex] = message;
        }
      }
      continue;
    }

    // 团队模式：team_speaker 自定义条目用于切换「当前发言成员」，先落地上一位的消息
    if (
      opts?.trackSpeaker &&
      entry.type === "custom" &&
      entry.customType === TEAM_SPEAKER_ENTRY
    ) {
      const data = entry.data as { agentId?: unknown } | undefined;
      if (data && typeof data.agentId === "string") {
        flushPending();
        currentSpeaker = data.agentId;
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const timestamp = Date.parse(entry.timestamp) || message.timestamp || 0;

    if (message.role === "user") {
      const text = userMessageText(message);
      const attachments = userMessageAttachments(message);
      const skillRefs = userMessageSkillRefs(message);

      // 新的用户消息 -> 先落地累积的助手消息，断开合并
      flushPending();

      // 从待处理 guidance 队列中查找与当前用户消息文本匹配的 guidance。
      // guidance 条目在用户消息之前写入，回读时应归属到对应的用户消息中。
      const guidanceSegments: Segment[] = [];
      const guidanceIndex = pendingGuidance.findIndex(
        (guidance) => guidance.text === text.trim(),
      );
      if (guidanceIndex >= 0) {
        const [guidance] = pendingGuidance.splice(guidanceIndex, 1);
        guidanceSegments.push({
          kind: "guidance",
          text: guidance.text,
          createdAt: guidance.createdAt,
        });
      }

      // 仅当正文与附件都为空时才跳过；纯附件消息（只发图片/文件无文字）需保留
      if (
        text.trim().length === 0 &&
        attachments.length === 0 &&
        skillRefs.length === 0 &&
        guidanceSegments.length === 0
      ) {
        continue;
      }

      // 构建用户消息，guidance 段作为 segments 的一部分（附件、技能引用之后）
      const userSegments: Segment[] = [...guidanceSegments];
      messages.push({
        id: entry.id,
        role: "user",
        content: text,
        createdAt: timestamp,
        status: "complete",
        attachments,
        skillRefs,
        segments: userSegments.length > 0 ? userSegments : undefined,
      });
    } else if (message.role === "assistant") {
      const segments = assistantSegments(message, toolResults);
      if (segments.length === 0) continue;
      // 追加到当前累积；id/model/tokenCount/时间取该组最后一条（与实时聚合一致）
      if (!pending) {
        pending = {
          id: entry.id,
          createdAt: timestamp,
          segments: [...segments],
          model: message.model,
          // 每轮总量与上下文都用官方口径 calculateContextTokens
          // （= totalTokens || input+output+cacheRead+cacheWrite），
          // 与实时路径（src/ai/agent.ts buildAgentEndResult）保持一致
          tokenCount: message.usage ? calculateContextTokens(message.usage) : undefined,
          inputTokens: message.usage?.input,
          outputTokens: message.usage?.output,
          cacheWriteTokens: message.usage?.cacheWrite,
          cacheReadTokens: message.usage?.cacheRead,
          contextTokens: message.usage ? calculateContextTokens(message.usage) : undefined,
          speakerAgentId: currentSpeaker,
        };
      } else {
        pending.id = entry.id;
        pending.createdAt = timestamp;
        pending.segments.push(...segments);
        pending.model = message.model ?? pending.model;
        // 累加所有轮次的 token（口径同上）
        pending.tokenCount =
          (pending.tokenCount ?? 0) + (message.usage ? calculateContextTokens(message.usage) : 0);
        pending.inputTokens = (pending.inputTokens ?? 0) + (message.usage?.input ?? 0);
        pending.outputTokens = (pending.outputTokens ?? 0) + (message.usage?.output ?? 0);
        pending.cacheWriteTokens = (pending.cacheWriteTokens ?? 0) + (message.usage?.cacheWrite ?? 0);
        pending.cacheReadTokens = (pending.cacheReadTokens ?? 0) + (message.usage?.cacheRead ?? 0);
        // 当前上下文大小取最后一轮的官方口径总量
        pending.contextTokens = message.usage
          ? calculateContextTokens(message.usage)
          : pending.contextTokens;
      }
    }
    // toolResult 已在上面收集，不单独成条
  }

  // 尾部可能还有未落地的助手消息
  flushPending();

  return messages;
}

function parseTeamVoteEntry(data: unknown): TeamChatMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = (data as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const record = message as Partial<TeamMessage>;
  if (
    typeof record.id !== "string" ||
    record.role !== "assistant" ||
    typeof record.content !== "string" ||
    typeof record.createdAt !== "number" ||
    !record.vote
  ) {
    return null;
  }

  return {
    id: record.id,
    role: "assistant",
    content: record.content,
    createdAt: record.createdAt,
    status: record.status ?? "complete",
    model: record.model,
    tokenCount: record.tokenCount,
    segments: record.segments,
    speakerAgentId: record.speakerAgentId,
    vote: record.vote,
  };
}

// 剥离后台注入的技能块 <skill …>…</skill> 与文件块 <file …>…</file>（方案 C）：
// 这些块是 "/" 选中技能时拼进发送内容的 SKILL.md 全文/目录树、以及 "@" 选中文件的内容，
// 供模型读取，不应在 UI 对话记录里显示。回读时移除所有此类块及其后随空白，仅保留用户问题。
function stripSkillBlocks(text: string): string {
  return text
    .replace(/<skill\b[^>]*>[\s\S]*?<\/skill>\s*/g, "")
    .replace(/<skill_files\b[^>]*>[\s\S]*?<\/skill_files>\s*/g, "")
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>\s*/g, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>\s*/g, "")
    .trim();
}

function attrValue(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`),
  );
  return match?.[1] ?? match?.[2];
}

function rawUserText(
  message: Extract<AgentMessage, { role: "user" }>,
  separator = "\n",
): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join(separator);
}

function userMessageAttachments(
  message: Extract<AgentMessage, { role: "user" }>,
): ChatAttachment[] {
  const rawText = rawUserText(message);
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const match of rawText.matchAll(/<file\b([^>]*)>[\s\S]*?<\/file>/g)) {
    const attrs = match[1] ?? "";
    const path = attrValue(attrs, "path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push({
      path,
      name: attrValue(attrs, "name") ?? path.split(/[\\/]/).pop() ?? path,
      kind: "text",
    });
  }
  for (const match of rawText.matchAll(/<image\b([^>]*)>[\s\S]*?<\/image>/g)) {
    const attrs = match[1] ?? "";
    const path = attrValue(attrs, "path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push({
      path,
      name: attrValue(attrs, "name") ?? path.split(/[\\/]/).pop() ?? path,
      kind: "image",
    });
  }
  return attachments;
}

function userMessageSkillRefs(
  message: Extract<AgentMessage, { role: "user" }>,
): ChatSkillRef[] {
  const rawText = rawUserText(message);
  const refs: ChatSkillRef[] = [];
  const seen = new Set<string>();

  for (const match of rawText.matchAll(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g)) {
    const attrs = match[1] ?? "";
    const id =
      attrValue(attrs, "name") ??
      attrValue(attrs, "id") ??
      attrValue(attrs, "skill") ??
      attrValue(attrs, "title");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName =
      attrValue(attrs, "displayName") ??
      attrValue(attrs, "label") ??
      skillLoader.getSkill(id)?.name ??
      id;
    refs.push({ id, name: displayName });
  }

  return refs;
}

// 取用户消息的纯文本（content 可能是 string 或 (text|image)[]），并剥离技能块
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  const raw = rawUserText(message, "");
  return stripSkillBlocks(raw);
}

// 从 assistant message 的有序 content blocks 重建 segments
function assistantSegments(
  message: Extract<AgentMessage, { role: "assistant" }>,
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
      const widget = extractWidgetSegmentFromDetails(result?.details);
      if (widget) {
        segments.push(widget);
        continue;
      }
      segments.push({
        kind: "tool",
        toolCallId: block.id,
        toolName: block.name,
        label: result?.label ?? toolDisplayName(block.name),
        status: result ? (result.isError ? "error" : "done") : "done",
        resultText: result?.resultText,
        // 还原 update_todos 的待办快照，使重启后历史对话仍能按任务分组折叠
        todos: result?.todos,
        // 恢复工具结果的 details，供语音合成等功能使用
        details: result?.details,
      });
    }
  }
  return segments;
}

// 工具结果 details -> 单行摘要（与 agent.ts 的运行时摘要保持一致风格）
function summarizeToolResultContent(toolName: string, details: unknown): string {
  const base = toolDisplayName(toolName);
  if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    if (toolName === "update_todos" && Array.isArray(record.todos)) {
      return `已更新待办 ${record.todos.length} 项`;
    }
    if (toolName === "write_file" && typeof record.path === "string") {
      return `已写入 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "create_directory" && typeof record.path === "string") {
      return `已创建目录 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "delete_file" && typeof record.path === "string") {
      return `已删除 ${String(record.path).split(/[\\/]/).pop()}`;
    }
    if (toolName === "list_directory" && Array.isArray(record.entries)) {
      return `列出 ${record.entries.length} 个条目`;
    }
  }
  return base;
}

// 从回读到的 toolResult.details 里抽取 update_todos 的待办快照。
// 与 agent.ts 的 extractTodos 等价，但这里 details 已是对象（无 result.details 外层）。
function extractTodosFromDetails(
  toolName: string,
  details: unknown,
):
  | Array<{ content: string; status: "pending" | "in_progress" | "completed" }>
  | undefined {
  if (toolName !== "update_todos") return undefined;
  if (!details || typeof details !== "object") return undefined;
  const rawTodos = (details as Record<string, unknown>).todos;
  if (!Array.isArray(rawTodos)) return undefined;

  const todos = rawTodos
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as { content?: unknown; status?: unknown };
      const content = typeof record.content === "string" ? record.content : "";
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

// 从 toolResult.details 中提取完整的 details 对象
function extractDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  return details as Record<string, unknown>;
}

function extractWidgetSegmentFromDetails(
  details: Record<string, unknown> | undefined,
): Extract<Segment, { kind: "widget" }> | undefined {
  const widget = details?.widget;
  if (!widget || typeof widget !== "object") return undefined;

  const record = widget as Record<string, unknown>;
  if (typeof record.widgetId !== "string" || typeof record.title !== "string" || typeof record.html !== "string") {
    return undefined;
  }

  return {
    kind: "widget",
    widgetId: record.widgetId,
    title: record.title,
    html: record.html,
    updateMode: record.update_mode === "patch" ? "patch" : "replace",
    widgetPath: typeof record.widget_path === "string" ? record.widget_path : null,
    data:
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : null,
  };
}

// 工具结果 details -> 完整可读文本（供步骤项点击展开查看）
function toolResultDetailsText(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (details && typeof details === "object" && "widget" in (details as Record<string, unknown>)) {
    const widget = (details as Record<string, unknown>).widget;
    if (widget && typeof widget === "object") {
      const info = widget as Record<string, unknown>;
      const title = typeof info.title === "string" ? info.title : "未命名 Widget";
      const mode = info.update_mode === "patch" ? "patch" : "replace";
      const source = info.source === "file" ? "模板文件" : "内联代码";
      return `Widget: ${title}\n更新模式: ${mode}\n来源: ${source}`;
    }
  }
  if (typeof details === "string") {
    return details.trim() || undefined;
  }
  if (typeof details === "object") {
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return undefined;
    }
  }
  return String(details);
}
