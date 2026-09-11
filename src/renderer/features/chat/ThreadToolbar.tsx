import { Archive, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";

/**
 * 对话顶部工具条：上下文压缩摘要。
 *
 * 「加载更早消息」的按钮已移除 —— 向上滚动会自动取更早的一页（Thread 里的哨兵 +
 * IntersectionObserver），再留一个手动入口只是噪声；加载中与无更多的状态也在那边呈现。
 */
export function ThreadToolbar() {
  const { t } = useTranslation();
  const [noticeOpen, setNoticeOpen] = useState(false);

  const notice = useChatStore((s) =>
    s.activeSessionId !== null ? s.compactionNotices[s.activeSessionId] : undefined,
  );

  if (notice === undefined) return null;

  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-4 pt-3">
      <Collapsible open={noticeOpen} onOpenChange={setNoticeOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Archive className="size-3.5 shrink-0" />
          {notice.length > 0 ? (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{notice}</span>
              <ChevronDown
                className={cn(
                  "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                  noticeOpen && "rotate-180",
                )}
              />
            </>
          ) : (
            // 压缩进行中（summaryPreview 尚未生成）：live 蓝 + 微光
            <span className={cn(live, "flex items-center gap-1.5")} role="status">
              <ShimmerLabel>{t("chat.running")}</ShimmerLabel>
            </span>
          )}
        </CollapsibleTrigger>
        {notice.length > 0 && (
          <CollapsibleContent>
            {/* 摘要正文：左侧 2px 竖线引用样式（同 B3 ②） */}
            <div className="mt-1 border-l-2 border-border px-3 py-1 text-xs leading-relaxed text-muted-foreground">
              {notice}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}
