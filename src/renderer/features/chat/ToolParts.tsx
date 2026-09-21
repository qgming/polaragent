"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useAssistantToolUI, useAuiState } from "@assistant-ui/react";
import {
  BellRingIcon,
  Bot,
  CameraIcon,
  ChevronRightIcon,
  CloudDownloadIcon,
  CodeIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  HistoryIcon,
  ListIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleQuestion,
  MousePointerClickIcon,
  NetworkIcon,
  PenLineIcon,
  RocketIcon,
  ScanEyeIcon,
  ScrollTextIcon,
  SearchIcon,
  SquareIcon,
  SquarePenIcon,
  TerminalIcon,
  TextSearchIcon,
  TimerIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentState,
  AgentStatusList,
  type StatusStep,
} from "@/renderer/components/assistant-ui/elements/agent-status";
import { CodeDiff } from "@/renderer/components/assistant-ui/elements/code-diff";
import { MarkdownBlock } from "@/renderer/components/assistant-ui/elements/markdown-text";
import { mono, paper } from "@/renderer/components/assistant-ui/elements/surfaces";
import { TerminalBlock } from "@/renderer/components/assistant-ui/elements/terminal-block";
import { type TodoItem, TodoList } from "@/renderer/components/assistant-ui/elements/todo-list";
import { ToolCall } from "@/renderer/components/assistant-ui/elements/tool-call";
import {
  type TimelineStep,
  ToolTimeline,
} from "@/renderer/components/assistant-ui/elements/tool-timeline";
import { Button } from "@/renderer/components/ui/button";
import { formatDuration } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import {
  SUBAGENT_TOOL_NAMES,
  subscribeSubagentEvents,
  useSubagentStore,
} from "@/renderer/stores/subagent-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { JobInfo, JobStatus as JobStatusValue } from "@/shared/contracts/job";
import type { SubagentRun, SubagentRunStatus } from "@/shared/contracts/subagent";
import {
  bashCommand,
  bashOutput,
  type EditDiff,
  JOB_TOOL_NAMES,
  type JobDetailData,
  jobElapsedMs,
  parseJobDetail,
  resolveToolDetail,
  SUBAGENT_STATUS_LABEL_KEYS,
  type SubagentDetailData,
  subagentElapsedMs,
  type ToolDetail,
  type ToolRow,
  toolChip,
  toolResultText,
  toolRows,
} from "./tool-presentation";

/** 工具名 → 图标；未登记的一律用终端图标 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  write: SquarePenIcon,
  edit: PenLineIcon,
  grep: TextSearchIcon,
  glob: FileSearchIcon,
  todo: ListTodoIcon,
  ask_user: MessageCircleQuestion,
  // 后台作业四件套：起进程 / 读输出 / 列清单 / 停掉
  bash_background: RocketIcon,
  job_output: ScrollTextIcon,
  job_list: ListIcon,
  job_kill: SquareIcon,
  // 浏览器九件套：打开 / 历史 / 读页面 / 动作（点击·输入·按键·悬停·下拉·滚动）/ 等待 /
  // 截图 / 日志（控制台·网络）/ 弹窗策略 / 执行脚本
  browser_open: GlobeIcon,
  browser_history: HistoryIcon,
  browser_snapshot: ScanEyeIcon,
  browser_act: MousePointerClickIcon,
  browser_screenshot: CameraIcon,
  browser_logs: ScrollTextIcon,
  browser_evaluate: CodeIcon,
  browser_wait: TimerIcon,
  browser_dialog: BellRingIcon,
  // 网络工具：检索（SearchIcon）/ 抓取（CloudDownloadIcon）
  web_search: SearchIcon,
  web_fetch: CloudDownloadIcon,
  // 子智能体四件套：委派 / 等它 / 列一下 / 停掉（与主进程 tools.ts 的 Task 系列一一对应）
  Task: Bot,
  TaskWait: NetworkIcon,
  TaskList: ListIcon,
  TaskStop: SquareIcon,
};

const DEFAULT_ICON = TerminalIcon;

/** 工具名 → 词条键（收尾态 / 进行态）；未登记的工具落到通用「调用」 */
const TOOL_LABELS: Record<string, { resting: string; active: string }> = {
  bash: { resting: "tools.bash", active: "tools.bashActive" },
  read: { resting: "tools.read", active: "tools.readActive" },
  write: { resting: "tools.write", active: "tools.writeActive" },
  edit: { resting: "tools.edit", active: "tools.editActive" },
  grep: { resting: "tools.grep", active: "tools.grepActive" },
  glob: { resting: "tools.glob", active: "tools.globActive" },
  todo: { resting: "tools.todo", active: "tools.todoActive" },
  ask_user: { resting: "tools.askUser", active: "tools.askUserActive" },
  bash_background: { resting: "tools.bashBackground", active: "tools.bashBackgroundActive" },
  job_output: { resting: "tools.jobOutput", active: "tools.jobOutputActive" },
  job_list: { resting: "tools.jobList", active: "tools.jobListActive" },
  job_kill: { resting: "tools.jobKill", active: "tools.jobKillActive" },
  // 浏览器九件套（词条见 locales 的 tools.browser*）
  browser_open: { resting: "tools.browserOpen", active: "tools.browserOpenActive" },
  browser_history: { resting: "tools.browserHistory", active: "tools.browserHistoryActive" },
  browser_snapshot: { resting: "tools.browserSnapshot", active: "tools.browserSnapshotActive" },
  browser_act: { resting: "tools.browserAction", active: "tools.browserActionActive" },
  browser_wait: { resting: "tools.browserWait", active: "tools.browserWaitActive" },
  browser_screenshot: {
    resting: "tools.browserScreenshot",
    active: "tools.browserScreenshotActive",
  },
  browser_logs: { resting: "tools.browserLogs", active: "tools.browserLogsActive" },
  browser_dialog: { resting: "tools.browserDialog", active: "tools.browserDialogActive" },
  browser_evaluate: { resting: "tools.browserEvaluate", active: "tools.browserEvaluateActive" },
  // 网络工具（词条见 locales 的 tools.webSearch* / tools.webFetch*）
  web_search: { resting: "tools.webSearch", active: "tools.webSearchActive" },
  web_fetch: { resting: "tools.webFetch", active: "tools.webFetchActive" },
  // 子智能体四件套（词条见 locales 的 tools.task*）
  Task: { resting: "tools.task", active: "tools.taskActive" },
  TaskWait: { resting: "tools.taskWait", active: "tools.taskWaitActive" },
  TaskList: { resting: "tools.taskList", active: "tools.taskListActive" },
  TaskStop: { resting: "tools.taskStop", active: "tools.taskStopActive" },
};

