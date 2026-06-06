// 对话页：消息流 + 底部输入框 + 右侧任务监控面板
// src/pages/ChatPage.tsx

import {
  Copy,
  FileCode,
  FolderOpen,
  SendHorizontal,
  Square as SquareIcon,
  Zap,
} from "lucide-react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { abortAgentThread, promptAgent } from "@/ai/agent";
import { AnimatePresence } from "motion/react";
import {
  ThinkingRow,
  ToolStepsRow,
  ToolStepItem,
  TaskGroup,
  StepTrace,
  type ToolSeg,
} from "@/components/AgentTrace";
import { ComposerToolbar } from "@/components/ComposerToolbar";
import { IconButton } from "@/components/IconButton";
import {
  SkillComposerInput,
  type SkillComposerHandle,
} from "@/components/SkillComposerInput";
import { MarkdownContent } from "@/components/MarkdownContent";
import { TaskMonitorPanel } from "@/components/TaskMonitorPanel";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { checkProviderConfig } from "@/lib/init";
import { stripMarkdown } from "@/lib/markdown";
import { setSessionWorkingDir } from "@/lib/pi-session";
import { pickWorkingDirectory } from "@/lib/electron-api";
import { copyText } from "@/lib/electron-window";
import {
  type ChatMessage,
  type Segment,
  useChatStore,
  useIsThreadResponding,
  useThreadMessages,
} from "@/stores/chat-store";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";

const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

