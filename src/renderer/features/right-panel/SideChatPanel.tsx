import { MessageSquarePlus, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { field, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { ChatMessage } from "@/shared/contracts/session";
import { PanelEmpty, PanelError } from "./panel-view";

/**
 * 侧边聊天：一条独立于主线程的小对话。
 *
 * **为什么单独建一个会话，而不是复用主线程**：主线程是一个连续上下文，
 * 往里面塞「帮我解释这个正则」这类边角问题会污染它的历史，也会改变后续的
 * 提示词与 token 计费。侧边聊天有自己的 session（sessionId 存在主进程的会话库里），
 * 所以它与主线程互不干扰，关掉面板再打开还能接着聊。
 *
 * **为什么直接调 IPC 而不是复用 chat-store**：chat-store 的 send/createSession 都是
 * 围绕「当前活动会话」（activeSessionId）写的 —— 那是主线程的口径。用它来发侧边会话，
 * 会把主线程的活动会话切走（用户会看到主区跳到另一个对话）。
 * 这里因此自己拿一个 sessionId，消息也自有状态，与 chat-store 完全隔离。
 *
 * 代价：侧边会话没有主线程那套完整能力（工具调用卡、审批、待办都不渲染）——
 * 它服务的是「问一句、看一段回答」，不承担复杂任务。这与它的定位一致。
 */

/**
 * 侧边会话 id 的跨挂载记忆。
 *
 * 面板切到别的视图时组件会卸载（见 RightSidebar 的说明），如果 id 只存在 state 里，
 * 每次切回来都会新建一个会话 —— 上一次的对话就再也找不到了。
 * 存在模块级变量而不是 sessionStorage：这是「本次运行内的界面状态」，
 * 没有跨窗口/跨重启共享的意义，也不需要它活过应用退出。
 * 应用重启后重新建一个会话是正确的：会话内容本来就在磁盘上，
 * 但「用户上次在看哪一条」不值得持久化。
 */
let rememberedSideSessionId: string | null = null;
/**
 * 侧边会话的事件 reducer。
 *
 * 只处理主线程 reducer（chat-store.applyEvent）里与「读一条回答」相关的四类事件：
 * run-started / message-added / part-upsert / message-updated。
 * 其余（审批、提问、作业、压缩）在侧边聊天里没有 UI，忽略它们比假装处理更诚实 ——
 * 侧边会话本来就不带工具与审批（见文件头的取舍说明）。
 *
 * 去重按 message id：主进程的 message-added 可能对同一条消息发两次
 *（乐观回显 + 落盘确认），用 id 收敛成一次 upsert。
 */
function reduceSideEvent(
  messages: readonly ChatMessage[],
  event: ChatEventEnvelope["event"],
): readonly ChatMessage[] {
  switch (event.type) {
    case "message-added": {
      const index = messages.findIndex((item) => item.id === event.message.id);
      if (index < 0) return [...messages, event.message];
      return messages.map((item, i) => (i === index ? event.message : item));
    }
    case "part-upsert": {
      return messages.map((message) => {
        if (message.id !== event.messageId) return message;
        const parts = [...message.parts];
        if (event.partIndex < parts.length) parts[event.partIndex] = event.part;
        else parts.push(event.part);
        return { ...message, parts };
      });
    }
    case "message-updated": {
      return messages.map((message) =>
        message.id === event.messageId ? { ...message, ...event.patch } : message,
      );
    }
    default:
      return messages;
  }
}

export function SideChatPanel(): React.JSX.Element {
  const { t } = useTranslation();

  /** 侧边会话 id；首次进入时为 null，挂载后立刻创建 */
  const [sessionId, setSessionId] = useState<string | null>(rememberedSideSessionId);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** 消息列表的滚动容器：新消息到达时滚到底 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 当前会话 id 的镜像：事件回调里要判断「这条事件是不是我的会话」 */
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  /**
   * 建立（或找回）侧边会话。
   *
   * 已有记忆的 id 就直接用：会话可能已经被用户删掉了，但那要等第一次发送时才暴露
   *（loadMessages 对未知 id 返回空页而不是抛错），此时新建一个即可。
   * 这里不预检，省一次 IPC。
   */
  useEffect(() => {
    if (sessionId !== null) return;
    let cancelled = false;
    void window.oint.sessions
      .create({ title: t("rightPanel.sideChat") })
      .then((session) => {
        if (cancelled) return;
        rememberedSideSessionId = session.id;
        setSessionId(session.id);
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, t]);

  /**
   * 载入历史 + 订阅事件流。
   *
   * 事件流是这条会话**唯一**的消息来源（发送时不乐观插入，见下面 send 的说明），
   * 所以只处理 sessionId 与自己相符的事件，其余（主线程的）一律忽略。
   */
  useEffect(() => {
    if (sessionId === null) return undefined;

    let cancelled = false;
    void window.oint.sessions
      .loadMessages(sessionId)
      .then((page) => {
        if (!cancelled) setMessages(page.messages);
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });

    const unsubscribe = window.oint.chat.onEvent((payload) => {
      // onEvent 的信封带会话归属；只有属于自己的才处理
      // onEvent 的信封带会话归属；只有属于自己的才处理
      if (payload.sessionId !== sessionIdRef.current) return;
      if (payload.event.type === "run-started") setRunning(true);
      if (payload.event.type === "run-ended") setRunning(false);
      setMessages((current) => reduceSideEvent(current, payload.event));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  /*
    新消息到达就滚到底：小对话里「看到最新一句」比「保住阅读位置」重要得多。

    依赖 messages 是**意图**而非计算需要 —— 效果体只读容器的 scrollHeight，
    但它的意义就是「列表变了才滚」。流式期间 part-upsert 会不断换掉数组引用，
    正好让跟随输出也一并生效（这是想要的）。
  */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 列表变化是触发条件，不是计算输入
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
  }, [messages]);

  const send = async () => {
    const sessionIdNow = sessionIdRef.current;
    const text = draft.trim();
    if (sessionIdNow === null || text === "") return;

    setDraft("");
    setError(null);
    /*
      直接调 IPC，不做乐观插入。
      乐观插入要在本地先造一条 ChatMessage 并去重主进程回显的同一条（见 chat-store.send
      传的 messageId）；侧边聊天对「立刻看到自己那句话」没有那么强的要求，
      而多一条去重逻辑就多一处会出错的地方（重复显示、或消息顺序错乱）。
      主进程的 message-added 事件几乎立刻到达，这里等它。
    */
    try {
      await window.oint.chat.send(sessionIdNow, text);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // 发送失败把草稿放回去：用户不必重打一遍
      setDraft(text);
    }
  };

  const stop = () => {
    const sessionIdNow = sessionIdRef.current;
    if (sessionIdNow === null) return;
    void window.oint.chat.stop(sessionIdNow);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 没有自己的标题行：面板头部已经显示「侧边聊天」，
          而这一屏也没有需要常驻的动作（发送键在输入框里）。 */}
      {error !== null && <PanelError message={error} />}

      <div ref={scrollRef} className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <PanelEmpty
            icon={MessageSquarePlus}
            title={t("rightPanel.sideChatEmpty")}
            hint={t("rightPanel.sideChatHint")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <SideMessage key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>

      {/* 输入区：与主区 Composer 同一个口径（textarea + 发送键），但没有附件/斜杠/模型 chip ——
          侧边聊天不承担那些职责，多放一个入口就多一处要解释的东西 */}
      <div className="shrink-0 border-t border-border/60 p-2">
        <div className={cn(field, "flex items-end gap-1.5 rounded-xl p-1.5")}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送、Shift+Enter 换行：与主区 Composer 一致
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={t("chat.inputPlaceholder")}
            aria-label={t("chat.inputPlaceholder")}
            className="app-scrollbar max-h-32 min-h-[2rem] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-ink-4"
          />
          {running ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
              onClick={stop}
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.send")}
              title={t("chat.send")}
              disabled={draft.trim() === "" || sessionId === null}
              onClick={() => void send()}
            >
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 一条消息。
 *
 * 正文按纯文本渲染（外层 whitespace-pre-wrap 保留换行）：侧边聊天的主要用途是查证与解释，
 * 回答里常常是短代码、路径、正则 —— 这些用纯文本原样显示最直接，也不需要为它挂一套
 * Markdown 渲染管线（那套依赖 assistant-ui 的 runtime 上下文，见文件头的取舍说明）。
 *
 * 用户消息靠右、带底色；助手消息靠左、用正文墨色。两者共用同一个气泡形状，
 * 差别只在对齐与底 —— 这个尺寸的栏里，再多一档视觉区分就成了噪声。
 */
function SideMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser && "justify-end")}>
      <div
        className={cn(
          "max-w-[92%] rounded-xl px-2.5 py-1.5 text-[13px] leading-relaxed whitespace-pre-wrap",
          isUser ? "bg-accent text-accent-foreground" : "text-ink-2",
          !isUser && message.status === "streaming" && "opacity-90",
        )}
      >
        {text === "" ? (
          // 流式期第一个 part 还没到：给一个占位，避免出现一个零高度的空气泡
          <span className={cn(mono, "text-ink-4")}>…</span>
        ) : (
          // 纯文本渲染（外层 whitespace-pre-wrap 保留换行）。
          // **刻意不用 MarkdownText**：那个组件从 assistant-ui 的 part 上下文里取正文
          // （仓库里所有用法都是无 props 的 <MarkdownText />），而侧边聊天刻意不挂
          // runtime provider（见文件头说明），传 text 进去也不会被读 —— 用了只会渲染出空壳。
          text
        )}
        {/* 出错的那条要在原地说明，而不是整屏一条错误带 —— 用户要知道是哪一句失败了 */}
        {message.error !== undefined && (
          <p className="mt-1 text-[11.5px] text-destructive">{message.error}</p>
        )}
      </div>
    </div>
  );
}
