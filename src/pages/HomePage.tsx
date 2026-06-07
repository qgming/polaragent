// 首页：新对话入口（任务输入框 + Agent 选择 + 工作目录）
// src/pages/HomePage.tsx

import { ChevronDown, FolderOpen, SendHorizontal } from "lucide-react";
import { useRef, useState } from "react";

import { promptAgent } from "@/ai/agent";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
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
import { checkProviderConfig } from "@/lib/app-init";
import { setSessionWorkingDir } from "@/lib/session/session-operations";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import { type Segment, useChatStore } from "@/stores/chat-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import type { AgentConfig } from "@/types/config";
import { useAlert } from "@/hooks/useAlert";

const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

export function HomePage({
  activeAgentId,
  agents,
  applyStreamingUpdate,
  composer,
  createThread,
  failAssistant,
  finishAssistant,
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
  createThread: (agentId?: string, initialText?: string) => string;
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: { model?: string; tokenCount?: number; segments?: Segment[] },
  ) => void;
  setActiveAgent: (agentId: string) => void;
  setComposer: (value: string) => void;
  startExchange: (userText: string) => {
    assistantId: string;
    threadId: string;
  };
}) {
  const activeAgent =
    agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const workingDir = useChatStore((state) => state.workingDir);
  const setWorkingDir = useChatStore((state) => state.setWorkingDir);

  // 富文本输入区句柄；本次发送临时选中的技能 id / 文件路径（输入框 "/" 与 "@"）
  const composerRef = useRef<SkillComposerHandle>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  // 自定义对话框
  const { alert: showAlert, AlertDialog } = useAlert();

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) {
      setWorkingDir(dir);
    }
  };

  const handleSend = async () => {
    const input = composer.trim();
    if (!input) {
      return;
    }

    const providerCheck = checkProviderConfig();
    if (!providerCheck.isConfigured) {
      await showAlert({
        title: "未配置模型",
        message: providerCheck.message,
        variant: "warning",
      });
      return;
    }

    createThread(activeAgent?.id);
    const { assistantId, threadId } = startExchange(input);
    // 捕获本次技能 / 文件后清空输入区（富文本 + 技能 chip + 文件 chip）
    const sendSkillIds = skillIds;
    const sendFilePaths = filePaths;
    composerRef.current?.clear();
    setComposer("");
    setSkillIds([]);
    setFilePaths([]);

    const workingDir = useChatStore.getState().workingDir || undefined;
    if (workingDir) {
      useTaskMonitorStore.getState().setWorkingDir(threadId, workingDir);
      // 持久化到新会话 meta，使重开/切回该对话能恢复其工作目录
      void setSessionWorkingDir(threadId, workingDir);
    }

    // 后台运行：不 await，切换会话/页面后该会话继续运行
    void promptAgent(
      input,
      {
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
      activeAgent?.id || activeAgentId,
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
            不止聊天，搞定一切
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            本地运行、自主规划、安全可控的 AI 工作搭子
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-[0_18px_70px_rgba(31,35,31,0.1)]">
          <SkillComposerInput
            ref={composerRef}
            value={composer}
            onChange={setComposer}
            onSkillsChange={setSkillIds}
            onFilesChange={setFilePaths}
            onEnter={() => void handleSend()}
            placeholder="描述任务，/ 快捷调用，@ 添加文件"
            className="min-h-[96px] px-5 py-4 text-base"
          />
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              {/* "/" 技能选择 + "@" 添加文件，在助手选择左侧 */}
              <ComposerToolbar
                onPickSkill={(skill) => composerRef.current?.insertSkill(skill)}
                onPickFile={(file) => composerRef.current?.insertFile(file)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="bg-muted/50"
                  >
                    <span className="text-base leading-none">
                      {activeAgent?.avatar || "⚡"}
                    </span>
                    {activeAgent?.name || "默认助手"}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {agents.length > 0 ? (
                    agents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.id}
                        onSelect={() => setActiveAgent(agent.id)}
                      >
                        <span className="text-base leading-none">
                          {agent.avatar || "⚡"}
                        </span>
                        <span className="truncate">{agent.name}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem disabled>暂无助手</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                className="size-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                label="发送"
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
            {workingDir ? workingDir : "选择工作目录"}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
        </div>
      </section>
      <AlertDialog />
    </>
  );
}
