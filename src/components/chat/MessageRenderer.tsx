// 对话消息渲染：单条消息视图 + 按 segment 顺序/按待办分组的内容渲染。
// 从 ChatPage 抽出——这些属于「消息呈现」逻辑，与页面骨架解耦。
import { Copy, FileCode, Zap } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  ThinkingRow,
  GuidanceRow,
  ToolStepsRow,
  ToolStepItem,
  TaskGroup,
  StepTrace,
  type ToolSeg,
} from "@/components/chat/AgentTrace";
import { AudioBar } from "@/components/chat/AudioBar";
import { IconButton } from "@/components/IconButton";
import { MarkdownContent } from "@/components/markdown/MarkdownContent";
import { stripMarkdown } from "@/lib/markdown";
import { fileUrl } from "@/lib/electron/electron-api";
import { copyText } from "@/lib/electron/electron-window";
import { type ChatAttachment, type ChatMessage, type Segment } from "@/stores/chat-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";

const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

// 单条消息用 memo 包裹：仅当 message 引用或 threadId 变化时才重渲染。
// 流式时只有「当前正在生成的那条」会换引用，已完成的历史消息不再重渲染——
// 这是多会话并行时避免整列表（含 Markdown 重解析）反复重算的关键。
export const ChatMessageView = memo(function ChatMessageView({
  message,
  threadId,
}: {
  message: ChatMessage;
  threadId: string;
}) {
  // 该条 assistant 消息关联的工具步骤轨迹（按 messageId 分组）
  // 注意：selector 必须返回引用稳定的值。直接在 selector 里 .filter() 会每次
  // 产生新数组，触发 Zustand 无限重渲染并使整个应用白屏。这里只订阅原始
  // steps 数组，filter 放到 useMemo 中按需计算。
  const allSteps = useTaskMonitorStore(
    (state) => state.byThread[threadId]?.steps,
  );
  const steps = useMemo(
    () => (allSteps ?? []).filter((step) => step.messageId === message.id),
    [allSteps, message.id],
  );

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-foreground shadow-sm">
          {message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null}
          <UserAttachments attachments={message.attachments ?? []} />
        </div>
      </div>
    );
  }

  return (
    <article className="max-w-[740px] text-sm leading-7 text-foreground">
      <div className="mb-3 flex items-center gap-2.5 text-sm text-muted-foreground">
        <img
          src={logoUrl}
          alt=""
          className="size-6 shrink-0 rounded-md object-contain"
        />
        <span className="font-semibold text-foreground">PolarAgent</span>
        {message.status === "streaming" ? (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-accent-foreground">
            <Zap className="size-3.5" />
            生成中
          </span>
        ) : null}
      </div>
      {message.status === "error" ? (
        <div className="whitespace-pre-wrap text-destructive">
          {message.content || " "}
        </div>
      ) : message.segments && message.segments.length > 0 ? (
        <SegmentedContent
          segments={message.segments}
          streaming={message.status === "streaming"}
        />
      ) : (
        <>
          {steps.length > 0 ? (
            <div className="mb-3">
              <StepTrace steps={steps} />
            </div>
          ) : null}
          <MarkdownContent
            content={message.content}
            streaming={message.status === "streaming"}
          />
        </>
      )}
      {message.status === "streaming" ? null : (
        <>
          {/* 语音合成音频条 */}
          {message.segments && message.segments.length > 0 ? (
            <SynthesizedAudioBars segments={message.segments} />
          ) : null}

          {/* 复制按钮 */}
          <div className="mt-3 flex items-center gap-1 text-muted-foreground">
            <IconButton
              label="复制纯文本"
              onClick={() => void copyText(stripMarkdown(message.content))}
            >
              <Copy className="size-3.5" />
            </IconButton>
          <IconButton
            label="复制 Markdown"
            onClick={() => void copyText(message.content)}
          >
            <FileCode className="size-3.5" />
          </IconButton>
          {message.model ? (
            <span className="ml-2 text-[11px] text-muted-foreground">
              {message.model}
              {message.tokenCount ? ` · ${message.tokenCount} tokens` : ""}
            </span>
          ) : null}
          </div>
        </>
      )}
    </article>
  );
});

