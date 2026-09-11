import { ChatView } from "@/renderer/features/chat/ChatView";

/**
 * 主区：只剩对话区。
 *
 * 这里原本还有一条 44px 横带（会话标题 + 运行状态），现已合并到内容区顶栏（TitleBar）：
 * 标题与窗口控制同处一行，主区不再出现第二条横线。搜索入口仍统一在侧栏顶行。
 */
export function MainShell() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <ChatView />
    </main>
  );
}
