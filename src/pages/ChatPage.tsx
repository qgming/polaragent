// 对话页：消息流 + 底部输入框 + 右侧任务监控面板
// src/pages/ChatPage.tsx

import {
  FolderOpen,
  SendHorizontal,
  Square as SquareIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { abortAgentThread, promptAgent, steerAgentThread } from "@/ai/agent";
import { AnimatePresence } from "motion/react";
import { ChatMessageView } from "@/components/chat/MessageRenderer";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
import { IconButton } from "@/components/IconButton";
import {
  SkillComposerInput,
  type SkillComposerHandle,
} from "@/components/skill/SkillComposerInput";
import { TaskMonitorPanel } from "@/components/TaskMonitorPanel";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { checkProviderConfig } from "@/lib/app-init";
import { setSessionWorkingDir, getSessionFilesDir, ensureSessionFilesDir } from "@/lib/session/session-operations";
import { materializeAttachments } from "@/lib/session/attachment-files";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import {
  type ChatAttachment,
  type Segment,
  useChatStore,
  useIsThreadResponding,
  useThreadMessages,
} from "@/stores/chat-store";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useAlert } from "@/hooks/useAlert";

export function ChatPage({
  activeThreadTitle,
  agentId,
  applyStreamingUpdate,
  composer,
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
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: { model?: string; tokenCount?: number; segments?: Segment[] },
  ) => void;
  setComposer: (value: string) => void;
  startExchange: (userText: string, attachments?: ChatAttachment[]) => {
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // 是否「粘底」：用户在底部附近时自动跟随新内容；向上滚离底部后停止跟随
  const stickToBottomRef = useRef(true);
  // 自定义对话框
  const { alert: showAlert, AlertDialog } = useAlert();

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

  // 会话文件目录路径（用于右侧面板显示）
  const [sessionFilesDir, setSessionFilesDir] = useState<string>("");

  // 获取会话文件目录路径
  useEffect(() => {
    void (async () => {
      const dir = await getSessionFilesDir(threadId);
      setSessionFilesDir(dir);
    })();
  }, [threadId]);

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
    if (!input && attachments.length === 0) {
      return;
    }

    if (isResponding) {
      // 引导插队是纯文本语义：带附件时无法随引导发送，避免静默丢弃，给出明确提示。
      if (attachments.length > 0) {
        await showAlert({
          title: "引导不支持附件",
          message: "任务进行中只能发送文本引导。请等任务结束后，再带附件作为新消息发送。",
          variant: "warning",
        });
        return;
      }
      if (!input) {
        return;
      }

      composerRef.current?.clear();
      setComposer("");
      setSkillIds([]);

      const accepted = await steerAgentThread(threadId, input);
      if (accepted) {
        return;
      }

      setComposer(input);
      await showAlert({
        title: "插队失败",
        message: "当前任务刚好结束，请重新发送为新消息。",
        variant: "warning",
      });
      return;
    }

    // 检查 Provider 配置
    const providerCheck = checkProviderConfig();
    if (!providerCheck.isConfigured) {
      await showAlert({
        title: "未配置模型",
        message: providerCheck.message,
        variant: "warning",
      });
      return;
    }

    // 捕获本次技能 / 文件后清空输入区（富文本 + 技能 chip + 文件 chip）
    const sendSkillIds = skillIds;
    const pendingAttachments = attachments;

    // 获取工作目录：优先使用当前会话的工作目录，回退到全局默认；
    // 若仍无，则自动使用会话临时目录（自动创建并绑定）
    const exchangeThreadId = threadId;
    let workingDir =
      useTaskMonitorStore.getState().getMonitor(exchangeThreadId).workingDir ||
      useChatStore.getState().workingDir ||
      undefined;

    if (!workingDir) {
      // 无工作目录时：使用临时目录（会话文件目录）作为默认工作目录
      const tempDir = await getSessionFilesDir(exchangeThreadId);
      await ensureSessionFilesDir(exchangeThreadId); // 确保目录存在
      workingDir = tempDir;
      // 绑定到当前会话（store + 持久化）
      useTaskMonitorStore.getState().setWorkingDir(exchangeThreadId, tempDir);
      void setSessionWorkingDir(exchangeThreadId, tempDir);
    }

    const sendAttachments = await materializeAttachments(pendingAttachments, workingDir);
    const sendFilePaths = sendAttachments
      .filter((attachment) => attachment.kind === "text")
      .map((attachment) => attachment.path);
    const { assistantId } = startExchange(input, sendAttachments);
    composerRef.current?.clear();
    setComposer("");
    setSkillIds([]);
    setAttachments([]);

    // 使用 pi AgentHarness 驱动多轮工具调用（历史由 pi Session 原生管理）。
    // 此处不 await 阻塞 UI——promptAgent 会在后台持续运行，
    // 用户切到其它会话或页面后该会话仍继续（运行态由 store 的 runningThreadIds 跟踪）。
    void promptAgent(
      input,
      {
        // 流式合批：每帧一次写入（追加文本 + 替换有序段），思考/工具/正文按真实顺序显示
        onStreamUpdate: (update) =>
          applyStreamingUpdate(exchangeThreadId, assistantId, update),
        onDone: ({ content, model, usage, segments }) =>
          finishAssistant(exchangeThreadId, assistantId, content, {
            model,
            tokenCount: usage.totalTokens,
            segments,
          }),
        onError: (message) => failAssistant(exchangeThreadId, assistantId, message),
      },
      agentId,
      {
        threadId: exchangeThreadId,
        workingDir,
        messageId: assistantId,
        skillIds: sendSkillIds,
        filePaths: sendFilePaths,
        attachments: sendAttachments,
      },
    );
  };

  return (
    <>
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
            onFilesChange={setAttachments}
            setValue={setComposer}
            value={composer}
            workingDir={workingDir}
            sessionFilesDir={sessionFilesDir}
            attachmentCount={attachments.length}
          />
        </section>

        <AnimatePresence initial={false}>
          {panelOpen ? (
            <TaskMonitorPanel
              key="task-monitor-panel"
              threadId={threadId}
              sessionFilesDir={sessionFilesDir}
            />
          ) : null}
        </AnimatePresence>
      </div>
      <AlertDialog />
    </>
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
  sessionFilesDir,
  attachmentCount,
}: {
  composerRef: RefObject<SkillComposerHandle | null>;
  isResponding: boolean;
  onAbort: () => void;
  onEnter: () => void;
  onPickDir: () => void;
  onPickSkill: (skill: { id: string; name: string }) => void;
  onPickFile: (file: ChatAttachment) => void;
  onSend: () => void;
  onSkillsChange: (skillIds: string[]) => void;
  onFilesChange: (files: ChatAttachment[]) => void;
  setValue: (value: string) => void;
  value: string;
  workingDir: string;
  sessionFilesDir: string;
  attachmentCount: number;
}) {
  const canSend = value.trim().length > 0 || attachmentCount > 0;
  const showSendButton = !isResponding || canSend;
  // 仅展示工作目录的末级名称，hover 时完整路径见 title
  const isTempDir =
    workingDir &&
    sessionFilesDir &&
    normalizeDir(workingDir) === normalizeDir(sessionFilesDir);
  const dirLabel = isTempDir
    ? "临时目录"
    : workingDir
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
          placeholder={isResponding ? "输入引导，发送后会插队到后续步骤" : "描述任务，/ 快捷调用，@ 添加文件"}
          className="app-scrollbar max-h-[220px] min-h-[74px] overflow-y-auto px-4 py-3"
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
            ) : null}
            {showSendButton ? (
              <Button
                className="size-8 rounded-full"
                disabled={!canSend}
                onClick={onSend}
                size="icon"
                type="button"
              >
                <SendHorizontal className="size-4" />
                <span className="sr-only">{isResponding ? "发送引导" : "发送"}</span>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizeDir(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}
