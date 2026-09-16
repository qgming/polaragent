import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Bot, ChevronLeftIcon, Loader2Icon, Square } from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserMessageAttachments } from "@/renderer/components/assistant-ui/elements/attachment.aui";
import {
  fieldInteractive,
  mono,
  paper,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { formatDuration, formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { subscribeSubagentEvents, useSubagentStore } from "@/renderer/stores/subagent-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts/session";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { AssistantMessageParts, MessageError, UserMessageParts } from "../chat/message-parts";
import {
  SUBAGENT_SOURCE_LABEL_KEYS,
  SUBAGENT_STATUS_LABEL_KEYS,
  subagentElapsedMs,
  subagentLastSeenAt,
} from "../chat/tool-presentation";
import { PanelEmpty, PanelError } from "./panel-view";

/**
 * 子智能体：一次委派的执行详情。
 *
 * **为什么按「父会话」取数，而不是按「运行 id」**：用户从主会话里的子智能体组件点进来，
 * 他想知道的是「我这一轮派出去的那几个现在怎么样了」——所以列表是会话级的，焦点才是个体的。
 * 面板先给列表（谁在跑、谁完了），选中一条才展开它的证据链。
 *
 * **为什么详情能跨重启**：运行记录不单独建库，它挂在派发它的那次 Task 工具调用的 details 上，
 * 随父会话的转录一起落盘。所以这里的主要数据源是**转录**（subagent-store 从消息里推导），
 * 实时事件只负责把「正在跑的那些」推进到最新状态 —— 事件流只覆盖本进程的存活期。
 *
 * **为什么子会话转录按需加载**：一个父会话可能派过几十个子智能体，每个子会话的转录都不小，
 * 而用户一次只看其中一条。store 的 requestedChildren 做了幂等闸门，这里只负责在选中时请求。
 *
 * **正文与主会话同一套消息样式**：这条转录走的是同一个 assistant-ui 渲染管线
 *（见 PanelThread 的说明），所以 Markdown、代码高亮、工具卡、思考折叠看起来与主线程一致 ——
 * 面板里再长一套「面板专用」的简化样式，只会让同一件事在两处长得不一样。
 *
 * 面板头部（标题 + 返回入口列表）由 RightSidebar 渲染，所以这一屏不重复画标题行。
 */

/** 稳定的空数组：zustand v5 的 useSyncExternalStore 按引用比较，每次返回新数组会无限重渲染 */
const EMPTY_RUNS: readonly SubagentRun[] = [];
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

export function SubagentPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.messagesBySession[s.activeSessionId],
  );
  const target = useUiStore((s) => s.subagentPanelTarget);
  const openSubagentPanel = useUiStore((s) => s.openSubagentPanel);
  const clearTarget = useUiStore((s) => s.clearSubagentPanelTarget);
  const runs = useSubagentStore((s) =>
    activeSessionId === null ? undefined : s.runs[activeSessionId],
  );
  const childMessages = useSubagentStore((s) => s.childMessages);
  const [error, setError] = useState<string | null>(null);

  // 订阅是进程级的：重复挂载由 store 内部的模块级闸门挡掉，这里不做判断
  useEffect(() => {
    subscribeSubagentEvents();
  }, []);

  /**
   * 把父会话的转录交给 store 推导运行行。
   *
   * 这是「重启后还能看到历史委派」的唯一来源，所以它挂在转录上而不是挂在事件上：
   * 事件只覆盖本进程正在跑的，转录覆盖全部（含早已跑完、不在内存里的那些）。
   *
   * 依赖用**结构签名**（条数 + 末条 id + 末条 parts 数）而不是 messages 数组本身：
   * 流式期间数组每个 flush 都换引用，直接依赖会让这里跟着每个 token 全量重扫消息。
   * 转录推导只关心形状变化（新消息、新 part），正文增长与它无关。
   */
  const structureKey = `${messages?.length ?? -1}:${messages?.at(-1)?.id ?? ""}:${messages?.at(-1)?.parts.length ?? -1}`;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 结构签名才是触发条件，messages 从 ref 读最新值
  useEffect(() => {
    if (activeSessionId === null) return;
    const current = messagesRef.current;
    if (current === undefined) return;
    useSubagentStore.getState().setRunsFromTranscript(activeSessionId, current);
  }, [activeSessionId, structureKey]);

  // 转录只带当前加载的那一页，更早的委派要靠主进程的完整列表补齐（切会话再问一次）
  useEffect(() => {
    if (activeSessionId === null) return;
    setError(null);
    void useSubagentStore
      .getState()
      .refresh(activeSessionId)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  }, [activeSessionId]);

  const list = runs ?? EMPTY_RUNS;
  /**
   * 焦点行。找不到就退回列表：常见于「刚点开、转录还没推导出这一行」，
   * 此时给一屏空详情不如让用户看到列表并自己再点一次。
   */
  const selected = target === null ? undefined : list.find((run) => run.delegationId === target);
  const selectedChildId = selected?.childSessionId;

  // 选中一条才拉它的子会话转录；重复选中不会重复发 IPC（store 里有幂等闸门）
  useEffect(() => {
    if (selectedChildId === undefined) return;
    void useSubagentStore
      .getState()
      .loadChild(selectedChildId)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  }, [selectedChildId]);

  /**
   * 转录是否还在路上：store 里的 requestedChildren 是加载闸门（见 loadChild），它为 true
   * 而 childMessages 里还没有这一份，就是「正在加载」。此时显示「子会话里还没有消息」是撒谎，
   * 所以那一格单独给一行加载态，而不是一张空白卡片。
   */
  const transcriptLoading = useSubagentStore(
    (s) =>
      selectedChildId !== undefined &&
      s.childMessages[selectedChildId] === undefined &&
      s.requestedChildren[selectedChildId] === true,
  );

  // 正在跑的行才需要每秒重算耗时；没有运行中的行时不起定时器（静止的界面不该有心跳）
  const now = useRunTicker(list.some((run) => run.status === "running"));

  if (activeSessionId === null) {
    return (
      <PanelEmpty
        icon={Bot}
        title={t("rightPanel.subagentEmpty")}
        hint={t("rightPanel.subagentEmptyHint")}
      />
    );
  }

  if (selected === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {error !== null && <PanelError message={error} />}
        {list.length === 0 ? (
          <PanelEmpty
            icon={Bot}
            title={t("rightPanel.subagentEmpty")}
            hint={t("rightPanel.subagentEmptyHint")}
          />
        ) : (
          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="flex flex-col gap-2">
              {list.map((run) => (
                <RunRow
                  key={run.delegationId}
                  run={run}
                  onSelect={() => openSubagentPanel(run.delegationId)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const transcript = childMessages[selected.childSessionId] ?? EMPTY_MESSAGES;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error !== null && <PanelError message={error} />}

      {/*
        回到列表：详情是列表里的一层，所以这是面板内部的「上一层」，
        与顶栏那颗开合开关（整个收起面板）是两件事，不共用入口。
      */}
      <div className="shrink-0 px-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearTarget}
          className="text-ink-3 gap-1 px-1.5 text-[12px]"
        >
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          {t("rightPanel.back")}
        </Button>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          <RunHeader run={selected} now={now} onStop={() => void stopRun(selected)} />

          <Section title={t("rightPanel.subagentTask")}>
            <p className="text-ink-2 text-[12.5px] leading-relaxed whitespace-pre-wrap">
              {selected.task}
            </p>
          </Section>

          <Section title={t("rightPanel.subagentReport")}>
            {selected.report === undefined || selected.report === "" ? (
              <p className="text-ink-4 text-[12.5px]">{t("rightPanel.subagentNoReport")}</p>
            ) : (
              <p className="text-ink-2 text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {selected.report}
              </p>
            )}
          </Section>

          <Section title={t("rightPanel.subagentTranscript")}>
            {transcript.length === 0 ? (
              <p className="text-ink-4 text-[12.5px]">
                {transcriptLoading ? t("common.loading") : t("rightPanel.subagentTranscriptEmpty")}
              </p>
            ) : (
              /*
                字体与字号跟主线程的消息组同源（--chat-font / --chat-font-size，见 index.css）：
                面板里的 Markdown、代码块因此和主线程一样跟随「对话字号」设置；块间距同样是
                --density-gap，两条流的阅读节奏一致。消息自身的 px-2 与行高在各自的壳里。
              */
              <div
                style={{ fontFamily: "var(--chat-font)", fontSize: "var(--chat-font-size)" }}
                className="flex flex-col gap-y-(--density-gap)"
              >
                <PanelThread messages={transcript} running={selected.status === "running"} />
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/** 停一次运行。IPC 失败只记日志：真实状态由事件带回，在面板上再报一遍没有增量 */
async function stopRun(run: SubagentRun): Promise<void> {
  try {
    await useSubagentStore.getState().stop(run.sessionId, run.delegationId);
  } catch (error) {
    console.warn(`停止子智能体失败：${String(error)}`);
  }
}

/**
 * 运行中时每秒推进一次 `now`。
 *
 * 用「有没有运行中的行」当开关，而不是无条件定时：面板打开的多数时间是静止的，
 * 一个永远在跑的心跳只会让整棵树每秒白重渲染一次。意外终止不是运行中（它的耗时
 * 已经冻结在 endedAt / updatedAt 上，见 subagentElapsedMs），因此不会把定时器拉起来。
 */
function useRunTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 列表里的一行：点它把焦点移到这条运行 */
function RunRow({ run, onSelect }: { run: SubagentRun; onSelect: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        paper,
        fieldInteractive,
        "flex w-full flex-col gap-1.5 rounded-2xl px-3 py-2.5 text-start outline-none",
      )}
    >
      <span className="flex items-center gap-2">
        {/* 只有 running 是活的：interrupted 与其它终态一样走静态图标，不转圈 */}
        {run.status === "running" ? (
          <Loader2Icon className="text-ink-4 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <Bot className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="flex-1 truncate text-[13px]">{run.agentName}</span>
        <span className="text-ink-4 text-[11.5px]">
          {t(SUBAGENT_STATUS_LABEL_KEYS[run.status])}
        </span>
      </span>
      {run.description !== "" && (
        <span className="text-ink-3 line-clamp-2 text-[12px] leading-relaxed">
          {run.description}
        </span>
      )}
      <span className={cn(mono, "text-ink-4")}>
        {t("rightPanel.subagentSteps", { turns: run.turns, toolCalls: run.toolCalls })}
      </span>
    </button>
  );
}

/** 详情卡片的头部：谁、什么状态、用什么模型与工具、跑了多久，外加停止入口 */
function RunHeader({
  run,
  now,
  onStop,
}: {
  run: SubagentRun;
  now: number;
  onStop: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={cn(paper, "flex flex-col gap-2 rounded-2xl px-3 py-2.5")}>
      <div className="flex items-center gap-2">
        {run.status === "running" ? (
          <Loader2Icon className="text-ink-4 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <Bot className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="flex-1 truncate text-[13.5px]">{run.agentName}</span>
        <span className="text-ink-3 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[11px]">
          {t(SUBAGENT_SOURCE_LABEL_KEYS[run.agentSource])}
        </span>
        <span className="text-ink-3 text-[11.5px]">
          {t(SUBAGENT_STATUS_LABEL_KEYS[run.status])}
        </span>
        {/* 停止只对真正在跑的行开放：interrupted 已经不在跑了，没有可停的东西 */}
        {run.status === "running" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("rightPanel.subagentStop")}
            title={t("rightPanel.subagentStop")}
            onClick={onStop}
          >
            <Square className="size-3.5" />
          </Button>
        )}
      </div>

      <p className={cn(mono, "text-ink-4 truncate")}>
        {t("rightPanel.subagentModel")} {run.modelId}
      </p>
      <p className={cn(mono, "text-ink-4 truncate")}>
        {t("rightPanel.subagentTools")} {run.tools.length === 0 ? "—" : run.tools.join("、")}
      </p>
      <p className={cn(mono, "text-ink-4")}>
        {t("rightPanel.subagentSteps", { turns: run.turns, toolCalls: run.toolCalls })}
        {" · "}
        {t("rightPanel.subagentElapsed", { duration: formatDuration(subagentElapsedMs(run, now)) })}
      </p>

      {/*
        意外终止：结果未知，而且「要不要重跑」是主代理的决定 ——
        面板只把情况和最后被看见的时间说清楚，不给任何重启入口。
      */}
      {run.status === "interrupted" && (
        <div className="flex flex-col gap-1">
          <p className="text-ink-3 text-[11.5px] leading-relaxed">
            {t("rightPanel.subagentInterruptedNote")}
          </p>
          <p className={cn(mono, "text-ink-4")}>
            {t("rightPanel.subagentInterruptedAt", { time: formatTime(subagentLastSeenAt(run)) })}
          </p>
        </div>
      )}

      {/*
        这条运行接手了更早的一次委派（契约的 resumedFrom）。没有专门的词条，
        复用 common.retry 当标签 + 被接手的 delegationId；同样不提供「继续」按钮。
      */}
      {run.resumedFrom !== undefined && (
        <p className={cn(mono, "text-ink-4 truncate")}>
          {t("common.retry")} · {run.resumedFrom}
        </p>
      )}

      {run.error !== undefined && run.error !== "" && (
        <p className="text-destructive text-[11.5px] leading-relaxed">{run.error}</p>
      )}
    </div>
  );
}

/** 详情里的一个小节：标题 + 内容，标题用同一套小号字色 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-ink-4 text-[11.5px]">{title}</h4>
      {children}
    </section>
  );
}

/**
 * 面板运行时的「这条运行还活着」：消息壳把它交给 AssistantMessageParts 的 showRunStatus。
 * 走 context 而不是 props：消息组件由 ThreadPrimitive.Messages 按角色取用，没有地方接 props；
 * 而「还在跑 / 已结束」是整段共享的一个布尔，context 正好。
 */
const PanelRunLiveContext = createContext(false);

/**
 * 只读运行时不需要发送入口：库的类型要求 onNew 存在，这里给一个到不了的空实现
 *（面板没有 Composer，没有任何一条路径会调用 thread.append）。除此之外不挂
 * onCancel / onReload / 审批 / 提问 —— 这一屏只负责「把已经发生过的事显示出来」。
 */
async function noopSend(): Promise<void> {
  // 见上：只读视图的占位实现
}

/** 消息组件配置放在模块级：库按 components 的函数引用判断要不要重渲，每次渲染换对象是白重渲 */
const PANEL_MESSAGE_COMPONENTS = {
  UserMessage: PanelUserMessage,
  AssistantMessage: PanelAssistantMessage,
};

/**
 * 子会话转录的只读运行时：一次委派一条，常驻在面板的「执行记录」区里。
 *
 * **为什么要自己挂一个 runtime**：正文渲染件（Markdown / 代码高亮 / 工具卡 / 思考折叠）
 * 读的是 assistant-ui 的 message scope，而子会话转录属于**另一个会话** —— 主线程的 runtime
 * 里没有它（嵌套消息只挂在主线程那次 Task 调用下面，见 message-converter）。所以这里用
 * useExternalStoreRuntime 把 store 里的子转录接成一条独立线程：渲染管线与主线程完全同一套，
 * 而不是在面板里再手写一份近似样式（那样必然漂移，见 message-parts 的文件头）。
 *
 * **为什么是 memo + useMemo**：父组件订阅着父会话的转录，流式期间每个 token 都会重渲一次；
 * 这层用 memo 挡住（props 只有「一份转录数组 + 运行状态」两个稳定值），适配器对象也按这两个
 * 值记忆 —— 否则每次重渲都会被库当成一次 setAdapter，白白重转一遍整条转录。
 */
const PanelThread = memo(function PanelThread({
  messages,
  running,
}: {
  messages: readonly ChatMessage[];
  running: boolean;
}): React.JSX.Element {
  const store = useMemo(
    () => ({
      messages,
      isRunning: running,
      onNew: noopSend,
      // 子会话按契约不会再派子智能体，嵌套 resolver 不用传，工具 part 保持平铺
      convertMessage: toThreadMessage,
    }),
    [messages, running],
  );
  const runtime = useExternalStoreRuntime<ChatMessage>(store);

  return (
    <PanelRunLiveContext.Provider value={running}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Messages components={PANEL_MESSAGE_COMPONENTS} />
      </AssistantRuntimeProvider>
    </PanelRunLiveContext.Provider>
  );
});

/**
 * 面板里的一条用户消息：外壳沿用主线程 UserMessage 的排版（网格、附件、气泡），
 * 刻意去掉操作栏（复制 / 编辑）与它的 hover 容器 —— 面板是只读的证据视图，
 * 这里的「用户」是派发这次任务时写下的提示词，不该被当成可编辑的消息。
 */
function PanelUserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="grid animate-in grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />
      <div className="relative col-start-2 min-w-0">
        <div className="aui-user-message-content rounded-xl bg-muted px-4 py-2 text-foreground empty:hidden">
          <UserMessageParts />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * 面板里的一条助手消息：外壳与主线程 AssistantMessage 一致（同样的 px-2、块间距、行高），
 * 刻意去掉底部操作栏（复制 / 重新生成 / 分支）—— 那些动作作用在**当前会话**上，对一条
 * 子会话的历史消息没有意义；跨天分隔与左侧消息地图同理留在主线程。
 * 正文（状态行 / 推理 / 工具 / Markdown）与主线程共用 AssistantMessageParts。
 */
function PanelAssistantMessage(): React.JSX.Element {
  const live = useContext(PanelRunLiveContext);
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative animate-in duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="flex flex-col gap-y-(--density-gap) px-2 leading-relaxed text-foreground wrap-break-word"
      >
        <AssistantMessageParts showRunStatus={live} />
        <MessageError />
      </div>
    </MessagePrimitive.Root>
  );
}