export function UserAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const audios = attachments.filter((attachment) => attachment.kind === "audio");
  const files = attachments.filter((attachment) => attachment.kind !== "image" && attachment.kind !== "audio");
  if (images.length === 0 && audios.length === 0 && files.length === 0) return null;

  return (
    <div className={messageAttachmentClass(Boolean(images.length || audios.length))}>
      {images.map((attachment) => (
        <UserImageAttachment key={attachment.path} attachment={attachment} />
      ))}
      {audios.map((attachment) => (
        <AudioBar
          key={attachment.path}
          audioPath={attachment.path}
          duration={attachment.duration}
          variant="user"
        />
      ))}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((attachment) => (
            <span
              key={attachment.path}
              className="inline-flex max-w-full items-center rounded-md bg-background/70 px-2 py-1 text-xs text-muted-foreground"
              title={attachment.path}
            >
              <span className="truncate">{attachment.name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function messageAttachmentClass(hasImages: boolean) {
  return hasImages ? "mt-3 flex flex-col items-end gap-2" : "mt-2";
}

function UserImageAttachment({ attachment }: { attachment: ChatAttachment }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let alive = true;
    void fileUrl(attachment.path)
      .then((next) => {
        if (alive) setUrl(next);
      })
      .catch(() => {
        if (alive) setUrl("");
      });
    return () => {
      alive = false;
    };
  }, [attachment.path]);

  if (!url) {
    return (
      <div className="h-24 w-40 rounded-md bg-background/60" title={attachment.path} />
    );
  }

  return (
    <img
      src={url}
      alt={attachment.name}
      title={attachment.path}
      className="block max-h-64 max-w-full rounded-md object-contain"
    />
  );
}

// 按 segment 真实顺序逐段渲染，保持模型产出的原始次序：
//   - 正文段：各自渲染为 markdown 块
//   - 深度思考段：每段独立成一行（连续思考也各自独立）
//   - 工具段：仅把「连续的工具」合并为一组「查看 N 个步骤」
//
// 当本条消息出现过 update_todos（即有任务待办）时，改为「按待办分组」的任务折叠渲染：
//   每次 update_todos 之间产生的段，归属到当时活跃（in_progress）的那条待办折叠块下。
function SegmentedContent({
  segments,
  streaming = false,
}: {
  segments: Segment[];
  streaming?: boolean;
}) {
  // 是否出现过带待办快照的 update_todos —— 决定走分组渲染还是扁平渲染
  const hasTodos = segments.some(
    (seg) => seg.kind === "tool" && seg.toolName === "update_todos" && seg.todos,
  );

  if (hasTodos) {
    return <TaskGroupedContent segments={segments} streaming={streaming} />;
  }

  return <FlatSegmentedContent segments={segments} streaming={streaming} />;
}

// 扁平渲染（无待办时）：text 独立 markdown；thinking 独立行；连续 tool 合并为「查看 N 个步骤」
function FlatSegmentedContent({
  segments,
  streaming = false,
}: {
  segments: Segment[];
  streaming?: boolean;
}) {
  // 切分为有序 block：text / thinking（逐段独立）/ tools（连续合并）
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "guidance"; text: string }
    | { type: "tools"; tools: ToolSeg[] }
  > = [];

  for (const seg of segments) {
    if (seg.kind === "text") {
      blocks.push({ type: "text", text: seg.text });
    } else if (seg.kind === "thinking") {
      blocks.push({ type: "thinking", text: seg.text });
    } else if (seg.kind === "guidance") {
      blocks.push({ type: "guidance", text: seg.text });
    } else {
      // 连续的工具段合并到同一组
      const last = blocks[blocks.length - 1];
      if (last && last.type === "tools") {
        last.tools.push(seg);
      } else {
        blocks.push({ type: "tools", tools: [seg] });
      }
    }
  }

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return (
            <MarkdownContent
              key={`text-${index}`}
              content={block.text}
              streaming={streaming}
            />
          );
        }
        if (block.type === "thinking") {
          return <ThinkingRow key={`think-${index}`} text={block.text} />;
        }
        if (block.type === "guidance") {
          return <GuidanceRow key={`guidance-${index}`} text={block.text} />;
        }
        return <ToolStepsRow key={`tools-${index}`} tools={block.tools} />;
      })}
    </div>
  );
}

// 任务分组渲染（出现 update_todos 时）：
//   - 把 segments 按 update_todos 调用切段，每段归属到「当时活跃的待办」
//   - 活跃待办：该次 todos 快照里第一个 in_progress；无则第一个 pending；
//     若两者皆无（全部完成）则视为「无活跃待办」，返回 null
//   - 首个 update_todos 之前的段：作为开场内容（lead），不包进任务折叠
//   - 全部完成之后的段（收尾总结正文）：作为收尾内容（tail），独立渲染、不归任何组
//   - 折叠内：思考行 / 工具逐个平铺（不再二次折叠）/ 正文 markdown，保持原始顺序
type TodoSnapshot = NonNullable<Extract<Segment, { kind: "tool" }>["todos"]>;

// 当前活跃待办：第一个 in_progress > 第一个 pending > 无（null）。
// 注意：不再在「全部 completed」时回退到最后一条——否则收尾总结正文会被错归到最后一个任务。
function activeTodoContent(todos: TodoSnapshot): string | null {
  const inProgress = todos.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress.content;
  const pending = todos.find((t) => t.status === "pending");
  if (pending) return pending.content;
  return null;
}

