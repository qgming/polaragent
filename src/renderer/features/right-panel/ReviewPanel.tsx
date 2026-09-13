import { Braces, ChevronDown, RefreshCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { DiffViewer } from "@/renderer/components/ui/diff-viewer";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { FileChange, ReviewSummary } from "@/shared/contracts/review";
import { PanelEmpty, PanelError } from "./panel-view";

/**
 * 审查面板：本次会话改过的文件与它们的补丁。
 *
 * 数据来自会话消息里的 write / edit 记录（主进程汇总，见 main/review/service.ts），
 * 不是 git 工作树 —— 仓库没有 git 集成，而那份记录与对话一一对应：
 * 每条改动都能追到是哪次工具调用，这在「模型说要改 A，实际改了 B」时最有用。
 *
 * 代价也写清楚：外部编辑器改动的文件不会出现在这里。这是刻意的取舍，
 * 面板的定位是「这次对话改了什么」，不是「工作树相对 HEAD 的差异」。
 */
export function ReviewPanel(): React.JSX.Element {
  const { t } = useTranslation();

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  /**
   * 刷新触发键：消息条数。
   *
   * 改动是随工具调用到达的（走事件流写进 store）。用条数当依赖是最便宜的信号 ——
   * 不需要深比较整个消息树，也能在「新的一轮工具调用落地」时重新汇总。
   * 同一条消息里追加 tool-call（流式期）不会改条数，但那种中间态本来也不该刷新面板。
   */
  const messageCount = useChatStore((s) =>
    s.activeSessionId !== null ? (s.messagesBySession[s.activeSessionId]?.length ?? 0) : 0,
  );

  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 展开了哪些文件分组；键是 displayPath */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    if (activeSessionId === null) {
      setSummary(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.oint.review.summary(activeSessionId);
      setSummary(result);
      // 默认只展开第一个文件：一个改了 30 个文件的会话不该一次渲染 30 份 diff
      setExpanded(new Set(result.changes.length > 0 ? [result.changes[0]?.displayPath ?? ""] : []));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  /*
    会话切换、或有新消息落地时重新汇总。

    messageCount 只用来当**触发信号**（改动随工具调用到达，条数变了说明有新的一批），
    它不参与 load 的计算 —— 所以刻意不进 load 的依赖。linter 看不出这层意图，
    用注释说明而不是把依赖塞进 useCallback 让每次条数变化都重建闭包。
  */
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount 是刷新信号，不是 load 的输入
  useEffect(() => {
    void load();
  }, [load, messageCount]);

  /**
   * 按文件分组。
   *
   * 同一文件可能被改多次（先 write 再 edit），每次都留一条记录 ——
   * 分组保留组内的时间顺序，组间按「最近改动在前」（主进程已按此排好，这里只做分组）。
   */
  const groups = useMemo(() => {
    if (summary === null) return [];
    const map = new Map<string, FileChange[]>();
    for (const change of summary.changes) {
      const list = map.get(change.displayPath);
      if (list === undefined) map.set(change.displayPath, [change]);
      else list.push(change);
    }
    return [...map.entries()];
  }, [summary]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (activeSessionId === null) {
    // 空态直接铺满面板：外层头部已经写着「审查」，这里不再重复一行标题
    return (
      <PanelEmpty
        icon={Braces}
        title={t("rightPanel.reviewEmpty")}
        hint={t("rightPanel.reviewEmptyHint")}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        合计行：文件数与增删总计，刷新按钮放在这一行的右端。

        为什么不再有「审查」标题行：面板头部（RightSidebar）已经显示当前视图名，
        这里再写一遍就是同一个词上下相邻出现两次。刷新属于这一屏的动作，
        挂到已有的信息行上最省空间，也不用为它留一条 44px 的空横带。
      */}
      <div
        className={cn(
          mono,
          "flex h-8 shrink-0 items-center gap-1 border-b border-border/60 pl-3 text-ink-3",
        )}
      >
        {summary !== null && summary.changes.length > 0 ? (
          <span className="min-w-0 flex-1 truncate">
            {summary.fileCount} files{" "}
            <span className="text-emerald-600 dark:text-emerald-400">+{summary.additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{summary.deletions}</span>
          </span>
        ) : (
          // 还没汇总出内容时这一行只剩刷新按钮，用一个占位把按钮推到右端，行高保持一致
          <span className="min-w-0 flex-1" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.filesRefresh")}
          title={t("rightPanel.filesRefresh")}
          onClick={() => void load()}
        >
          <RefreshCw
            className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
      </div>

      {error !== null && <PanelError message={error} />}

      {summary === null || summary.changes.length === 0 ? (
        <PanelEmpty
          icon={Braces}
          title={t("rightPanel.reviewEmpty")}
          hint={t("rightPanel.reviewEmptyHint")}
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          {groups.map(([path, changes]) => {
            const isOpen = expanded.has(path);
            const latest = changes[0];
            const additions = changes.reduce((sum, item) => sum + item.additions, 0);
            const deletions = changes.reduce((sum, item) => sum + item.deletions, 0);

            return (
              <Collapsible key={path} open={isOpen} onOpenChange={() => toggle(path)}>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 border-b border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-accent">
                  <ChevronDown
                    className={cn(
                      "text-ink-4 size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                      isOpen && "rotate-180",
                    )}
                  />
                  <span
                    className="text-ink-2 min-w-0 flex-1 truncate text-[12.5px]"
                    dir="ltr"
                    title={path}
                  >
                    {path}
                  </span>
                  {/* 新建 / 修改：只看最新一次改动的性质（老记录上的标记意义不大） */}
                  {latest !== undefined && (
                    <span
                      className={cn(
                        mono,
                        "shrink-0 rounded px-1",
                        latest.kind === "added"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-ink-4",
                      )}
                    >
                      {latest.kind === "added"
                        ? t("rightPanel.reviewAdded")
                        : t("rightPanel.reviewModified")}
                    </span>
                  )}
                  <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>
                    {additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
                    )}{" "}
                    {deletions > 0 && (
                      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
                    )}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {changes.map((change, index) => (
                    <div
                      // toolCallId 在一次会话里唯一，直接当 key —— 不用 index 拼，
                      // 同一文件被改多次时 index 会随列表变动而漂移，导致 React 复用错节点
                      key={change.toolCallId}
                      className="border-b border-border/60"
                    >
                      {/* 第二次之后的改动标一个序号：同一文件被改多次时，
                          否则两段一模一样的文件名会让人以为界面重复渲染了 */}
                      {changes.length > 1 && (
                        <p className={cn(mono, "flex items-center gap-1 px-3 pt-2 text-ink-4")}>
                          <Tag className="size-3" />
                          {change.tool} · {index + 1}/{changes.length}
                        </p>
                      )}
                      {change.patch === null ? (
                        <p className={cn(mono, "px-3 py-2 text-ink-4")}>
                          {t("rightPanel.reviewNoPatch")}
                        </p>
                      ) : (
                        <DiffViewer
                          patch={change.patch}
                          viewMode="unified"
                          showStats={false}
                          showLineNumbers
                          className="max-h-[28rem] overflow-auto"
                        />
                      )}
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
