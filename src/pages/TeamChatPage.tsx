// 团队聊天页：多成员协作对话（与 ChatPage 不一致——每条消息显示发言成员 emoji+名称，
// 顶部可切换该团队的多个会话，输入区可点击成员 chip 插入 @名称）
// src/pages/TeamChatPage.tsx

import {
  ChevronRight,
  FolderOpen,
  ListTree,
  SendHorizontal,
  Square as SquareIcon,
  Users,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";

import { abortTeamThread, promptTeam } from "@/ai/team";
import {
  ThinkingRow,
  ToolStepItem,
  ToolStepsRow,
  type ToolSeg,
} from "@/components/chat/AgentTrace";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
import { IconButton } from "@/components/IconButton";
import { MarkdownContent } from "@/components/markdown/MarkdownContent";
import { TeamMonitorPanel } from "@/components/team/TeamMonitorPanel";
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
import { cn } from "@/lib/utils";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import { getTeamSessionFilesDir } from "@/lib/session/session-operations";
import { useConfigStore } from "@/stores/config-store";
import { type Segment } from "@/stores/chat-store";
import {
  useIsTeamThreadResponding,
  useTeamChatStore,
  useTeamThreadMessages,
  type TeamMessage,
} from "@/stores/team/team-chat-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useTeamPanelStore } from "@/stores/team/team-panel-store";
import { useAlert } from "@/hooks/useAlert";

export function TeamChatPage({
  teamId,
  threadId,
}: {
  teamId: string;
  threadId: string;
}) {
  const team = useTeamsStore((state) => state.teams.find((t) => t.id === teamId));
  const agents = useConfigStore((state) => state.agents);
  const messages = useTeamThreadMessages(threadId);
  const visibleMessages = useMemo(
    () => messages.filter((message) => !message.vote),
    [messages],
  );
  const emptyHint =
    team?.mode === "leader"
      ? "领导会调度成员协作完成"
      : team?.mode === "parallel"
        ? "多个成员会同时处理并由领导汇总"
        : "成员会平等发散并用控制工具交接";
  const isResponding = useIsTeamThreadResponding(threadId);
  const composer = useTeamChatStore((state) => state.composer);
  const setComposer = useTeamChatStore((state) => state.setComposer);

  // 面板开合状态
  const panelOpen = useTeamPanelStore((state) =>
    state.openByThread[threadId] ?? false
  );

  // 当前会话工作目录（会话级；空则回退团队配置目录）
  const threadWorkingDir = useTeamChatStore(
    (state) => state.threads.find((t) => t.id === threadId)?.workingDir,
  );
  const setTeamThreadWorkingDir = useTeamChatStore(
    (state) => state.setTeamThreadWorkingDir,
  );
  const loadTeamThreadWorkingDir = useTeamChatStore(
    (state) => state.loadTeamThreadWorkingDir,
  );
  // 显示用：会话级目录优先，回退团队配置目录
  const workingDir = threadWorkingDir || team?.workspaceDir || "";

  // 团队会话文件目录路径（用于右侧面板显示）
  const [sessionFilesDir, setSessionFilesDir] = useState<string>("");

  // 获取团队会话文件目录路径
  useEffect(() => {
    void (async () => {
      const dir = await getTeamSessionFilesDir(threadId);
      setSessionFilesDir(dir);
    })();
  }, [threadId]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // 自定义对话框
  const { alert: showAlert, AlertDialog } = useAlert();

  // 进入会话时回读其绑定的工作目录
  useEffect(() => {
    void loadTeamThreadWorkingDir(threadId);
  }, [threadId, loadTeamThreadWorkingDir]);

  // 成员展示信息：agentId -> { avatar, name }
  const memberInfo = useMemo(() => {
    const map = new Map<string, { avatar: string; name: string }>();
    for (const id of team?.memberIds ?? []) {
      const agent = agents.find((a) => a.id === id);
      if (agent) {
        map.set(id, { avatar: agent.avatar || "⚡", name: agent.name });
      }
    }
    return map;
  }, [team?.memberIds, agents]);

  // 滚动跟随
  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element) return;
    const handleScroll = () => {
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      stickToBottomRef.current = distance < 80;
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => element.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages, isResponding]);

  const handleSend = async () => {
    const input = composer.trim();
    const running = useTeamChatStore
      .getState()
      .runningThreadIds.includes(threadId);
    if (!input || isResponding || running || !threadId) return;

    const providerCheck = checkProviderConfig();
    if (!providerCheck.isConfigured) {
      await showAlert({
        title: "未配置模型",
        message: providerCheck.message,
        variant: "warning",
      });
      return;
    }

    setComposer("");
    // 后台运行团队编排循环，不阻塞 UI
    void promptTeam(threadId, input);
  };

  // 点击成员菜单项：把 @名称 插入输入框末尾
  const insertMention = (name: string) => {
    const next = composer ? `${composer.trimEnd()} @${name} ` : `@${name} `;
    setComposer(next);
  };

  // 选择工作目录：绑定到当前团队会话（团队协作都在该目录下进行）
  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) setTeamThreadWorkingDir(threadId, dir);
  };

  return (
    <>
      <div className="flex h-full min-w-0">
        <section className="relative flex h-full min-w-0 flex-1 flex-col">
          <TeamHeader
            teamName={team?.name ?? "团队"}
            teamAvatar={team?.avatar ?? "👥"}
          />

          <div
            ref={scrollAreaRef}
            className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-4 pb-48 pt-8 sm:px-8">
              {visibleMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center pt-24 text-center text-sm text-muted-foreground">
                  <Users className="mb-3 size-8" />
                  向团队发起任务，{emptyHint}。
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <TeamMessageView
                    key={message.id}
                    message={message}
                    memberInfo={memberInfo}
                  />
                ))
              )}
            </div>
          </div>

          <Composer
            members={(team?.memberIds ?? [])
              .map((id) => memberInfo.get(id))
              .filter((m): m is { avatar: string; name: string } => !!m)}
            isResponding={isResponding}
            workingDir={workingDir}
            sessionFilesDir={sessionFilesDir}
            onAbort={() => abortTeamThread(threadId)}
            onInsertMention={insertMention}
            onPickDir={() => void handlePickDir()}
            onSend={handleSend}
            setValue={setComposer}
            value={composer}
          />
        </section>

        <AnimatePresence initial={false}>
          {panelOpen ? (
            <TeamMonitorPanel
              key="team-monitor-panel"
              threadId={threadId}
              teamId={teamId}
              sessionFilesDir={sessionFilesDir}
            />
          ) : null}
        </AnimatePresence>
      </div>
      <AlertDialog />
    </>
  );
}

