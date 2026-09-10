import { BarChart3, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { ChatView } from "@/renderer/features/chat/ChatView";
import { SessionSearchBar, type SessionSearchHit } from "@/renderer/features/search";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/** B1 建议卡占位槽位（2×2）；提示词数据与词条未就绪，先以结构占位呈现 */
const SUGGESTION_SLOTS = [0, 1, 2, 3] as const;

/** B1 无会话空态：欢迎语 + 建议卡占位 + 一行提示；不渲染 Composer，避免出现死的输入框 */
function WelcomeEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6">
      <h1 className="font-display text-2xl leading-[1.3]">{t("chat.welcome")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("chat.welcomeSubtitle")}</p>
      {/* 建议卡片：document 圆角 + 1px 边框；内容为待接入的提示词（数据/词条未就绪） */}
      <div aria-hidden="true" className="mt-8 grid w-full max-w-[44rem] grid-cols-2 gap-3">
        {SUGGESTION_SLOTS.map((slot) => (
          <div key={slot} className="rounded-sm border border-border bg-card px-3.5 py-3">
            <div className="h-3 w-24 rounded-sm bg-muted" />
            <div className="mt-2 h-3 w-3/5 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">{t("chat.noMessages")}</p>
    </div>
  );
}

export function MainShell() {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 运行中指示（E2 落点 ④）：仅当前会话
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );
  const openSessionSearch = useUiStore((s) => s.openSessionSearch);
  const sessionSearchOpen = useUiStore((s) => s.sessionSearchOpen);

  // 会话内搜索的当前命中：搜索条在 MainShell 渲染，故 state 提升到这里，经 ChatView 传给 Thread
  const [activeHit, setActiveHit] = useState<SessionSearchHit | null>(null);

  // 关闭搜索条时清除命中高亮（B8 ④）
  useEffect(() => {
    if (!sessionSearchOpen) setActiveHit(null);
  }, [sessionSearchOpen]);

  // 关闭搜索条后（如 Ctrl+F 切换）查询词可能仍在，搜索条的 effect 会继续回传命中；
  // 这里按开关状态拒绝，避免残留高亮。
  // 依赖 open 状态：回调变化会让搜索条的 effect 重跑一次，重开时即可恢复当前命中高亮
  const handleActiveHitChange = useCallback(
    (hit: SessionSearchHit | null) => {
      if (!sessionSearchOpen) return;
      setActiveHit(hit);
    },
    [sessionSearchOpen],
  );

  const title = sessions.find((s) => s.id === activeSessionId)?.title ?? t("chat.newChat");

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 内容区顶栏：标题 + 运行状态 + 会话内搜索 / 用量 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {running && (
            <span className="flex shrink-0 items-center gap-1.5 text-brand-text text-[11px]">
              <span className="size-1.5 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
              {t("chat.running")}
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled
            aria-label={t("sidebar.usage")}
          >
            <BarChart3 className="size-4" />
          </Button>
        </div>
      </div>

      {activeSessionId === null ? (
        <WelcomeEmptyState />
      ) : (
        <>
          {/* 会话内搜索条：固定在内容区顶部（B8 ①），无会话时不渲染 */}
          <SessionSearchBar onActiveHitChange={handleActiveHitChange} />
          <ChatView searchHit={activeHit} />
        </>
      )}
    </main>
  );
}