function TaskGroupedContent({
  segments,
  streaming = false,
}: {
  segments: Segment[];
  streaming?: boolean;
}) {
  // 顺序切段：lead（首个 update_todos 之前）+ 若干任务组 + tail（全部完成之后的收尾）
  const lead: Segment[] = [];
  const groups: Array<{ title: string; segments: Segment[] }> = [];
  const tail: Segment[] = [];
  let currentTitle: string | null = null;
  let seenTodos = false;
  // 是否已进入「收尾区」：出现过任务组、且某次 update_todos 后无活跃待办（全部完成）
  let inTail = false;

  for (const seg of segments) {
    if (seg.kind === "tool" && seg.toolName === "update_todos" && seg.todos) {
      seenTodos = true;
      // update_todos 自身不渲染为步骤；它只切换当前活跃待办
      currentTitle = activeTodoContent(seg.todos);
      if (currentTitle) {
        // 有活跃待办：退出收尾区（极少见的「完成后又新增待办」也能正确回到分组）
        inTail = false;
        const last = groups[groups.length - 1];
        if (!last || last.title !== currentTitle) {
          groups.push({ title: currentTitle, segments: [] });
        }
      } else if (groups.length > 0) {
        // 无活跃待办且已有任务组：之后的段进入收尾区
        inTail = true;
      }
      continue;
    }

    if (inTail) {
      tail.push(seg);
    } else if (!seenTodos || currentTitle === null) {
      lead.push(seg);
    } else {
      groups[groups.length - 1]?.segments.push(seg);
    }
  }

  // 完成判定：「切换到下一步 = 上一步完成」。
  // 一旦出现下一组，前面的组都视为已完成；最后一组在流式进行中为「进行中」，
  // 流式结束后视为「已完成」。若已进入收尾区，则所有任务组都视为已完成。
  const statusAt = (index: number): "in_progress" | "completed" => {
    const isLast = index === groups.length - 1;
    if (isLast && !inTail) return streaming ? "in_progress" : "completed";
    return "completed";
  };

  return (
    <div className="space-y-2">
      {lead.length > 0 ? (
        <FlatSegmentedContent segments={lead} streaming={streaming} />
      ) : null}
      {groups.map((group, index) => (
        <TaskGroup
          key={`task-${index}-${group.title}`}
          title={group.title}
          status={statusAt(index)}
        >
          <TaskGroupInner segments={group.segments} streaming={streaming} />
        </TaskGroup>
      ))}
      {tail.length > 0 ? (
        <FlatSegmentedContent segments={tail} streaming={streaming} />
      ) : null}
    </div>
  );
}

// 任务折叠内部内容：思考行 / 工具逐个平铺 / 正文 markdown，按原始顺序
function TaskGroupInner({
  segments,
  streaming = false,
}: {
  segments: Segment[];
  streaming?: boolean;
}) {
  return (
    <div className="space-y-1">
      {segments.map((seg, index) => {
        if (seg.kind === "text") {
          return (
            <div key={`t-${index}`}>
              <MarkdownContent content={seg.text} streaming={streaming} />
            </div>
          );
        }
        if (seg.kind === "thinking") {
          return (
            <div key={`k-${index}`}>
              <ThinkingRow text={seg.text} />
            </div>
          );
        }
        if (seg.kind === "guidance") {
          return (
            <div key={`g-${index}`}>
              <GuidanceRow text={seg.text} />
            </div>
          );
        }
        // 工具段逐个平铺（沿用单行项 + 点击展开结果，不再二次折叠）
        return <ToolStepItem key={seg.toolCallId} tool={seg} />;
      })}
    </div>
  );
}

// 提取并显示语音合成的音频条
function SynthesizedAudioBars({ segments }: { segments: Segment[] }) {
  const [existingAudios, setExistingAudios] = useState<Set<string>>(new Set());
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());

  const audioSegments = segments.filter(
    (seg): seg is Extract<Segment, { kind: "tool" }> =>
      seg.kind === "tool" &&
      seg.toolName === "speech_synthesis" &&
      seg.status === "done" &&
      seg.details !== undefined &&
      typeof seg.details === "object" &&
      "audioPath" in seg.details &&
      typeof seg.details.audioPath === "string",
  );

  // 检查音频文件是否存在
  useEffect(() => {
    const checkFiles = async () => {
      const newCheckedPaths = new Set(checkedPaths);
      const newExistingAudios = new Set(existingAudios);

      for (const seg of audioSegments) {
        const audioPath = seg.details!.audioPath as string;
        if (!newCheckedPaths.has(audioPath)) {
          newCheckedPaths.add(audioPath);
          try {
            const exists = await fileUrl(audioPath).then(
              () => true,
              () => false,
            );
            if (exists) {
              newExistingAudios.add(audioPath);
            }
          } catch {
            // 文件不存在，不添加到 existingAudios
          }
        }
      }

      setCheckedPaths(newCheckedPaths);
      setExistingAudios(newExistingAudios);
    };

    void checkFiles();
  }, [audioSegments]);

  const visibleSegments = audioSegments.filter((seg) => {
    const audioPath = seg.details!.audioPath as string;
    return existingAudios.has(audioPath);
  });

  if (visibleSegments.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {visibleSegments.map((seg) => {
        const audioPath = seg.details!.audioPath as string;
        const duration =
          typeof seg.details!.duration === "number" ? seg.details!.duration : undefined;
        return (
          <AudioBar
            key={seg.toolCallId}
            audioPath={audioPath}
            duration={duration}
            variant="assistant"
          />
        );
      })}
    </div>
  );
}
