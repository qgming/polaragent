import { useTranslation } from "react-i18next";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import { ChatView } from "@/renderer/features/chat/ChatView";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";

/**
 * 主区：内容区顶栏（标题 + 运行状态）+ 对话区。
 * 顶栏不再承担搜索入口：搜索统一走侧栏的搜索按钮（见 SidebarShell 与 SearchModal）。
 */
export function MainShell() {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 该会话是否有一次运行在进行：live 蓝只用来表示这件事
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );

  const title = sessions.find((s) => s.id === activeSessionId)?.title ?? t("chat.newChat");

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 内容区顶栏：标题 + 运行状态 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
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

      <ChatView />
    </main>
  );
}