const FALLBACK_LABELS = { resting: "tools.call", active: "tools.callActive" };

/** 工具名 → 词条键；未登记的工具落到通用「调用」 */
export function toolLabelKeys(toolName: string): { resting: string; active: string } {
  return TOOL_LABELS[toolName] ?? FALLBACK_LABELS;
}

/** 工具进行态的词条键；给消息尾部的运行指示器复用 */
export function toolActiveLabelKey(toolName: string): string {
  return toolLabelKeys(toolName).active;
}

/** bash 的详情：命令作标题、末尾输出作正文、运行中转圈、完成打勾 */
function TerminalDetail({
  args,
  result,
  running,
}: {
  args: unknown;
  result: unknown;
  running: boolean;
}) {
  const { t } = useTranslation();
  const { lines, omitted } = useMemo(() => bashOutput(result), [result]);
  const shown = useMemo(
    () => (omitted > 0 ? [t("tools.bashLinesOmitted", { count: omitted }), ...lines] : lines),
    [lines, omitted, t],
  );

  return (
    <TerminalBlock
      command={bashCommand(args)}
      lines={shown}
      visibleCount={shown.length}
      done={!running}
    />
  );
}

/** edit 的详情：文件名 + 增减行数 + 逐行 diff */
function DiffDetail({ diff }: { diff: EditDiff }) {
  const { t } = useTranslation();
  const lines = useMemo(
    () =>
      diff.omitted > 0
        ? [
            ...diff.lines,
            {
              kind: "context" as const,
              text: t("tools.diffLinesOmitted", { count: diff.omitted }),
            },
          ]
        : diff.lines,
    [diff, t],
  );

  return (
    <CodeDiff
      filename={diff.filename}
      additions={diff.additions}
      deletions={diff.deletions}
      lines={lines}
      cycle={0}
    />
  );
}

/** todo 清单：与 TerminalBlock / CodeDiff 一样自带 paper 面与圆角，工具流里各详情外观保持一致 */
function TodoDetail({ items, revision }: { items: TodoItem[]; revision?: number }) {
  const { t } = useTranslation();
  return (
    <div className={cn(paper, "w-full overflow-hidden rounded-2xl p-3")}>
      <TodoList items={items} revision={revision} title={t("chat.todos")} />
    </div>
  );
}

/**
 * web_search 的来源列表卡片。
 *
 * 为什么值得一张专门的卡（而不是落回内置的 request/result 文本面板）：
 * 搜索结果的价值在**标题 + 域名 + 摘要**这三者的对应关系上，
 * 纯文本里它们被拼成一行 markdown 链接，用户要自己从 URL 里读域名去判断可信度。
 * 这里把 hostname 单独提出来（`text-ink-4` 的小字），点标题即外链。
 *
 * 外链交给系统浏览器：`app/window.ts` 的导航守卫会把外链 openExternal，
 * 所以这里**不要**自己 window.open（那会被守卫拒掉）。
 */