export function ChatPage({
  activeThreadTitle,
  agentId,
  applyStreamingUpdate,
  composer,
  enabledSkills,
  failAssistant,
  finishAssistant,
  setComposer,
  startExchange,
  threadId,
}: {
  activeThreadTitle: string;
  agentId: string;
  applyStreamingUpdate: (
    threadId: string,
    messageId: string,
    update: { appendDelta?: string; segments?: Segment[] },
  ) => void;
  composer: string;
  enabledSkills: Array<{ id: string; name: string }>;
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: { model?: string; tokenCount?: number; segments?: Segment[] },
  ) => void;
  setComposer: (value: string) => void;
  startExchange: (userText: string) => {
    assistantId: string;
    threadId: string;
  };
  threadId: string;
}) {
  // 本会话的消息直接从 store 按 threadId 订阅——其它后台会话的流式更新
  // 不会换本会话 messages 的引用，因而不会触发本页重渲染。
  const messages = useThreadMessages(threadId);
  // 当前会话是否正在运行（响应中）——per-thread，切换会话各自独立
  const isResponding = useIsThreadResponding(threadId);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // 富文本输入区句柄 + 本次发送临时选中的技能 id / 文件路径（输入框 "/" 与 "@"）
  const composerRef = useRef<SkillComposerHandle>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  // 是否「粘底」：用户在底部附近时自动跟随新内容；向上滚离底部后停止跟随
  const stickToBottomRef = useRef(true);

  // 该会话是否已产生监控数据（待办/产物/步骤）——决定面板默认是否展开
  const hasMonitorData = useTaskMonitorStore((state) => {
    const monitor = state.byThread[threadId];
    if (!monitor) return false;
    return (
      monitor.todos.length > 0 ||
      monitor.artifacts.length > 0 ||
      monitor.steps.length > 0
    );
  });

  // 面板开合状态在 panel-store 中，供顶部栏按钮与本页共享
  const panelOpen = usePanelOpen();
  const setHasData = usePanelStore((state) => state.setHasData);
  const resetOverride = usePanelStore((state) => state.resetOverride);

  // 同步「有无监控数据」到 store，驱动默认展开
  useEffect(() => {
    setHasData(hasMonitorData);
  }, [hasMonitorData, setHasData]);

  // 切换会话时重置手动覆盖，重新回到「有内容才展开」
  useEffect(() => {
    resetOverride();
  }, [threadId, resetOverride]);

  // 显示用的工作目录：只取该对话自身的（task-monitor，按 threadId）。
  // 不回退全局默认——否则未选目录的对话会误显示别的对话刚选的路径。
  const workingDir = useTaskMonitorStore(
    (state) => state.byThread[threadId]?.workingDir ?? "",
  );

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) {
      // 仅改当前对话：即时显示（task-monitor）+ 持久化到该对话 meta，
      // 不动全局默认（全局默认仅由首页选目录更新，作为新会话初始值）。
      useTaskMonitorStore.getState().setWorkingDir(threadId, dir);
      void setSessionWorkingDir(threadId, dir);
    }
  };

  // 监听滚动：实时判断用户是否处于底部附近（留 80px 容差，避免像素误差）
  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element) {
      return;
    }

    const handleScroll = () => {
      const distanceToBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      stickToBottomRef.current = distanceToBottom < 80;
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => element.removeEventListener("scroll", handleScroll);
  }, []);

  // 新内容到来时自动滚动到底部——仅当用户仍「粘底」时才跟随；
  // 用户向上滚离底部后不再强制滚动，直到其手动滚回底部恢复跟随。
  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element || !stickToBottomRef.current) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isResponding]);

  const handleSend = async () => {
    const input = composer.trim();
    if (!input || isResponding) {
      return;
    }

    // 检查 Provider 配置
    const providerCheck = checkProviderConfig();
    if (!providerCheck.isConfigured) {
      alert(providerCheck.message);
      return;
    }

    const { assistantId, threadId } = startExchange(input);
    // 捕获本次技能 / 文件后清空输入区（富文本 + 技能 chip + 文件 chip）
    const sendSkillIds = skillIds;
    const sendFilePaths = filePaths;
    composerRef.current?.clear();
    setComposer("");
    setSkillIds([]);
    setFilePaths([]);

    const workingDir =
      useTaskMonitorStore.getState().getMonitor(threadId).workingDir ||
      useChatStore.getState().workingDir ||
      undefined;

    // 使用 pi AgentHarness 驱动多轮工具调用（历史由 pi Session 原生管理）。
    // 此处不 await 阻塞 UI——promptAgent 会在后台持续运行，
    // 用户切到其它会话或页面后该会话仍继续（运行态由 store 的 runningThreadIds 跟踪）。
    void promptAgent(
      input,
      {
        // 流式合批：每帧一次写入（追加文本 + 替换有序段），思考/工具/正文按真实顺序显示
        onStreamUpdate: (update) =>
          applyStreamingUpdate(threadId, assistantId, update),
        onDone: ({ content, model, usage, segments }) =>
          finishAssistant(threadId, assistantId, content, {
            model,
            tokenCount: usage.totalTokens,
            segments,
          }),
        onError: (message) => failAssistant(threadId, assistantId, message),
      },
      agentId,
      {
        threadId,
        workingDir,
        messageId: assistantId,
        skillIds: sendSkillIds,
        filePaths: sendFilePaths,
      },
    );
  };

  return (
    <div className="flex h-full min-w-0">
      <section className="relative flex h-full min-w-0 flex-1 flex-col">
        <PageHeader title={activeThreadTitle || "新对话"} />

        <div
          ref={scrollAreaRef}
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-4 pb-48 pt-8 sm:px-8">
            {messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                threadId={threadId}
              />
            ))}
          </div>
        </div>

        <Composer
          composerRef={composerRef}
          isResponding={isResponding}
          onAbort={() => abortAgentThread(threadId)}
          onEnter={() => void handleSend()}
          onPickDir={() => void handlePickDir()}
          onPickSkill={(skill) => composerRef.current?.insertSkill(skill)}
          onPickFile={(file) => composerRef.current?.insertFile(file)}
          onSend={() => void handleSend()}
          onSkillsChange={setSkillIds}
          onFilesChange={setFilePaths}
          setValue={setComposer}
          value={composer}
          workingDir={workingDir}
        />
      </section>

      <AnimatePresence initial={false}>
        {panelOpen ? (
          <TaskMonitorPanel
            key="task-monitor-panel"
            enabledSkills={enabledSkills}
            threadId={threadId}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PageHeader({ action, title }: { action?: ReactNode; title: string }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between bg-background px-5">
      <h1 className="min-w-0 truncate text-sm font-normal">{title}</h1>
      {action ? <div className="ml-4 shrink-0">{action}</div> : null}
    </header>
  );
}

// 单条消息用 memo 包裹：仅当 message 引用或 threadId 变化时才重渲染。
// 流式时只有「当前正在生成的那条」会换引用，已完成的历史消息不再重渲染——
// 这是多会话并行时避免整列表（含 Markdown 重解析）反复重算的关键。
const ChatMessageView = memo(function ChatMessageView({
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
          {message.content}
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
          {message.tokenCount ? (
            <span className="ml-2 text-[11px] text-muted-foreground">
              {message.model} · {message.tokenCount} tokens
            </span>
          ) : null}
        </div>
      )}
    </article>
  );
});

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
    | { type: "tools"; tools: ToolSeg[] }
  > = [];

  for (const seg of segments) {
    if (seg.kind === "text") {
      blocks.push({ type: "text", text: seg.text });
    } else if (seg.kind === "thinking") {
      blocks.push({ type: "thinking", text: seg.text });
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
        // 工具段逐个平铺（沿用单行项 + 点击展开结果，不再二次折叠）
        return <ToolStepItem key={seg.toolCallId} tool={seg} />;
      })}
    </div>
  );
}

