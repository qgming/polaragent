import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { ChatView } from "@/renderer/features/chat/ChatView";
import { SessionSearchBar, type SessionSearchHit } from "@/renderer/features/search";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

export function MainShell() {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 该会话是否有一次运行在进行：live 蓝只用来表示这件事
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );
  const openSessionSearch = useUiStore((s) => s.openSessionSearch);
  const sessionSearchOpen = useUiStore((s) => s.sessionSearchOpen);

  // 会话内搜索的当前命中：搜索条在 MainShell 渲染，故 state 提升到这里，经 ChatView 传给 Thread
  const [activeHit, setActiveHit] = useState<SessionSearchHit | null>(null);

  // 关闭搜索条时清除命中高亮。必须在开关关闭的那一刻主动清一次：
  // 子组件关闭后不再回传，光靠下面的 guard 会让残留的 gutter 与计数留在消息上。
  useEffect(() => {
    if (!sessionSearchOpen) setActiveHit(null);
  }, [sessionSearchOpen]);

  // 关闭后（如 Ctrl+F 切换）查询词可能仍在，搜索条的 effect 会继续回传命中；
  // 这里按开关状态拒绝，避免残留高亮。
  const handleActiveHitChange = (hit: SessionSearchHit | null) => {
    if (!sessionSearchOpen) return;
    setActiveHit(hit);
  };

  const title = sessions.find((s) => s.id === activeSessionId)?.title ?? t("chat.newChat");

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 内容区顶栏：标题 + 运行状态 + 会话内搜索 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {running && (
            <span
              className={cn(live, "flex shrink-0 items-center gap-1.5 text-[11px]")}
              role="status"
            >
              <ShimmerLabel>{t("chat.running")}</ShimmerLabel>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("common.search")}
            onClick={openSessionSearch}
          >
            <Search className="size-4" />
          </Button>
        </div>
      </div>

      {/* 会话内搜索条：固定在内容区顶部，未打开时自身返回 null */}
      <SessionSearchBar onActiveHitChange={handleActiveHitChange} />
      <ChatView searchHit={activeHit} />
    </main>
  );
}
