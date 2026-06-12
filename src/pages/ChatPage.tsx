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
import { PermissionModeMenu } from "@/components/chat/PermissionModeMenu";
import { KnowledgeBaseSelector } from "@/components/knowledge";
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
import { setSessionWorkingDir, getSessionFilesDir, ensureSessionFilesDir } from "@/lib/session/personal";
import { materializeAttachments } from "@/lib/session/attachment-files";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import {
  useChatStore,
  useIsThreadResponding,
  useThreadMessages,
  useThreadPermissionMode,
  useThreadKnowledgeBaseIds,
} from "@/stores/chat-store";
import type { ChatAttachment, Segment } from "@/lib/chat";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useConfigStore } from "@/stores/config-store";
import { useAlert } from "@/hooks/useAlert";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useResponsiveWidth } from "@/hooks/useResponsiveWidth";
import { AudioLines } from "@/components/animate-ui/icons/audio-lines";
import type { ToolPermissionMode } from "@/types/permissions";

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
  const permissionMode = useThreadPermissionMode(threadId);
  const knowledgeBaseIds = useThreadKnowledgeBaseIds(threadId);
  const setThreadPermissionMode = useChatStore(
    (state) => state.setThreadPermissionMode,
  );
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

  const handleKnowledgeChange = (ids: string[]) => {
    useChatStore.getState().setThreadKnowledgeBaseIds(threadId, ids);
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
        permissionMode,
        knowledgeBaseIds,
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
            onPermissionModeChange={(mode) =>
              setThreadPermissionMode(threadId, mode)
            }
            setValue={setComposer}
            value={composer}
            permissionMode={permissionMode}
            workingDir={workingDir}
            sessionFilesDir={sessionFilesDir}
            attachmentCount={attachments.length}
            knowledgeBaseIds={knowledgeBaseIds}
            onKnowledgeChange={handleKnowledgeChange}
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
  onPermissionModeChange,
  setValue,
  value,
  permissionMode,
  workingDir,
  sessionFilesDir,
  attachmentCount,
  knowledgeBaseIds,
  onKnowledgeChange,
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
  onPermissionModeChange: (mode: ToolPermissionMode) => void;
  setValue: (value: string) => void;
  value: string;
  permissionMode: ToolPermissionMode;
  workingDir: string;
  sessionFilesDir: string;
  attachmentCount: number;
  knowledgeBaseIds: string[];
  onKnowledgeChange: (ids: string[]) => void;
}) {
  const audioRecorder = useAudioRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  // 响应式宽度断点
  const breakpoint = useResponsiveWidth();

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

  // 响应式：narrow 模式下工作目录按钮最大宽度更小
  const dirButtonMaxWidth = breakpoint === "narrow" ? "max-w-[120px]" : "max-w-[260px]";

  // 录音处理：点击切换录音状态
  const handleToggleRecording = async () => {
    if (audioRecorder.isRecording) {
      // 结束录音并转文字
      setIsTranscribing(true);
      let tempPath: string | null = null;
      try {
        const blob = await audioRecorder.stopRecording();
        if (!blob) {
          setIsTranscribing(false);
          return;
        }

        if (blob.size === 0) {
          setIsTranscribing(false);
          return;
        }

        // 获取 ASR 配置
        const settings = useConfigStore.getState().settings.audio;
        const asrConfig = settings?.asr;
        if (!asrConfig?.provider) throw new Error("ASR 接口未配置");

        const activeConfig = asrConfig.provider === "audio" ? asrConfig.audio : asrConfig.chat;
        if (!activeConfig?.apiKey?.trim() || !activeConfig.model?.trim()) {
          throw new Error("语音识别未配置，请在设置中配置 ASR");
        }

        // 将 Blob 转为 base64
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
        );

        // 保存临时文件用于转写
        const { writeBase64File, deleteFile, openAiTranscription } = await import("@/lib/electron/electron-api");
        const timestamp = Date.now();
        tempPath = `audio-recording-${timestamp}.webm`;
        await writeBase64File(tempPath, base64);

        // 调用语音识别 API
        const transcription = await openAiTranscription({
          apiKey: activeConfig.apiKey.trim(),
          baseURL: activeConfig.baseURL,
          model: activeConfig.model.trim(),
          audioPath: tempPath,
          language: activeConfig.language?.trim() || undefined,
          responseFormat: "json",
        });

        if (transcription.text && transcription.text.trim()) {
          let text = transcription.text.trim();

          // 获取语音输入优化选项
          const inputOptimization = settings?.inputOptimization;
          const shouldRefine = inputOptimization?.refineText ?? false;
          const shouldAutoSend = inputOptimization?.autoSend ?? false;

          // 如果启用了口语优化，调用模型整理文本
          if (shouldRefine) {
            try {
              setIsRefining(true);
              const { refineVoiceText } = await import("@/ai/voice-text-refine");
              const refinedText = await refineVoiceText(text);
              if (refinedText.trim()) {
                text = refinedText.trim();
              }
            } catch (err) {
              console.warn("文本整理失败，使用原始识别结果", err);
              // 整理失败时继续使用原始文本
            } finally {
              setIsRefining(false);
            }
          }

          // 插入文本到输入框
          if (composerRef.current) {
            composerRef.current.clear();
            composerRef.current.insertText(text);
          }

          // 如果启用了自动发送，延迟一小段时间后自动发送
          if (shouldAutoSend) {
            setTimeout(() => {
              onSend();
            }, 300); // 给用户一点时间看到文本
          }
        }

        // 删除临时文件
        if (tempPath) {
          await deleteFile(tempPath).catch((err) => console.warn("删除临时录音文件失败", err));
        }
      } catch (err) {
        console.error("语音识别失败", err);
        const message = err instanceof Error ? err.message : "语音识别失败";
        alert(message);
        // 出错时也删除临时文件
        if (tempPath) {
          const { deleteFile } = await import("@/lib/electron/electron-api");
          await deleteFile(tempPath).catch(() => {});
        }
      } finally {
        setIsTranscribing(false);
      }
    } else {
      // 开始录音
      await audioRecorder.startRecording();
    }
  };

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

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* "/" 技能选择 + "@" 添加文件 */}
            <ComposerToolbar onPickSkill={onPickSkill} onPickFile={onPickFile} />

            {/* 知识库多选 */}
            <KnowledgeBaseSelector
              selectedIds={knowledgeBaseIds}
              onChange={onKnowledgeChange}
            />

            <PermissionModeMenu
              mode={permissionMode}
              onChange={onPermissionModeChange}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={
                    breakpoint === "narrow"
                      ? "size-7 justify-center rounded-md p-0 bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                      : `h-7 min-w-0 ${dirButtonMaxWidth} gap-1.5 bg-muted/50 px-2 text-xs text-foreground/70 hover:bg-muted hover:text-foreground transition-colors`
                  }
                  onClick={onPickDir}
                  type="button"
                  variant="ghost"
                >
                  <FolderOpen className={breakpoint === "narrow" ? "size-4" : "size-3.5 shrink-0"} />
                  {breakpoint !== "narrow" ? <span className="truncate">{dirLabel}</span> : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{workingDir || "选择工作目录"}</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-2">
            {isResponding ? (
              <IconButton label="停止" onClick={onAbort}>
                <SquareIcon className="size-4 fill-current" />
              </IconButton>
            ) : null}
            {!isResponding && (
              <Button
                onClick={() => void handleToggleRecording()}
                disabled={isTranscribing || isRefining}
                size={audioRecorder.isRecording || isTranscribing || isRefining ? "sm" : "icon"}
                className={
                  audioRecorder.isRecording || isTranscribing || isRefining
                    ? "h-8 min-w-[80px] gap-1.5 rounded-full px-3"
                    : "size-8 rounded-full"
                }
                variant="default"
                type="button"
              >
                {audioRecorder.isRecording ? (
                  <>
                    <AudioLines animate loop size={16} />
                    <span className="text-xs">{audioRecorder.duration}s</span>
                  </>
                ) : isRefining ? (
                  <>
                    <AudioLines animate loop size={16} />
                    <span className="text-xs">优化中</span>
                  </>
                ) : isTranscribing ? (
                  <>
                    <AudioLines animate loop size={16} />
                    <span className="text-xs">转换中</span>
                  </>
                ) : (
                  <AudioLines size={16} />
                )}
                <span className="sr-only">
                  {audioRecorder.isRecording ? "录音中" : isRefining ? "优化中" : isTranscribing ? "转换中" : "开始录音"}
                </span>
              </Button>
            )}
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
