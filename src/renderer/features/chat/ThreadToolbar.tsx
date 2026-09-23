import { Archive, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { CompactionReason, SessionCompaction } from "@/shared/contracts";

/**
 * 对话顶部工具条：上下文压缩。
 *
 * 四种结局各说各的话（早先只有「有摘要 / 空串」两态，而空串被当成「进行中」，
 * 于是一次**失败**的压缩会让这里永久显示"运行中"）：
 *
 * - 进行中：压缩中…（自动 / 手动 / 溢出恢复）+ 已用秒数（自动压缩发生在运行中，
 *   用户需要知道「现在卡住的是压缩，不是模型在偷懒」）；
 * - 已完成：压缩前 tokens + 保留条数，可展开看摘要；
 * - 失败：红色一行说明原因，可点掉（点掉即从 store 里清掉这条状态）；
 * - 已取消：灰色一行，同样可点掉。
 *
 * 「加载更早消息」的按钮已移除 —— 向上滚动会自动取更早的一页（Thread 里的哨兵 +
 * IntersectionObserver），再留一个手动入口只是噪声；加载中与无更多的状态也在那边呈现。
 */
export function ThreadToolbar() {
  const { t } = useTranslation();
  const [noticeOpen, setNoticeOpen] = useState(false);

  const compaction = useChatStore((s) =>
    s.activeSessionId !== null ? s.compactions[s.activeSessionId] : undefined,
  );
  const clearCompaction = useChatStore((s) => s.clearCompaction);

  if (compaction === undefined) return null;

  const dismissible = compaction.phase === "failed" || compaction.phase === "cancelled";

  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-4 pt-3">
      <Collapsible open={noticeOpen} onOpenChange={setNoticeOpen}>
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] transition-colors",
            compaction.phase === "failed"
              ? "text-destructive hover:bg-destructive/10"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          // 失败与取消没有可展开的正文：点它是「知道了，收起来」
          onClick={dismissible ? () => clearCompaction() : undefined}
        >
          <Archive className="size-3.5 shrink-0" />
          <CompactionLabel compaction={compaction} />
          {compaction.phase === "completed" && (
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                noticeOpen && "rotate-180",
              )}
            />
          )}
        </CollapsibleTrigger>
        {compaction.phase === "completed" && (
          <CollapsibleContent>
            {/* 摘要正文：左侧 2px 竖线引用样式 */}
            <div className="mt-1 border-l-2 border-border px-3 py-1 text-xs leading-relaxed text-muted-foreground">
              {compaction.summaryPreview === ""
                ? t("chat.compactionNoPreview")
                : compaction.summaryPreview}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}

/** 压缩原因的短标签：同样是「压缩中」，主动触发与后台自动发生的解释完全不同 */
function reasonLabelKey(reason: CompactionReason): string {
  if (reason === "manual") return "chat.compactingManual";
  if (reason === "overflow") return "chat.compactingOverflow";
  return "chat.compactingAuto";
}

function CompactionLabel({ compaction }: { compaction: SessionCompaction }) {
  const { t } = useTranslation();
  const elapsed = useElapsedSeconds(
    compaction.phase === "running" ? compaction.startedAt : undefined,
    compaction.endedAt,
  );

  if (compaction.phase === "running") {
    return (
      // live 蓝 + 微光：与「模型正在输出」同一套视觉，一眼看出会话还活着
      <span className={cn(live, "flex min-w-0 items-center gap-1.5")} role="status">
        <ShimmerLabel>
          {t("chat.compacting")} · {t(reasonLabelKey(compaction.reason))}
        </ShimmerLabel>
        {elapsed === null ? null : <span className="tabular-nums">{elapsed}s</span>}
      </span>
    );
  }

  if (compaction.phase === "failed") {
    return (
      <span className="min-w-0 flex-1 truncate text-left">
        {t("chat.compactionFailed", {
          error: compaction.error ?? t("chat.compactionUnknownError"),
        })}
      </span>
    );
  }

  if (compaction.phase === "cancelled") {
    return (
      <span className="min-w-0 flex-1 truncate text-left">{t("chat.compactionCancelled")}</span>
    );
  }

  return (
    <span className="min-w-0 flex-1 truncate text-left">
      {compaction.tokensBefore === undefined
        ? t("chat.compactedPlain")
        : t("chat.compacted", {
            tokens: formatTokens(compaction.tokensBefore),
            count: compaction.retainedCount ?? 0,
          })}
    </span>
  );
}

/**
 * 进行中的秒表。
 *
 * 只为「压缩中」跑：结束后不再重渲染（`endedAt` 给了就停），
 * 否则一个已经完成的摘要会每秒重渲染一次对话区顶部。
 */
function useElapsedSeconds(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | null {
  const running = startedAt !== undefined && endedAt === undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (startedAt === undefined) return null;
  const until = endedAt ?? now;
  return Math.max(0, Math.round((until - startedAt) / 1000));
}

/** 大数用 k 表示：压缩前的估算动辄几十万 tokens，原样显示会把这一行撑爆 */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}