function WebSearchDetail({ detail }: { detail: Extract<ToolDetail, { kind: "web-search" }> }) {
  const { t } = useTranslation();
  return (
    <div className={cn(paper, "w-full overflow-hidden rounded-2xl p-3")}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn(mono, "text-ink-4")}>
          {detail.provider}
          {detail.truncated ? ` · ${t("chat.webTruncated")}` : ""}
        </span>
        <span className={cn(mono, "text-ink-4")}>
          {t("chat.webSourceCount", { count: detail.sources.length })}
        </span>
      </div>

      {detail.answer === undefined ? null : (
        <div className="mt-2 border-border/60 border-l-2 pl-2.5 text-[13.5px] leading-6">
          {detail.answer}
        </div>
      )}

      <ul className="mt-2 space-y-2">
        {detail.sources.map((source) => (
          <li key={source.url} className="min-w-0">
            <a
              href={source.url}
              className="text-[13.5px] leading-5 break-words text-primary hover:text-primary/80 hover:underline"
            >
              {source.title ?? source.url}
            </a>
            <div className={cn(mono, "truncate text-ink-4")} title={source.url}>
              {hostnameOf(source.url)}
              {source.publishedAt === undefined ? "" : ` · ${source.publishedAt}`}
            </div>
            {source.snippet === undefined ? null : (
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{source.snippet}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * web_fetch 的结果卡片。
 *
 * 只显示「取了哪个 URL、返回什么状态」——**正文不在这里**：
 * 它已经在工具结果文本里（模型看的就是那份），重复渲染会让长页面在界面上再铺一遍。
 * 展开区仍然是内置的 request/result 面板。
 */
function WebFetchDetail({ detail }: { detail: Extract<ToolDetail, { kind: "web-fetch" }> }) {
  const { t } = useTranslation();
  // 非 2xx 不是错误（见工具描述），但界面上要一眼看出「这个页面没取到内容」
  const failed = detail.statusCode < 200 || detail.statusCode >= 300;
  return (
    <div className={cn(paper, "w-full overflow-hidden rounded-2xl p-3")}>
      <div className="flex items-center gap-2">
        <span
          className={cn(mono, failed ? "text-destructive" : "text-ink-4")}
          title={String(detail.statusCode)}
        >
          {t("chat.webStatus", { status: detail.statusCode })}
        </span>
        <span className={cn(mono, "truncate text-ink-4")}>{hostnameOf(detail.url)}</span>
      </div>
      <a
        href={detail.url}
        className="mt-1 block text-[13.5px] leading-5 break-words text-primary hover:text-primary/80 hover:underline"
      >
        {detail.title ?? detail.url}
      </a>
    </div>
  );
}

/** 取 URL 的 hostname；解析不了就原样返回（不要因为一个坏 URL 把卡片搞崩） */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 稳定的空数组：zustand v5 的 useSyncExternalStore 按引用比较，
 * 选择器每次返回新数组会被判定为快照变化（无限重渲染，React #185）。
 */
const EMPTY_RUNS: readonly SubagentRun[] = [];

/** 作业版的空数组：同一条纪律（见上），JobStatus 在 store 查不到时用它兜住 find */
const EMPTY_JOBS: readonly JobInfo[] = [];

/**
 * 一次子智能体委派 / 记账调用在主会话里的样子：一列 agent-status 状态 pill，**不是**工具行。
 *
 * 为什么不能套通用 ToolCall：`Task` 的主语是「一个被派出去的代理人」，不是「一条命令」。
 * 工具行回答的是「这次调用成功了吗」（动词 + 参数 chip + 展开看 request/result），
 * 而用户真正要知道的是「它在干什么、干完没有」—— 把委派读成一次普通工具调用，
 * 这个判断就被埋进了折叠面板里。于是这里整条让给 vendored 的 AgentStatus
 *（elements/agent-status 的列表形态）：一枚脉冲圆点（working）/ 空心点（waiting）/ 绿勾（done），
 * 点开才是右侧面板里的完整证据链（转录 / 报告 / 停止）。
 *
 * 委派数据来自 subagent-store（不是 props）：正在跑的委派是**会话级**的 ——
 * 同一轮里可能同时派了三个，主会话里三条 pill 显示的是同一批人，
 * 只是每条 pill 把焦点停在自己那一条上。
 */
function SubagentStatus({
  toolName,
  detail,
  running,
}: {
  toolName: string;
  detail: SubagentDetailData;
  running: boolean;
}) {
  const { t } = useTranslation();
  /**
   * 报告是否就地展开。默认收起：报告是「想看时才看」的细节，
   * 一进来就把它铺满主会话会把对话节奏冲散（见下面 pill 的注释）。
   */
  const [expanded, setExpanded] = useState(false);
  const openSubagentPanel = useUiStore((s) => s.openSubagentPanel);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  /**
   * 父会话的消息。订阅在这里的作用不是渲染：pill 一出现就说明这条运行有人在看，
   * 于是把父会话的转录交给 store 去推导运行行（并从那里按需拉子会话转录）——
   * 事件流只覆盖「本进程正在跑的」，重启后还要靠这一步把记录捞回来。
   * 选引用稳定的数组字段（messagesBySession 里那份），流式期间不额外制造快照。
   */
  const messages = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.messagesBySession[s.activeSessionId],
  );
  const sessionRuns = useSubagentStore((s) =>
    activeSessionId === null ? undefined : s.runs[activeSessionId],
  );

  useEffect(() => {
    subscribeSubagentEvents();
  }, []);

  /**
   * 消息数组在流式期间每个 flush 都会换引用（正文在长），拿它当 effect 依赖等于让
   * 下面那段「推导运行行 + 向主进程对账」跟着每个 token 跑一遍 —— 每个 Task pill
   * 都来一次，多路流并行时就是一场 subagents:runs 的 IPC 风暴（卡死的主要放大器之一）。
   *
   * 结构签名只在**形状**变化时变：条数、末条 id、末条 parts 数。Task 调用落地、新消息
   * 到达都会改变它，而正文增长不会 —— 对账语义（转录里出现了新的委派）只依赖形状。
   */
  const structureKey = `${messages?.length ?? -1}:${messages?.at(-1)?.id ?? ""}:${messages?.at(-1)?.parts.length ?? -1}`;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /**
   * 把父会话的转录交给 store 推导运行行。
   *
   * 转录只是**一路**来源，而且是重启后最不可信的那一路：`Task` 的 details 落的
   * 是派发那一刻的快照（status: running、turns: 0），此后永不更新 ——
   * 真实结局写在子会话索引里。所以紧接着必须再向主进程要一次**权威列表**
   * （refresh → subagents:runs），它的对账会把「没被确认还在跑」的行纠正成终态
   * 或 interrupted，耗时与报告也才跟着对。
   *
   * 这件事以前只有右侧栏面板做，主会话里的 pill 从没做过 ——
   * 于是重启后对话里就一直显示「运行中 · 0s」，而磁盘上的记录其实是对的。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 结构签名才是触发条件，messages 从 ref 读最新值
  useEffect(() => {
    if (activeSessionId === null) return;
    const current = messagesRef.current;
    if (current === undefined) return;
    const store = useSubagentStore.getState();
    store.setRunsFromTranscript(activeSessionId, current);
    // 拉不到时 refresh 自己会保持现状（不标记已对账），失败只记在控制台，不打断对话
    void store.refresh(activeSessionId).catch((failure: unknown) => {
      console.warn(`读取子智能体运行列表失败：${String(failure)}`);
    });
  }, [activeSessionId, structureKey]);

  /**
   * pill 显示的其实是 store 里那条**已经对过账**的行，details 只是兜底。
   *
   * details 是主进程写进转录的一份**快照**：重启后它可能还写着 running（进程已经退出、
   * 子会话索引也没了），而 store 刚用 runs() 的权威列表把这种行降级成了 interrupted。
   * 快照没有「现在」的概念，不能拿它给状态盖章。store 里查不到这条委派
   *（转录与权威列表都还没到）时才退回快照，保持原样。
   */
  const row =
    (sessionRuns ?? EMPTY_RUNS).find((item) => item.delegationId === detail.delegationId) ??
    detail.run;

  /**
   * 记账调用（TaskWait / TaskList / TaskStop）名下**没有自己的委派**：它们的 details 是
   * 一批别人的运行，`batchSize` 就是那条分界线（见 resolveToolDetail）。
   * 于是状态没有「这条委派怎么了」可映射，只能由**这次调用自己**的生命周期回答
   *（还在飞 → working，已经返回 → done）：批里那些运行的状态归各自的 Task pill 管，
   * 在这里替它们盖章，多出来的那枚对勾指向的其实不是这次调用。
   */
  const delegated = detail.batchSize === undefined;
  const labels = toolLabelKeys(toolName);
  /** 记账调用的「状态文案」就是它自己的动词（进行态 / 收尾态）—— 这就是它当下的状态 */
  const statusLabel = delegated
    ? t(SUBAGENT_STATUS_LABEL_KEYS[row.status])
    : t(running ? labels.active : labels.resting);
  const stepState: AgentState = delegated
    ? SUBAGENT_AGENT_STATES[row.status]
    : running
      ? "working"
      : "done";

  // 还有 working 的步骤时才需要每秒推进 now；waiting / done 的读数都不看它
  //（见 subagentElapsedMs），静止的消息不养心跳
  const now = useRunTicker(stepState === "working");

  /** 记账调用一次可能对着好几条运行：先报条数（复用面板的「N 个子智能体」词条），只说动词会被读成「只动了一条」 */
  const batchCount = detail.batchSize ?? 1;
  /**
   * 记录里没有代理名时用动词兜底，别在 pill 与读屏名里留一个空位。
   * 必须在 batchSuffix 之前算出来：它的宽度预算取决于名字长度。
   */
  const agentName = row.agentName.trim() === "" ? t("tools.task") : row.agentName;
  const batchSuffix =
    batchCount > 1 ? ` · ${t("rightPanel.subagentCount", { count: batchCount })}` : "";

  /**
   * 已完成运行的报告正文。直接取自 store 里那条**对过账**的行（row），
   * 而不是 details 快照：快照在重启后可能还没有 report（进程退出时就写到那儿为止）。
   * 终结态才有报告可显示（还在跑时 report 为空）。
   */
  const reportText = stepState === "working" ? "" : (row.report ?? "").trim();
  const steps: StatusStep[] = delegated
    ? [
        {
          state: stepState,
          label: delegationLabel(agentName, row.description, statusLabel, stepState === "done"),
          // 终态的耗时已经冻结在 endedAt / updatedAt 上（见 subagentElapsedMs），
          // now 只对 running 参与计算
          elapsed: formatDuration(subagentElapsedMs(row, now)),
        },
      ]
    : [
        {
          state: stepState,
          label: `${statusLabel}${batchSuffix}`,
          // 不给耗时：记账调用没有「它自己跑了多久」这回事，能挂上去的只有这批主体的读数，
          // 而那归主体那条 Task pill 说
        },
      ];

  /**
   * pill 是一个按钮，点击 **就地展开 / 收起下面的报告** —— 这是用户要的默认动作：
   * 报告就是这次调用的结果，点「已完成」当然应该是「把它摊开看看」。
   *
   * 不再用点击 pill 直接跳右侧栏：那是「换一个界面」的重动作，而用户在这个场景下
   * 九成只是想看一眼报告。右侧栏改成 pill 旁边一枚独立的小按钮（aria-label 写明是
   * 「查看执行详情」），想看证据链（任务 / 进度 / 子会话转录）时点它。
   *
   * 只有**确实有报告**时才让 pill 可展开：没报告可开时点一下什么都不会发生，
   * 那种「点了没反应」正是这个功能之前被报过的毛病。没有报告时 pill 退回原来的行为
   * （直接打开右侧栏），保证它永远是可点的。
   *
   * AgentStatus 是 div，点击入口只能包在外面（元素是 vendored 的，不给它加 onClick）；
   * 读屏名带上代理名与当前状态：一排按钮听不出区别，而「谁 + 现在怎么了」正是点它会看到的东西。
   * 元素尾部那枚 Pause / RotateCcw 只是 aria-hidden 的 span，没有自己的点击逻辑，不会抢走点击。
   */
  const hasReport = delegated && reportText !== "";
  const pillLabel = hasReport
    ? `${expanded ? t("chat.showLess") : t("chat.showMore")} · ${agentName} · ${statusLabel}`
    : `${t("rightPanel.subagentOpenDetails")} · ${agentName} · ${statusLabel}`;
  const pillHint = hasReport ? t("rightPanel.subagentReport") : t("rightPanel.subagentOpenDetails");
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-fit items-center gap-1">
        <button
          type="button"
          aria-label={pillLabel}
          aria-expanded={hasReport ? expanded : undefined}
          title={pillHint}
          onClick={() => {
            if (hasReport) setExpanded((open) => !open);
            else openSubagentPanel(row.delegationId);
          }}
          className="w-fit cursor-pointer rounded-full text-start outline-none transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none"
        >
          <AgentStatusList steps={steps} />
        </button>

        {/*
          右侧栏入口：只在有报告时单独出现（没报告时它已经并入 pill 的点击，见上）。
          小图标按钮而不是文字 —— 它是次要动作，不该和 pill 抢注意力。
        */}
        {hasReport && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("rightPanel.subagentOpenDetails")}
            title={t("rightPanel.subagentOpenDetails")}
            onClick={() => openSubagentPanel(row.delegationId)}
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {/*
        报告挂在「xxx 已完成」这个状态下面 —— 这就是它的结果，不是另外一条消息。

        为什么在 pill 之外单独渲染一块而不是塞进 pill：pill 是一行胶囊（agent-status 是
        vendored 元素，内部布局与截断都是它定的），而报告是多行正文。硬塞进去只会被
        max-w-44 truncate 掉 —— 那等于把结果又藏起来，与「主会话可以来读取这个内容」相反。

        **默认收起**：一份调研报告动辄上千字，整屏铺开会把对话节奏冲散；
        用户想看时点上面的 pill 就地展开（这也是它唯一被要求的行为）。
      */}
      {hasReport && expanded && <SubagentReport text={reportText} />}
    </div>
  );
}

/**
 * 已完成子智能体的报告正文。
 *
 * **纯展示**：展开 / 收起由上面那枚 pill 负责（用户要的就是「点已完成就地看报告」），
 * 所以这里不再自带一个「展开显示」按钮 —— 两个开关控制同一块内容，
 * 只会让人不确定该点哪个。展开态给全文，不做二次截断：
 * 用户已经明确表达了「我要看」，这时再截一段反而要再点一次。
 *
 * **按 markdown 渲染**：报告天然是 markdown（标题、列表、表格、代码块、路径引用都是
 * 子智能体常用的形状），按纯文本铺出来会把 `##`、`-`、`|` 这些符号原样暴露给用户。
 * 用 MarkdownBlock 而不是 MarkdownText：后者从 assistant-ui 的 part 上下文取正文，
 * 而报告挂在工具结果上、不在任何文本 part 里，塞进去只会是空壳。
 */
function SubagentReport({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={cn(paper, "flex flex-col gap-1.5 rounded-2xl px-3 py-2.5")}>
      <h4 className="text-ink-4 text-[11.5px]">{t("rightPanel.subagentReport")}</h4>
      <MarkdownBlock text={text} className="text-[12.5px]" />
    </div>
  );
}

/**
 * 后台作业在主会话里的样子：与子智能体同形的 agent-status 状态 pill，**不是**工具行。
 *
 * 为什么作业也要从工具行里拿出来：作业的语义是「活过这一轮」—— 起一个进程、立刻返回，
 * 用户真正要知道的是「它跑完没有、退出码是多少」，而工具行回答的是「这次调用成功了吗」。
 * 一次 `bash_background` 调用成功只代表**进程起来了**，与「这条命令跑成了」是两件事；
 * 按工具行读，用户会以为命令已经跑完。所以整条让给状态 pill：
 * 脉冲圆点（还在跑）/ 空心点（结束了，但不算成功）/ 绿勾（退出码 0），展开才是进程输出。
 *
 * 状态取自 chat-store 的 jobsBySession（不是 props）：主进程持续推 job-changed、
 * 重启后由 jobs.list 补拉，那份**始终是最新的**；details 里那份 job 只是启动 / 读取那一刻的
 * 快照。还在跑的那段时间只有 store 会动（结论要等进程退出才被回填到 details 上），
 * 所以**权威状态先问 store**，store 里查不到才退回快照 —— 与子智能体 pill 同一条纪律。
 *
 * 与 SubagentStatus 唯一的形状差别：作业的输出按**纯文本**渲染，不走 markdown。
 * 进程吐出来的字节里 `#` / `*` / `|` 是数据不是格式，按 markdown 解释会把构建日志读成标题与表格。
 */
function JobStatus({ detail, result }: { detail: JobDetailData; result: unknown }) {
  const { t } = useTranslation();
  /** 输出是否展开。默认收起：一条构建日志可以上千行，整片铺开会把对话节奏冲散 */
  const [expanded, setExpanded] = useState(false);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  /**
   * 当前会话的作业列表。选**数组字段本身**（引用稳定）而不是现算一个数组：
   * zustand v5 的 useSyncExternalStore 按引用比较，选择器每次返回新数组会被判定为快照变化
   *（无限重渲染，React #185）。
   */
  const sessionJobs = useChatStore((s) =>
    activeSessionId === null ? undefined : s.jobsBySession[activeSessionId],
  );

  const job = (sessionJobs ?? EMPTY_JOBS).find((item) => item.id === detail.jobId) ?? detail.job;

  const stepState = jobAgentState(job);
  // 还有 working 的步骤时才需要每秒推进 now：终态的耗时冻结在 endedAt 上（见 jobElapsedMs），
  // 静止的消息不养心跳
  const now = useRunTicker(stepState === "working");
  const statusLabel = t(JOB_STATUS_LABEL_KEYS[job.status]);
  /** job_list 一次可能列出好几条：先报条数，只说状态会被读成「只列了一条」 */
  const batchCount = detail.batch?.length ?? 1;
  const batchSuffix = batchCount > 1 ? ` · ${t("jobs.batchCount", { count: batchCount })}` : "";
  /**
   * 命令是这条 pill 的主体：一个会话里可能起过好几个作业，只有命令能把它们分开
   *（id 是给机器看的）。命令缺失（记录不全）时退回 id，别在 pill 上留一个空位。
   */
  const command = job.command.trim() === "" ? job.id : job.command;
  const steps: StatusStep[] = [
    {
      state: stepState,
      label: jobStatusLabel(command, statusLabel, batchSuffix),
      // 终态不再走 now（见 jobElapsedMs）；绿勾那一档元素本来就不渲染读数
      elapsed: formatDuration(jobElapsedMs(job, now)),
    },
  ];

  /**
   * 展开区就是**这次调用的结果文本**，位置与子智能体的报告一致。
   *
   * 作业退出时主进程会把结论（状态 / 退出码 / 命令 / 输出尾部）回填到这条 part 上
   *（见 main/pisdk/runtime.ts 的 deliverJobResult），于是这里自动长出结论；
   * 还在跑时它是启动回执或刚读到的那段输出 —— 两种情况都是这次调用真实的结果，
   * 不需要渲染层自己再去拼一份。
   */
  const output = toolResultText(result).trim();
  const hasOutput = output !== "";
  /** 点 pill 就地展开 / 收起：与子智能体 pill 完全同一个动作（「这次调用的结果」点开就看） */
  const pillLabel = `${command} · ${statusLabel}`;
  const pillClass =
    "w-fit rounded-full text-start outline-none transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none";

  return (
    <div className="flex w-full flex-col gap-2">
      {hasOutput ? (
        <button
          type="button"
          aria-label={pillLabel}
          aria-expanded={expanded}
          title={t(expanded ? "chat.showLess" : "chat.showMore")}
          onClick={() => setExpanded((open) => !open)}
          className={cn(pillClass, "cursor-pointer")}
        >
          <AgentStatusList steps={steps} />
        </button>
      ) : (
        // 结果还没到（流式期）时没有可展开的内容：只显示状态，不给一个点了没反应的按钮
        <div className="w-fit">
          <AgentStatusList steps={steps} />
        </div>
      )}

      {/*
        输出挂在 pill 下面单独一块而不是塞进 pill：pill 是一行胶囊（agent-status 是 vendored
        元素，内部布局与 max-w-44 truncate 都是它定的），硬塞进去只会被截掉 —— 那等于把输出
        又藏起来。**默认收起**，点 pill 就地展开。
      */}
      {hasOutput && expanded && (
        <div className={cn(paper, "flex flex-col gap-1.5 rounded-2xl px-3 py-2.5")}>
          <h4 className="text-ink-4 text-[11.5px]">{t("jobs.output")}</h4>
          {/*
            等宽 + 保留空白：这是进程原样吐出来的字节，换行与空格都是内容的一部分。
            用 pre 而不是 markdown 的理由见上面那条注释（`#` / `|` 是数据）。
          */}
          <pre
            className={cn(
              mono,
              "text-ink-2 app-scrollbar max-h-72 overflow-auto break-words whitespace-pre-wrap",
            )}
          >
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * 运行中时每秒推进一次 `now`（与 SubagentPanel 的那份同一个口径）。
 *
 * 开关是「还有没有 working 的步骤」而不是无条件定时：主会话里可能挂着一长串历史 pill，
 * 一条都不跑的时候不该有个心跳每秒把整块工具区重渲染一遍。
 * waiting / done 都不看 now，所以停掉不影响它们的读数。
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

/**
 * pill 的一行文案。
 *
 * **终态要说出「xxx 已完成」**（用户明确要求的状态形状）：跑完之后只留
 * 「名字 · 任务描述」的话，读起来还是「它在做什么」而不是「它已经做完了什么」，
 * 状态得靠左边那枚图标去猜。所以终态一律把状态词带出来（`explorer · 已完成`），
 * 进行态才保留描述（`explorer · 调研重试逻辑`）—— 那时用户关心的是「在干什么」。
 *
 * 描述放不下时优先留状态词：状态是这条 pill 的结论，描述只是它的来龙去脉。
 */
function delegationLabel(
  name: string,
  description: string,
  statusLabel: string,
  done: boolean,
): string {
  const separator = " · ";
  if (done) return `${name}${separator}${statusLabel}`;
  const text = description.trim();
  const room = STEP_LABEL_LIMIT - labelWidth(name) - labelWidth(separator);
  if (text === "" || room < STEP_LABEL_MIN_DESCRIPTION) return `${name}${separator}${statusLabel}`;
  return `${name}${separator}${labelWidth(text) <= room ? text : fitLabel(text, room)}`;
}
/**
 * 运行状态 → 元素的三档状态。这是一张**穷举**映射：用 Record<SubagentRunStatus, AgentState>
 * 而不是带 default 的 switch，契约里加一档状态时这里是编译错误，而不是悄悄落到某个兜底态
 *（同一个手法见 tool-presentation 的 SUBAGENT_STATUS_LABEL_KEYS）。
 *
 * 规则一句话：**绿勾只留给真的跑完的那一种**。
 * - running → working（脉冲圆点，正在干活）；
 * - completed 是唯一「结果完整、可以直接采信」的终态 → done（绿勾）；
 * - truncated 是到了轮次上限、报告被截断的**半成品** → waiting：给它打勾等于告诉用户
 *   「这事办好了」，而它其实没办完；
 * - failed / aborted / denied / interrupted 同理，都不是「完成」：绿勾会让失败看起来像成功；
 *   waiting 的空心点读作「没在跑，也没完成」，正是它们该待的位置。
 */
const SUBAGENT_AGENT_STATES: Record<SubagentRunStatus, AgentState> = {
  running: "working",
  completed: "done",
  truncated: "waiting",
  failed: "waiting",
  aborted: "waiting",
  denied: "waiting",
  interrupted: "waiting",
};

/**
 * 作业状态 → 词条键。与 SUBAGENT_STATUS_LABEL_KEYS 同一个手法：**穷举**映射，
 * 契约里加一档状态时这里是编译错误，而不是悄悄落到一个兜底文案上。
 * 词条沿用会话面板那份（jobs.*）：同一件事在两个现场用的是同一句话。
 */
const JOB_STATUS_LABEL_KEYS: Record<JobStatusValue, string> = {
  running: "jobs.running",
  exited: "jobs.exited",
  failed: "jobs.failed",
  killed: "jobs.killed",
};

/**
 * 作业状态 → 元素的三档状态。
 *
 * 判据是**进程怎么退出的**，所以不能像子智能体那样直接查状态枚举：
 * `exited` 只说「进程结束了」，它到底是跑成了还是跑挂了要看退出码 —— 退 0 才配拿绿勾。
 *
 * - running → working（脉冲圆点，还在跑）；
 * - exited + 退出码 0 → done（绿勾：这是唯一「跑完且成功」的一种）；
 * - exited + 非 0 退出码 → waiting（空心点：结束了，但结果是失败，绿勾会让失败看起来像成功）；
 * - failed（spawn 失败等）→ waiting；
 * - killed → waiting —— **不算失败**：那是有人主动叫停（用户点了停止、或新指令取消了它），
 *   与「跑挂了」是两件事，红叉会把它显示成后者；
 * - 退出码缺失（被信号杀死）→ waiting，不瞎猜成成功。
 */
function jobAgentState(job: JobInfo): AgentState {
  if (job.status === "running") return "working";
  if (job.status === "exited" && job.exitCode === 0) return "done";
  return "waiting";
}

/**
 * 作业 pill 的一行文案：`命令 · 状态`。
 *
 * 与子智能体那颗 pill 的差别在**主体**：委派的主体是一个代理人（名字 + 任务），
 * 作业的主体是一条命令 —— 同一个会话里可能起过好几个作业，只有命令能把它们分开。
 *
 * 命令常比标签宽（一条 npm 命令轻松 80 格），按同一套宽度预算截：宽预算与
 * delegationLabel 共用（元素那道 max-w-44 truncate 是最后一道闸门，真让它切就是半个词）。
 * 状态词优先于命令 —— 状态是这条 pill 的结论，命令是它的来龙去脉。
 */
function jobStatusLabel(command: string, statusLabel: string, suffix: string): string {
  const separator = " · ";
  const tail = `${statusLabel}${suffix}`;
  const room = STEP_LABEL_LIMIT - labelWidth(tail) - labelWidth(separator);
  if (room < STEP_LABEL_MIN_DESCRIPTION) return tail;
  return `${labelWidth(command) <= room ? command : fitLabel(command, room)}${separator}${tail}`;
}

/**
 * pill 文案的宽度预算（单位：半角字符）。
 * 元素的标签是 `max-w-44 truncate`（176px，text-xs 下大约装得下 28 个半角字符、14 个汉字）。
 * CSS 那道 truncate 是最后一道闸门，但真让它去切，切出来的就是半个词；这里先在前面按宽度截。
 */
const STEP_LABEL_LIMIT = 28;

/** 描述至少要有这么多宽度才值得占位，否则不如直接给状态词 */
const STEP_LABEL_MIN_DESCRIPTION = 8;

/**
 * 估算文案宽度：CJK / 全角标点算 2 格，其余 1 格。
 * 不求像素级精确 —— 只是别把 28 个汉字（≈336px）当成 28 格塞进 176px 的标签里，
 * 那样 CSS 还得再切一刀，前面这次截断就白做了。
 */
function labelWidth(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return width;
}

/** 按宽度预算截断并缀省略号（按码点迭代，不会把一个字符切成两半） */
function fitLabel(text: string, budget: number): string {
  let used = 0;
  let kept = "";
  for (const char of text) {
    const cost = (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (used + cost > budget) break;
    used += cost;
    kept += char;
  }
  return `${kept}…`;
}

/** 已解析的详情 → 具体组件（TodoList 的 prop 叫 items，映射已在纯逻辑层做完） */
function ResolvedDetail({
  toolName,
  detail,
  args,
  result,
  running,
}: {
  toolName: string;
  detail: ToolDetail;
  args: unknown;
  result: unknown;
  running: boolean;
}) {
  if (detail.kind === "diff") return <DiffDetail diff={detail.diff} />;
  if (detail.kind === "todo") {
    return <TodoDetail items={detail.items} revision={detail.revision} />;
  }
  // 委派在时间线里也是 pill：这一步可能是被折进 ToolTimeline 的 Task，展开后拿到的
  // 同样必须是状态而不是终端块（那条分支只服务 bash）
  if (detail.kind === "subagent") {
    return <SubagentStatus toolName={toolName} detail={detail} running={running} />;
  }
  // 后台作业同样是状态 pill（与子智能体同形）：它「跑完没有」才是要害，
  // 落到终端块里会被读成「一条命令的输出」
  // 后台作业同样是状态 pill（与子智能体同形）：它「跑完没有」才是要害，
  // 落到终端块里会被读成「一条命令的输出」。结果文本要传下去 —— 作业 pill 的展开区就是它
  if (detail.kind === "job") return <JobStatus detail={detail} result={result} />;
  // 网络工具：搜索给来源列表、抓取给状态摘要；正文都留在展开区的内置文本面板里
  if (detail.kind === "web-search") return <WebSearchDetail detail={detail} />;
  if (detail.kind === "web-fetch") return <WebFetchDetail detail={detail} />;
  return <TerminalDetail args={args} result={result} running={running} />;
}

/** 从 part 字段解析并渲染详情；没有更贴的组件时返回 null（调用侧据此决定是否让出内置面板） */
function PartDetail({
  toolName,
  args,
  result,
  details,
  isError,
  running,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  details: unknown;
  isError: boolean;
  running: boolean;
}) {
  const detail = useMemo(
    () => resolveToolDetail(toolName, details, isError, args),
    [toolName, details, isError, args],
  );
  if (detail === null) return null;
  return (
    <ResolvedDetail
      toolName={toolName}
      detail={detail}
      args={args}
      result={result}
      running={running}
    />
  );
}

/**
 * 时间线里某一步的详情。
 *
 * 订阅以展开状态为闸门：未展开时选择器恒返回 undefined，流式期间既不重渲染也不读 part。
 * bash 输出上限 256KB，若每一步都无条件订阅，一次工具输出之后的每个 token 都会把整段输出再读一遍。
 */
function StepDetail({ index, open }: { index: number; open: boolean }) {
  const part = useAuiState((s) => (open ? s.message.parts[index] : undefined));
  if (!open || part === undefined || part.type !== "tool-call") return null;

  return (
    <PartDetail
      toolName={part.toolName}
      args={part.args}
      result={part.result}
      details={part.artifact}
      isError={part.isError === true}
      running={part.status.type === "running"}
    />
  );
}

/**
 * 单个工具调用：折叠行**统一**走官方 ToolCall，成功与失败的差别只体现在它的收尾标记与行色上
 * （`isError` → 红叉 + 整行转红）。rich 组件只作为它的 `detail` 出现在展开的面板里：
 *
 * - edit 有可解析的 patch → detail 用 CodeDiff
 * - bash → detail 用 TerminalBlock
 * - todo 有清单 → detail 用 TodoList（details 未到时用工具参数里的清单兜底）
 * - **Task 系列是这条规则的例外**：一次委派不是一次工具调用，所以连 ToolCall 都不进 ——
 *   整条交给 SubagentStatus 的 agent-status 状态 pill，工具行那套（动词 / 参数 chip /
 *   展开看 request+result）一点不出现；details 为 null（记录缺失或调用失败）时照旧落回
 *   下面这条通用行
 * - 失败、以及其余（read / write / grep / glob / 未知）→ 不给 detail，保留内置的
 *   Request/Result 文本面板 —— 工具的错误文案本来就在 result 里，展开就能看到
 *
 * 之前失败态是整行走 vendored ToolFallback：它的标记由 part 的 status 决定，而 aui 的 status
 * 只表达「跑没跑完」，于是失败也会渲染成绿勾 —— 读起来就是成功。失败标记现在由 ToolCall 的
 * isError 承担，不依赖 aui 的状态推导。
 *
 * edit 的补丁、todo 的清单与子智能体的运行记录都走 assistant-ui 的 `artifact` 槽位
 * （见 message-converter 的映射）：委派的运行记录仍然从 artifact 解析（resolveToolDetail →
 * SubagentDetailData），只是不再作为 ToolCall 的 detail 渲染。
 */
export const ToolCallPart: ToolCallMessagePartComponent = (props) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const isError = props.isError === true;
  const detail = useMemo(
    () => resolveToolDetail(props.toolName, props.artifact, isError, props.args),
    [props.toolName, props.artifact, isError, props.args],
  );

  const labels = toolLabelKeys(props.toolName);

  /**
   * 委派 / 记账调用不套工具行：整条让给状态 pill。走的这条路不经过 ToolCall，于是
   * 「动词 + 参数 chip + 折叠展开看 request/result」那层外壳一概不出现 ——
   * 「不要是普通工具样式」指的就是这件事。
   *
   * 只有 details 解析得出运行记录、且这次调用没失败（失败闸门在 resolveToolDetail 里）
   * 才走这条分支；detail 为 null 时落回下面的通用行 —— 绝不给一枚编出来的状态：
   * 一次启动失败的委派显示成「运行中」，比显示成一条工具错误更糟。
   */
  if (detail !== null && detail.kind === "subagent") {
    return (
      <SubagentStatus
        toolName={props.toolName}
        detail={detail}
        running={props.status.type === "running"}
      />
    );
  }
  /**
   * 后台作业同理，但**额外要一道过**：作业的成败由主进程回填成 isError（见 job-delivery），
   * 而失败态的作业仍然是一颗有结论的状态 pill（「失败」而不是红叉工具行）——
   * 那是这次调用的结果本身，藏进折叠行反而看不出「它跑挂了」。
   * 所以这里不看 resolveToolDetail 那道失败闸门给的 null，直接从 details 取作业详情：
   * 作业的 details 在启动那一刻就带着完整快照，失败态也还在。
   */
  if (JOB_TOOL_NAMES.includes(props.toolName)) {
    const job = parseJobDetail(props.artifact);
    if (job !== null) return <JobStatus detail={job} result={props.result} />;
  }
  return (
    <ToolCall
      label={t(labels.resting)}
      activeLabel={t(labels.active)}
      query={toolChip(props.args)}
      request={props.argsText}
      result={toolResultText(props.result)}
      running={props.status.type === "running"}
      isError={isError}
      open={open}
      onOpenChange={setOpen}
      detail={
        detail === null ? undefined : (
          <ResolvedDetail
            toolName={props.toolName}
            detail={detail}
            args={props.args}
            result={props.result}
            running={props.status.type === "running"}
          />
        )
      }
    />
  );
};

/**
 * 把 Task 系列注册成**独立显示**的工具 UI，让子智能体的呼叫不再长得像一次普通工具调用。
 *
 * 为什么必须注册而不是只把 ToolCallPart 的渲染分支改掉：`MessagePrimitive.GroupedParts`
 * 决定一条工具调用是否折进「思维链 / 工具时间线」，判据只有两个 —— MCP app，或者该工具在
 * 注册表里被标成 `display: "standalone"`（见 groupPartByType 的实现）。不注册的话，
 * 模型在同一批里同时发了 grep 和 Task 时，Task 会被折进那条折叠轨迹里，
 * pill 只在展开某一步之后才出现 —— 也就是「看起来还是个普通工具」。
 * 注册之后 `part.toolUI` 直接把它顶到消息正文层：子智能体的呼叫就是独立的一块。
 *
 * 为什么 render 仍然是 ToolCallPart：`Thread.tsx` 的 part 分发是
 * `part.toolUI ?? <ToolCallPart {...part} />`，注册表给的 UI 会**取代**默认渲染，
 * 所以这里必须指回同一个组件才能在 ToolCallPart 内部走 `kind === "subagent"` 那条分支
 * （「子智能体任务一律用 pill，其余工具仍是官方 ToolCall 折叠行」这条规则只写在那一处）。
 *
 * 为什么逐个调用 useAssistantToolUI 而不是在循环里调：hook 的调用顺序必须稳定，
 * 循环里调 hook 一旦顺序变了就是运行时错误。下面四个名字取自契约常量，
 * 用下标逐次取、越界返回 null（库支持传 null 表示这次不注册），既不重复写名字，也不动顺序。
 */
export function SubagentToolUIs(): null {
  useAssistantToolUI(subagentToolUIAt(0));
  useAssistantToolUI(subagentToolUIAt(1));
  useAssistantToolUI(subagentToolUIAt(2));
  useAssistantToolUI(subagentToolUIAt(3));
  return null;
}

/**
 * 后台作业四件套同样注册成**独立显示**（理由与上面一字不差）。
 *
 * 为什么单独一个组件而不是并进 SubagentToolUIs：两个名字表长度一样纯属巧合，
 * 合在一个函数里就得靠下标拼接去猜哪个名字属于谁；分开之后，「作业 pill 与委派 pill
 * 各注册各的」这件事在调用点上一眼可读。hook 顺序在各自函数内部仍然固定。
 */
export function JobToolUIs(): null {
  useAssistantToolUI(jobToolUIAt(0));
  useAssistantToolUI(jobToolUIAt(1));
  useAssistantToolUI(jobToolUIAt(2));
  useAssistantToolUI(jobToolUIAt(3));
  return null;
}

/** 第 index 个作业工具的注册项；下标越界时返回 null */
function jobToolUIAt(index: number): {
  toolName: string;
  render: ToolCallMessagePartComponent;
  display: "standalone";
} | null {
  const toolName = JOB_TOOL_NAMES[index];
  if (toolName === undefined) return null;
  return { toolName, render: ToolCallPart, display: "standalone" };
}

/** 第 index 个 Task 系列工具的注册项；下标越界时返回 null（库据此跳过这次注册） */
function subagentToolUIAt(index: number): {
  toolName: string;
  render: ToolCallMessagePartComponent;
  display: "standalone";
} | null {
  const toolName = SUBAGENT_TOOL_NAMES[index];
  if (toolName === undefined) return null;
  return { toolName, render: ToolCallPart, display: "standalone" };
}

/**
 * 一次运行里连续的工具调用。
 *
 * 多步且全部成功时收成官方 ToolTimeline 的一条轨迹；单步、或其中一步失败时逐条展开——
 * 一个调用多包一层折叠没有信息量，而失败不该被藏进折叠行里。
 * 成组时每步仍各自可展开，展开的是该步自己的 rich 详情。
 */
export function ToolRunGroup({
  indices,
  children,
}: {
  indices: readonly number[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 汇总快照走 JSON 字符串：原始值，useAuiState 的 Object.is 才比得准（选数组字段每次都是新引用）。
  // 它按 token 重算，所以刻意不含 result —— 大块文本不能进这个快照，
  // 各步的输出由 StepDetail 在展开时才去读。
  const signature = useAuiState((s) => JSON.stringify(toolRows(s.message.parts, indices)));
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const rows = useMemo(() => JSON.parse(signature) as ToolRow[], [signature]);

  if (rows.length < 2 || rows.some((row) => row.failed)) {
    // 直接给 children：父容器是 flex + gap，包一层 flex 会再叠一道 gap
    return <>{children}</>;
  }

  const steps: TimelineStep[] = rows.map((row) => ({
    verb: t((TOOL_LABELS[row.name] ?? FALLBACK_LABELS).resting),
    chip: row.chip,
    icon: TOOL_ICONS[row.name] ?? DEFAULT_ICON,
    detail: (stepOpen: boolean) => <StepDetail index={row.partIndex} open={stepOpen} />,
  }));

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
      restingLabel={t("tools.groupCount", { count: steps.length })}
      activeLabel={t("tools.groupActive")}
      stats={[]}
    />
  );
}