function Composer({
  composerRef,
  isResponding,
  onAbort,
  onEnter,
  onPickDir,
  onPickSkill,
  onPickFile,
  onSend,
  onSkillsChange,
  onFilesChange,
  setValue,
  value,
  workingDir,
}: {
  composerRef: RefObject<SkillComposerHandle | null>;
  isResponding: boolean;
  onAbort: () => void;
  onEnter: () => void;
  onPickDir: () => void;
  onPickSkill: (skill: { id: string; name: string }) => void;
  onPickFile: (file: { path: string; name: string }) => void;
  onSend: () => void;
  onSkillsChange: (skillIds: string[]) => void;
  onFilesChange: (filePaths: string[]) => void;
  setValue: (value: string) => void;
  value: string;
  workingDir: string;
}) {
  const canSend = value.trim().length > 0 && !isResponding;
  // 仅展示工作目录的末级名称，hover 时完整路径见 title
  const dirLabel = workingDir
    ? workingDir.split(/[\\/]/).filter(Boolean).pop() || workingDir
    : "选择工作目录";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background to-transparent px-4 pb-5 pt-12">
      <div className="pointer-events-auto w-full max-w-[820px] rounded-lg border border-border bg-card shadow-[0_18px_70px_rgba(31,35,31,0.12)]">
        <SkillComposerInput
          ref={composerRef}
          value={value}
          onChange={setValue}
          onSkillsChange={onSkillsChange}
          onFilesChange={onFilesChange}
          onEnter={onEnter}
          placeholder="描述任务，/ 快捷调用，@ 添加文件"
          className="min-h-[74px] px-4 py-3"
        />

        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* "/" 技能选择 + "@" 添加文件 */}
            <ComposerToolbar onPickSkill={onPickSkill} onPickFile={onPickFile} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="h-7 min-w-0 max-w-[260px] gap-1.5 bg-muted/50 px-2 text-xs text-muted-foreground"
                  onClick={onPickDir}
                  type="button"
                  variant="ghost"
                >
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate">{dirLabel}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{workingDir || "选择工作目录"}</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1">
            {isResponding ? (
              <IconButton label="停止" onClick={onAbort}>
                <SquareIcon className="size-4 fill-current" />
              </IconButton>
            ) : (
              <Button
                className="size-8 rounded-full"
                disabled={!canSend}
                onClick={onSend}
                size="icon"
                type="button"
              >
                <SendHorizontal className="size-4" />
                <span className="sr-only">发送</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