function TeamHeader({
  teamName,
  teamAvatar,
}: {
  teamName: string;
  teamAvatar: string;
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center bg-background px-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-base leading-none">{teamAvatar}</span>
        <h1 className="min-w-0 truncate text-sm font-medium">{teamName}</h1>
      </div>
    </header>
  );
}

const TeamMessageView = memo(function TeamMessageView({
  message,
  memberInfo,
}: {
  message: TeamMessage;
  memberInfo: Map<string, { avatar: string; name: string }>;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-foreground shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  const info = message.speakerAgentId
    ? memberInfo.get(message.speakerAgentId)
    : undefined;

  return (
    <article className="max-w-[740px] text-sm leading-7 text-foreground">
      <div className="mb-3 flex items-center gap-2.5 text-sm text-muted-foreground">
        <span className="text-2xl leading-none">{info?.avatar ?? "🤖"}</span>
        <span className="font-semibold text-foreground">
          {info?.name ?? "成员"}
        </span>
        {message.status === "streaming" ? (
          <span className="ml-1 text-xs text-accent-foreground">发言中…</span>
        ) : null}
      </div>
      {message.status === "error" ? (
        <div className="whitespace-pre-wrap text-destructive">
          {message.content || " "}
        </div>
      ) : message.segments && message.segments.length > 0 ? (
        <FlatSegments
          segments={message.segments}
          streaming={message.status === "streaming"}
        />
      ) : (
        <MarkdownContent
          content={message.content}
          streaming={message.status === "streaming"}
        />
      )}
    </article>
  );
});

// 扁平渲染：正文正常展开；正文之间连续出现的 thinking/tool 过程段合并成过程组。
// 过程组超过 3 条才整体折叠，少量过程仍按原来的折叠行直接显示。
function FlatSegments({
  segments,
  streaming = false,
}: {
  segments: Segment[];
  streaming?: boolean;
}) {
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
      {groupProcessBlocks(blocks).map((block, index) => {
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
        if (block.type === "process") {
          return <ProcessFold key={`process-${index}`} blocks={block.blocks} />;
        }
        return <ToolStepsRow key={`tools-${index}`} tools={block.tools} />;
      })}
    </div>
  );
}

type SegmentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tools"; tools: ToolSeg[] };

type RenderBlock =
  | SegmentBlock
  | { type: "process"; blocks: Array<Exclude<SegmentBlock, { type: "text" }>> };

function processBlockCount(
  blocks: Array<Exclude<SegmentBlock, { type: "text" }>>,
): number {
  return blocks.reduce(
    (count, block) => count + (block.type === "tools" ? block.tools.length : 1),
    0,
  );
}

function groupProcessBlocks(blocks: SegmentBlock[]): RenderBlock[] {
  const grouped: RenderBlock[] = [];
  let pending: Array<Exclude<SegmentBlock, { type: "text" }>> = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (processBlockCount(pending) > 3) {
      grouped.push({ type: "process", blocks: pending });
    } else {
      grouped.push(...pending);
    }
    pending = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      flush();
      grouped.push(block);
    } else {
      pending.push(block);
    }
  }
  flush();

  return grouped;
}

function ProcessFold({
  blocks,
}: {
  blocks: Array<Exclude<SegmentBlock, { type: "text" }>>;
}) {
  const [open, setOpen] = useState(false);
  const count = processBlockCount(blocks);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListTree className="size-4 shrink-0" />
        <span>查看 {count} 个过程</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open ? (
        <div className="ml-6 space-y-1 border-l border-border py-1 pl-3">
          {blocks.flatMap((block, index) =>
            block.type === "thinking"
              ? [<ThinkingRow key={`thinking-${index}`} text={block.text} />]
              : block.tools.map((tool) => (
                  <ToolStepItem key={tool.toolCallId} tool={tool} />
                )),
          )}
        </div>
      ) : null}
    </div>
  );
}

function Composer({
  members,
  isResponding,
  workingDir,
  sessionFilesDir,
  onAbort,
  onInsertMention,
  onPickDir,
  onSend,
  setValue,
  value,
}: {
  members: Array<{ avatar: string; name: string }>;
  isResponding: boolean;
  workingDir: string;
  sessionFilesDir: string;
  onAbort: () => void;
  onInsertMention: (name: string) => void;
  onPickDir: () => void;
  onSend: () => void;
  setValue: (value: string) => void;
  value: string;
}) {
  const canSend = value.trim().length > 0 && !isResponding;
  // 工作目录仅显示末级名称，hover 看完整路径
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
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="描述任务，/ 调用技能，@ 添加文件，选成员指定发言"
          className="app-scrollbar max-h-[220px] min-h-[74px] w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-sm leading-6 outline-none"
        />

        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* "/" 技能 + "@" 文件，与对话页完全一致 */}
            <ComposerToolbar
              onPickSkill={(skill) => onInsertMention(skill.name)}
              onPickFile={() => undefined}
            />

            {/* 成员菜单：所有成员收进一个图标按钮，点击选成员插入 @名称 */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex size-7 items-center justify-center rounded-md bg-muted/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Users className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>选择成员（@ 指定发言）</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                className="max-h-72 w-56 overflow-y-auto"
              >
                {members.length > 0 ? (
                  members.map((member) => (
                    <DropdownMenuItem
                      key={member.name}
                      onSelect={() => onInsertMention(member.name)}
                    >
                      <span className="leading-none">{member.avatar}</span>
                      <span className="truncate">{member.name}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>暂无成员</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 工作区目录：绑定到当前团队会话 */}
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

          <div className="flex shrink-0 items-center gap-1">
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

function normalizeDir(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}
