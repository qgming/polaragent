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
 * 对话顶部工具条（B3 ①②）：加载更早消息 + 上下文压缩摘要。
 * 作为 Thread 的上方兄弟渲染（而非塞进 ThreadPrimitive.Viewport 内部），
 * 避免侵入 viewport 的自动滚动与顶部锚点逻辑；代价是它不随消息一起滚动。
 */
export function ThreadToolbar() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const hasMore = useChatStore(
    (s) => s.activeSessionId !== null && s.hasMoreBySession[s.activeSessionId] === true,
  );
  const notice = useChatStore((s) =>
    s.activeSessionId !== null ? s.compactionNotices[s.activeSessionId] : undefined,
  );
  const loading = useChatStore((s) => s.loading);

  if (!hasMore && notice === undefined) return null;

  const handleLoadOlder = async () => {
    const id = useChatStore.getState().activeSessionId;
    if (id === null || busy) return;
    setBusy(true);
    try {
      // before: true 走向上翻页，游标由 store 内部从 pageCursorBySession 读取
      await useChatStore.getState().loadMessages(id, { before: true });
    } finally {
      setBusy(false);
    }
  };

  const showLoading = busy || loading;

  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-4 pt-3">
      {hasMore && (
        <button
          type="button"
          onClick={() => void handleLoadOlder()}
          disabled={showLoading}
          className="w-full rounded-md py-1.5 text-center text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {showLoading ? t("chat.loadingOlder") : t("chat.loadOlder")}
        </button>
      )}
      {notice !== undefined && (
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
      )}
    </div>
  );
}
