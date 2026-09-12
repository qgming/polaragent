import { Loader2Icon, RocketIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghostButton, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import { SectionEmpty, SessionSection } from "@/renderer/features/session/session-section";
import { formatDuration, formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { JobStatus } from "@/shared/contracts";

/**
 * 四种状态的徽标配色（都是既有配色：running 是全局那支「运行中」蓝，
 * exited 取工具卡绿勾的绿，failed 取红，killed 取编辑对话框那支琥珀）。
 * 状态同时有文字：「运行中 / 已退出 / 失败 / 已停止」，不靠颜色单独表意。
 */
const STATUS_STYLES: Record<JobStatus, string> = {
  running: "border-blue-500/25 bg-blue-500/[0.08] text-blue-500 dark:text-blue-400",
  exited: "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400",
  failed: "border-red-600/25 bg-red-600/[0.08] text-red-600 dark:text-red-400",
  killed: "border-amber-600/25 bg-amber-600/[0.08] text-amber-600 dark:text-amber-400",
};

const STATUS_LABEL_KEYS: Record<JobStatus, string> = {
  running: "jobs.running",
  exited: "jobs.exited",
  failed: "jobs.failed",
  killed: "jobs.killed",
};

/**
 * 每秒跳一次的时钟：只在有作业还在跑时起定时器。
 * 主进程的 job-changed 只在状态变化时推，不会每秒推一次「跑了多久」，时长只能自己算。
 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

function StatusBadge({ status }: { status: JobStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      data-slot="job-status"
      className={cn(
        "h-4.5 shrink-0 px-1.5 text-[10.5px] leading-none font-normal",
        STATUS_STYLES[status],
      )}
    >
      {t(STATUS_LABEL_KEYS[status])}
    </Badge>
  );
}

/**
 * 「后台作业」区块（原 JobPanel，从 composer 上沿迁到会话面板）。
 *
 * 数据全部来自 chat-store：主进程的 job-changed / job-removed 事件经事件桥写进
 * `jobsBySession`，会话切换时由 store 的 loadJobs 从主进程补拉。区块自己不订阅 IPC，
 * 只读状态、只调 store 的 killJob —— 因此「点了停止」这条链是 区块 → store → IPC。
 *
 * 与原来那条的区别只有两处，都是容器带来的：
 *   · 区块**始终渲染**：没有作业时给一句空态文案（原来整块不渲染是为了不白占输入框上方的空间）
 *   · 行尾的「进行中 / 总数」改成右侧徽标，只数还在跑的；没有作业时连徽标都不给
 * 全部结束的作业仍然保留 —— 用户要看的恰恰是「刚才那条命令退了没有、退出码是多少」。
 */
export function JobPanel() {
  const { t } = useTranslation();
  /** 正在停的那一条（按钮转圈 + 禁用）；同一时刻只可能点一个 */
  const [killing, setKilling] = useState<string | null>(null);

  /**
   * 当前会话的作业列表直接从 store 读（与 ChatView 读审批 / 提问同源）。
   * 选择器返回 store 里的数组本身（引用稳定），不会每次 store 更新都触发重渲染。
   */
  const jobs = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.jobsBySession[s.activeSessionId],
  );
  const killJob = useChatStore((s) => s.killJob);

  const running = jobs?.filter((job) => job.status === "running").length ?? 0;
  const now = useNowTicker(running > 0);
  const total = jobs?.length ?? 0;

  const handleKill = async (id: string) => {
    setKilling(id);
    try {
      await killJob(id);
    } finally {
      // 停掉之后这一条要么从列表里消失、要么不再是 running；闸门总得放下
      setKilling((current) => (current === id ? null : current));
    }
  };

  return (
    <SessionSection
      slot="job-panel"
      icon={RocketIcon}
      title={t("sessionPanel.jobs")}
      toggleLabel={t("chat.jobsPanelToggle")}
      count={total === 0 ? undefined : String(running)}
      countSlot="job-count"
      // 有作业但一条都不在跑：这一块已经收尾，绿徽标表示「都结束了」
      countTone={running === 0 ? "done" : "neutral"}
    >
      {total === 0 ? (
        <SectionEmpty>{t("jobs.empty")}</SectionEmpty>
      ) : (
        <ul
          className={cn(
            "app-scrollbar flex max-h-[min(16rem,36vh)] flex-col gap-0.5 overflow-y-auto px-2.5 pt-1 pb-2",
          )}
        >
          {jobs?.map((job) => {
            const isRunning = job.status === "running";
            const isKilling = killing === job.id;
            return (
              <li key={job.id} data-slot="job-row" className="flex flex-col gap-0.5 py-0.5">
                <div className="flex items-center gap-2">
                  {/* 命令是这一条的主体：等宽、单行截断，完整命令行留给 title */}
                  <code
                    title={job.command}
                    className={cn(typePackage, "min-w-0 flex-1 truncate text-ink-2")}
                  >
                    {job.command}
                  </code>
                  <StatusBadge status={job.status} />
                  {/* 只有还在跑的作业能停；终态的进程已经没了，按钮不该出现 */}
                  {isRunning && (
                    <button
                      type="button"
                      disabled={isKilling}
                      // 图标按钮：无障碍名称与悬浮提示都由此给出
                      aria-label={isKilling ? t("jobs.killing") : t("jobs.kill")}
                      title={isKilling ? t("jobs.killing") : t("jobs.kill")}
                      onClick={() => void handleKill(job.id)}
                      className={cn(
                        ghostButton,
                        "size-5 shrink-0 hover:text-red-600 disabled:pointer-events-none disabled:opacity-40 dark:hover:text-red-400",
                      )}
                    >
                      {isKilling ? (
                        <Loader2Icon
                          className="size-3 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <SquareIcon className="size-2.5 fill-current" aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
                {/* 元信息一行：作业 id、时长或结束时间、退出码、截断提示 */}
                <div
                  className={cn(mono, "flex min-w-0 flex-wrap items-center gap-x-1.5 text-ink-4")}
                >
                  <span className="shrink-0">{job.id}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0 tabular-nums">
                    {isRunning
                      ? t("jobs.elapsed", {
                          duration: formatDuration(Math.max(0, now - job.startedAt)),
                        })
                      : job.endedAt === undefined
                        ? t("jobs.ended")
                        : t("jobs.endedAt", { time: formatTime(job.endedAt) })}
                  </span>
                  {job.exitCode !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 tabular-nums">
                        {t("jobs.exitCode", { code: job.exitCode })}
                      </span>
                    </>
                  )}
                  {job.truncated && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{t("jobs.truncated")}</span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SessionSection>
  );
}
