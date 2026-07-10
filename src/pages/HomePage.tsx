// 首页：新对话入口（任务输入框 + Agent 选择 + 工作目录）
// src/pages/HomePage.tsx

import { ChevronDown, FolderOpen, SendHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { promptAgent } from "@/ai/agent";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
import { PermissionModeMenu } from "@/components/chat/PermissionModeMenu";
import { KnowledgeBaseSelector } from "@/components/knowledge";
import { VoiceRecordButton } from "@/components/chat/VoiceRecordButton";
import { IconButton } from "@/components/IconButton";
import {
  SkillComposerInput,
  type SkillComposerHandle,
} from "@/components/skill/SkillComposerInput";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { checkProviderConfig } from "@/lib/app-init";
import {
  ensureSessionFilesDir,
  getSessionFilesDir,
  setSessionWorkingDir,
} from "@/lib/session/personal";
import { materializeAttachments } from "@/lib/session/attachment-files";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import { buildSkillRefs } from "@/lib/chat";
import type { ChatAttachment, ChatSkillRef, MessageFinishMetadata, Segment } from "@/lib/chat";
import { useChatStore } from "@/stores/chat-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import type { AgentConfig } from "@/types/config";
import { useAlert } from "@/hooks/useAlert";
import { useResponsiveWidth } from "@/hooks/useResponsiveWidth";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";

const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

export function HomePage({
  activeAgentId,
  agents,
  applyStreamingUpdate,
  composer,
  createThread,
  failAssistant,
  finishAssistant,
  setRetryAttempt,
  setActiveAgent,
  setComposer,
  startExchange,
}: {
  activeAgentId: string;
  agents: AgentConfig[];
  applyStreamingUpdate: (
    threadId: string,
    messageId: string,
    update: { appendDelta?: string; segments?: Segment[] },
  ) => void;
  composer: string;
  createThread: (
    agentId?: string,
    initialText?: string,
    permissionMode?: ToolPermissionMode,
  ) => string;
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: MessageFinishMetadata,
  ) => void;
  setRetryAttempt: (threadId: string, messageId: string, attempt: number) => void;
  setActiveAgent: (agentId: string) => void;
  setComposer: (value: string) => void;
  startExchange: (
    userText: string,
    attachments?: ChatAttachment[],
    skillRefs?: ChatSkillRef[],
  ) => {
    assistantId: string;
    threadId: string;
  };
}) {
  const { t } = useTranslation();
  const activeAgent =
    agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const workingDir = useChatStore((state) => state.workingDir);
  const setWorkingDir = useChatStore((state) => state.setWorkingDir);
  const skills = useSkillsStore((state) => state.skills);

  const [permissionMode, setPermissionMode] = useState<ToolPermissionMode>(
    DEFAULT_TOOL_PERMISSION_MODE,
  );
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);

  // 富文本输入区句柄；本次发送临时选中的技能 id / 文件路径（输入框 "/" 与 "@"）
  const composerRef = useRef<SkillComposerHandle>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // 自定义对话框
  const { alert: showAlert, AlertDialog } = useAlert();
  // 响应式宽度断点
  const breakpoint = useResponsiveWidth();

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) {
      setWorkingDir(dir);
    }
  };

  const handleVoiceTranscription = (text: string, shouldAutoSend: boolean) => {
    // 插入文本到输入框
    if (composerRef.current) {
      composerRef.current.clear();
      composerRef.current.insertText(text);
    }

    // 如果启用了自动发送，延迟一小段时间后自动发送
    if (shouldAutoSend) {
      setTimeout(() => {
        void handleSend();
      }, 300); // 给用户一点时间看到文本
    }
  };

  const handleSend = async () => {
    const input = composer.trim();
    if (!input && attachments.length === 0) {
      return;
    }

    const providerCheck = checkProviderConfig();
    if (!providerCheck.isConfigured) {
      await showAlert({
        title: t("home:alertNoModel"),
        message: providerCheck.message,
        variant: "warning",
      });
      return;
    }

    createThread(activeAgent?.id, undefined, permissionMode);
    const pendingAttachments = attachments;
    // 捕获本次技能 / 文件后清空输入区（富文本 + 技能 chip + 文件 chip）
    const sendSkillIds = skillIds;
    const sendSkillRefs = buildSkillRefs(sendSkillIds, skills);

    const threadId = useChatStore.getState().activeThreadId;

    // 设置知识库
    useChatStore.getState().setThreadKnowledgeBaseIds(threadId, knowledgeBaseIds);

    let workingDir = useChatStore.getState().workingDir || undefined;
    if (!workingDir) {
      workingDir = await getSessionFilesDir(threadId);
      await ensureSessionFilesDir(threadId);
    }
    const sendAttachments = await materializeAttachments(pendingAttachments, workingDir);
    const sendFilePaths = sendAttachments
      .filter((attachment) => attachment.kind === "text")
      .map((attachment) => attachment.path);
    const { assistantId } = startExchange(input, sendAttachments, sendSkillRefs);
    composerRef.current?.clear();
    setComposer("");
    setSkillIds([]);
    setAttachments([]);

    useTaskMonitorStore.getState().setWorkingDir(threadId, workingDir);
    // 持久化到新会话 meta，使重开/切回该对话能恢复其工作目录
    void setSessionWorkingDir(threadId, workingDir);

    // 后台运行：不 await，切换会话/页面后该会话继续运行
    void promptAgent(
      input,
      {
        onStreamUpdate: (update) =>
          applyStreamingUpdate(threadId, assistantId, update),
        onDone: ({ content, model, usage, contextTokens, segments }) =>
          finishAssistant(threadId, assistantId, content, {
            model,
            tokenCount: usage.totalTokens,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            contextTokens,
            segments,
          }),
        onError: (message) => failAssistant(threadId, assistantId, message),
        onRetry: (attempt) => setRetryAttempt(threadId, assistantId, attempt),
      },
      activeAgent?.id || activeAgentId,
      {
        threadId,
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
      <section className="flex h-full min-w-0 items-center justify-center px-6 pb-20">
        <div className="w-full max-w-[900px]">
        <div className="mb-8">
          <img
            src={logoUrl}
            alt="PolarAgent"
            className="mb-6 size-14 object-contain"
          />
          <h1 className="text-3xl font-semibold tracking-normal">
            {t("home:heading")}
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            {t("home:subheading")}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-[0_18px_70px_rgba(31,35,31,0.1)]">
          <SkillComposerInput
            ref={composerRef}
            value={composer}
            onChange={setComposer}
            onSkillsChange={setSkillIds}
            onFilesChange={setAttachments}
            onEnter={() => void handleSend()}
            placeholder={t("home:placeholder")}
            className="app-scrollbar max-h-[240px] min-h-[96px] overflow-y-auto px-5 py-4 text-base"
          />
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              {/* "/" 技能选择 + "@" 添加文件 */}
              <ComposerToolbar
                onPickSkill={(skill) => composerRef.current?.insertSkill(skill)}
                onPickFile={(file) => composerRef.current?.insertFile(file)}
              />

              {/* 知识库多选 */}
              <KnowledgeBaseSelector
                selectedIds={knowledgeBaseIds}
                onChange={setKnowledgeBaseIds}
              />

              <PermissionModeMenu
                mode={permissionMode}
                onChange={setPermissionMode}
              />

              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={
                          breakpoint === "narrow"
                            ? "size-7 justify-center p-0 rounded-md bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                            : "h-7 gap-1 bg-muted/50 px-2 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                        }
                      >
                        <span className={breakpoint === "narrow" ? "text-base leading-none" : "text-sm leading-none"}>
                          {activeAgent?.avatar || "⚡"}
                        </span>
                        {breakpoint !== "narrow" ? (
                          <span className="text-sm">{activeAgent?.name || t("home:defaultAgent")}</span>
                        ) : null}
                        {breakpoint !== "narrow" ? <ChevronDown className="size-3" /> : null}
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{activeAgent?.name || t("home:defaultAgent")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-56">
                  {agents.length > 0 ? (
                    agents.map((agent) => (
                      <Tooltip key={agent.id}>
                        <TooltipTrigger asChild>
                          <DropdownMenuItem
                            onSelect={() => setActiveAgent(agent.id)}
                          >
                            <span className="text-base leading-none">
                              {agent.avatar || "⚡"}
                            </span>
                            <span className="truncate">{agent.name}</span>
                          </DropdownMenuItem>
                        </TooltipTrigger>
                        {agent.description ? (
                          <TooltipContent side="right" className="max-w-xs">
                            {agent.description}
                          </TooltipContent>
                        ) : null}
                      </Tooltip>
                    ))
                  ) : (
                    <DropdownMenuItem disabled>{t("home:noAgents")}</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <VoiceRecordButton onTranscriptionComplete={handleVoiceTranscription} />
              <IconButton
                className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                label={t("common:send")}
                onClick={() => void handleSend()}
              >
                <SendHorizontal className="size-4" />
              </IconButton>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handlePickDir()}
          className="mt-4 flex max-w-full items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="truncate">
            {workingDir ? workingDir : t("home:selectDirectory")}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
        </div>
      </section>
      <AlertDialog />
    </>
  );
}
