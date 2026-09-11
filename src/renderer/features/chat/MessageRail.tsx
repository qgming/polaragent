import type { ThreadMessage } from "@assistant-ui/react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/** 刻度条最多展示多少格。超出时最上面一格代表「更早的消息」（见 buildTicks） */
const MAX_TICKS = 30;

/**
 * 一格的基准线长（px）。用户消息比助手回复长一档，滚动时扫一眼就能分出谁在说话；
 * 聚合格（更早的消息）最短，读起来是汇总而不是又一条消息。
 * 12px 基准 × 120% / 80% 取整，避免亚像素发虚。
 */
const BASE_WIDTH = { user: 14, assistant: 10, earlier: 8 } as const;

/**
 * hover 时的线长阶梯：光标所在那格 150%，左右依次 140% / 130% / 120% / 110%，
 * 再远回到 100%。于是 hover 在哪一格是可以一眼看出来的（不只靠颜色），
 * 同时整条轨道呈现一段以光标为中心、向两边衰减的波形。
 */
const HOVER_SCALE = [1.5, 1.4, 1.3, 1.2, 1.1] as const;

/**
 * 当前读到那一格的额外加成：比 hover 峰值（150%）还长一档。
 * 聚合格（更早的消息）基准只有 8px，乘系数后仍短于默认的用户格子（14px），
 * 所以另设一个下限 —— 高亮任何时候都必须是最长、最黑的那条，否则读不出「选中」。
 */
const ACTIVE_SCALE = 1.55;
const ACTIVE_MIN_WIDTH = 17;

/** 预览面板的估算半高：用来把面板夹在视口范围内（贴顶 / 贴底那格也要完整可见） */
const PANEL_HALF = 62;

/**
 * 一格的预览文本：优先正文，其次工具名，最后推理。
 * 助手消息常常整条都是工具调用（没有正文），退回工具名比空着更有信息量。
 */
function railPreview(message: ThreadMessage): string {
  const texts: string[] = [];
  const tools: string[] = [];
  let reasoning = "";
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim() !== "") texts.push(part.text.trim());
    } else if (part.type === "tool-call") {
      tools.push(part.toolName);
    } else if (part.type === "reasoning" && reasoning === "") {
      reasoning = part.text.trim();
    }
  }
  if (texts.length > 0) return texts.join("\n");
  if (tools.length > 0) return tools.join(" · ");
  return reasoning;
}

interface RailTick {
  key: string;
  /** 这一格跳到哪条消息 */
  targetId: string;
  /** 这一格对应的消息；null = 「更早的消息」那一格（聚合，没有单条消息） */
  message: ThreadMessage | null;
  /** 聚合格里没被逐格画出来的消息条数 */
  hiddenCount: number;
  /** 这一格的基准线长 */
  base: number;
}

/**
 * 刻度条的数据：最近 MAX_TICKS 条消息，一条一格。
 *
 * 超出上限时最上面多出一格「更早的消息」，代表没有逐格画出来的那些（点它跳到已加载的最早一条，
 * 继续往上滚还会自动翻页，见 Thread 里的哨兵）。取**最近**的若干条而不是最早的，
 * 因为这条轨道服务的是「刚说过的话在哪」，越近越常回看。
 *
 * 纯函数、不碰 i18n：文案在渲染时按当前语言解析，切换语言才会跟着换。
 */
function buildTicks(messages: readonly ThreadMessage[]): RailTick[] {
  const overflow = messages.length > MAX_TICKS;
  const shown = overflow ? messages.slice(-(MAX_TICKS - 1)) : messages;
  const ticks: RailTick[] = [];

  const first = messages[0];
  if (overflow && first !== undefined) {
    ticks.push({
      key: "earlier",
      targetId: first.id,
      message: null,
      hiddenCount: messages.length - shown.length,
      base: BASE_WIDTH.earlier,
    });
  }

  for (const message of shown) {
    ticks.push({
      key: message.id,
      targetId: message.id,
      message,
      hiddenCount: 0,
      base: message.role === "user" ? BASE_WIDTH.user : BASE_WIDTH.assistant,
    });
  }
  return ticks;
}

/**
 * 消息地图：对话区**左缘**的一条刻度轨道，一条消息一格。
 *
 * · 左侧让开 8px（gap-2），与侧栏分界线之间留出同样的呼吸；整体在界面高度上垂直居中；
 *   线长 2px、槽位 10px（上下各 4px），相邻两条线之间因此也正好 8px —— 与左边距同值；
 * · hover / 键盘聚焦某格 → 线长按 150% / 140% / 130% / 120% / 110% 向两侧衰减，
 *   颜色同时加深，并在该格右侧弹出这条消息的预览（角色 + 内容摘要）；
 * · 点击 → 跳到那条消息。跳转复用搜索模态窗那条通道（ui-store 的 jumpToMessage）：
 *   定位（滚到视口中央、尊重 prefers-reduced-motion）与左侧竖条标记都在 Thread 里统一处理，
 *   这里不另写一份滚动逻辑，也顺带让「跳到了哪条」有个持续可见的落点；
 * · 页面上能看到的最下面那一条加深加长，滚动时用 rAF 节流重算。
 *
 * 每格的 hit 区等于它的槽位（10px：线 2px + 上下各 4px），刻度条整体是一块连续的命中区，
 * 格与格之间没有死区（30 格满档也只有 300px 高）。消息不足两条时不渲染 ——
 * 没有可跳的目标，留着只是噪声。
 */
export function MessageRail({
  messages,
  viewportRef,
}: {
  messages: readonly ThreadMessage[];
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ index: number; top: number } | null>(null);

  const ticks = useMemo(() => buildTicks(messages), [messages]);

  /**
   * 「高亮哪一格」的重算函数。存进 ref：滚动监听挂在视口上（只随视口重建），
   * 而「消息变多了要重算一次」是另一件事 —— 内容增高不会产生 scroll 事件，
   * 所以下面另有一个 effect 在 messages 变化时手动调它，两件事各管各的依赖。
   */
  const updateActiveRef = useRef<() => void>(() => {});

  /**
   * 重算「亮哪一格」，用 rAF 节流（一次布局读取只算一帧）。
   *
   * 触发源必须铺满：scroll 只是其中一种。会话切换、库重挂消息、流式追加都会换掉 DOM,
   * 而这些都不会产生 scroll 事件 —— 只监听 scroll 会在「消息重挂的瞬间读到空列表」，
   * 于是高亮要么被清空、要么停在旧值（实测滚到最顶时就是这样：那一刻 querySelectorAll 是空的）。
   * 所以这里同时观察 scroll、DOM 变化与高度变化，三者的回调都并到同一个 rAF。
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewportRect = viewport.getBoundingClientRect();
      // 只取消息组的**直接子节点**：assistant-ui 的 MessagePrimitive.Root 自己也打了
      // data-message-id，用后代选择器会把每条消息数两遍（外层包装 div + 库的消息根）
      const nodes = Array.from(
        viewport.querySelectorAll<HTMLElement>(
          '[data-slot="aui_message-group"] > [data-message-id]',
        ),
      );
      // 「能看到」的底边取输入框上沿：脚注是 sticky 的，盖住的那部分不算看见。
      // 量不到脚注时退回视口底边。
      const footer = viewport.querySelector('[data-slot="aui_thread-viewport-footer"]');
      const clipBottom =
        footer instanceof HTMLElement
          ? Math.min(footer.getBoundingClientRect().top, viewportRect.bottom)
          : viewportRect.bottom;

      // 亮的是「可见范围里最下面那一条」：它的顶边已经在底边之上。从末尾往前找第一条即可，
      // 顺序扫到第一个「顶边在底边之下」的就停（后面的都在它下面）。
      // 列表还没渲染出来时保持 null，不要退回第一条 —— 那是误报。
      let current: string | null = null;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (node === undefined) continue;
        if (node.getBoundingClientRect().top < clipBottom) {
          current = node.dataset.messageId ?? null;
          break;
        }
      }
      // 一条都还没进入可见范围（会话刚打开、内容还没铺满）时，指出开头那一条
      if (current === null) current = nodes[0]?.dataset.messageId ?? null;
      setActiveId(current);
    };

    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(update);
    };

    updateActiveRef.current = update;
    update();
    viewport.addEventListener("scroll", schedule, { passive: true });

    // 消息组被换掉 / 消息被重挂：childList 会响；光有消息但高度变了（流式追加、图片载入）
    // 只响 resize，也要跟。两者都并到 schedule。
    const target = viewport.querySelector('[data-slot="aui_message-group"]');
    const mutations = new MutationObserver(schedule);
    mutations.observe(viewport, { childList: true, subtree: true });
    const resize = target === null ? null : new ResizeObserver(schedule);
    if (target !== null) resize?.observe(target);

    return () => {
      updateActiveRef.current = () => {};
      viewport.removeEventListener("scroll", schedule);
      mutations.disconnect();
      resize?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [viewportRef]);

  // 消息变化后重算一次：新消息刚渲染进 DOM，当前读到的那条可能已经变了
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息变化就是这次的触发条件
  useEffect(() => {
    updateActiveRef.current();
  }, [messages]);

  if (messages.length < 2) return null;

  /** 预览面板的标题：消息的角色，或「更早的消息」 */
  const tickTitle = (tick: RailTick) =>
    tick.message === null
      ? t("chat.messageMapEarlier")
      : tick.message.role === "user"
        ? t("chat.messageMapUser")
        : t("chat.messageMapAssistant");

  /** 预览面板的正文：聚合格给出条数，其余取消息摘要 */
  const tickPreview = (tick: RailTick) =>
    tick.message === null
      ? t("chat.messageMapEarlierCount", { count: tick.hiddenCount })
      : railPreview(tick.message);

  /**
   * 亮的是哪一格。
   *
   * activeId 有可能落在刻度窗口之外：消息超过 30 条时轨道只画最近 30 格，
   * 此时「底部可见的那条」可能是更早的消息，找不到对应刻度。
   * 这种情况点亮最上面那一格 —— 它就是「更早的消息」，正是那些消息所在的位置。
   * （早先的实现会退回首条消息，视觉上就变成「永远亮着最顶那格」。）
   */
  const matchedIndex =
    activeId === null ? -1 : ticks.findIndex((tick) => tick.targetId === activeId);
  const activeTickIndex = activeId === null ? -1 : matchedIndex === -1 ? 0 : matchedIndex;

  /**
   * 这一格此刻的线长：hover 波形（150% 起，逐格衰减）× 基准线长；
   * 当前读到那一格不看波形，直接取「基准 × 155%」，并且不低于 ACTIVE_MIN_WIDTH ——
   * 聚合格（更早的消息）基准只有 8px，乘以系数仍短于默认的用户格子，
   * 那时「最黑的那条」会比旁边的短，看起来反而像没选中。下限保证它永远是最长的。
   */
  const tickWidth = (tick: RailTick, index: number, isActive: boolean): number => {
    if (isActive) return Math.max(tick.base * ACTIVE_SCALE, ACTIVE_MIN_WIDTH);
    const wave = hovered === null ? 1 : (HOVER_SCALE[Math.abs(index - hovered.index)] ?? 1);
    return tick.base * wave;
  };

  /** 悬浮/聚焦某格：把预览面板对到那一格的中心，并夹在视口范围内 */
  const showPreview = (index: number, node: HTMLElement) => {
    const rail = railRef.current;
    if (rail === null) return;
    const railBox = rail.getBoundingClientRect();
    const slot = node.getBoundingClientRect();
    const center = slot.top + slot.height / 2 - railBox.top;
    const maxTop = Math.max(PANEL_HALF, railBox.height - PANEL_HALF);
    setHovered({ index, top: Math.min(Math.max(center, PANEL_HALF), maxTop) });
  };

  const hoveredTick = hovered === null ? undefined : ticks[hovered.index];

  return (
    // 定位层：w-8（32px）= 左边距 8px + 最大线长（用户消息 hover 时 21px）再留点余量；
    // 本身不接指针事件，只作刻度与预览面板的定位基准
    <div ref={railRef} className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8">
      <nav
        aria-label={t("chat.messageMap")}
        // 轨道本体：离分界线 8px、垂直居中。这里**不设 gap** —— 8px 的线间距由
        // 每格 10px 的槽位高度（线 2px 居中，上下各 4px）给出，槽位首尾相接，
        // 于是整条刻度既是 8px 的视觉间距，又是一块没有死区的连续命中区。
        className="pointer-events-auto absolute top-1/2 left-2 flex -translate-y-1/2 flex-col"
      >
        {ticks.map((tick, index) => {
          const isActive = index === activeTickIndex;
          const width = tickWidth(tick, index, isActive);
          const isHovered = hovered?.index === index;
          return (
            <button
              // 消息 id 在这批消息里是唯一的：Thread 的消息渲染也用它做 key
              // （跳转按 data-message-id 查 DOM，重复 id 会先坏在那边）
              key={tick.key}
              type="button"
              aria-label={`${t("chat.messageMapJump")}：${tickTitle(tick)}${
                tickPreview(tick) === "" ? "" : `，${tickPreview(tick).slice(0, 40)}`
              }`}
              onMouseEnter={(event) => showPreview(index, event.currentTarget)}
              onFocus={(event) => showPreview(index, event.currentTarget)}
              onMouseLeave={() => setHovered(null)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                setHovered(null);
                const sessionId = useChatStore.getState().activeSessionId;
                if (sessionId === null) return;
                useUiStore.getState().jumpToMessage(sessionId, tick.targetId);
              }}
              // h-2.5（10px）= 线 2px + 上下各 4px，相邻格之间因此 8px；命中区就是槽位本身
              className="flex h-2.5 w-8 items-center outline-none"
            >
              <span
                style={{ width }}
                className={cn(
                  "h-0.5 rounded-full bg-foreground/15 transition-[width,background-color]",
                  "duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                  isHovered && "bg-foreground/45",
                  // 当前那格最黑：它是「读到哪了」的常驻标记，必须一眼看得出来，
                  // 所以比 hover 再深一档（hover 是瞬时的，读数靠它反而会晃）
                  isActive && "bg-foreground/65",
                )}
              />
            </button>
          );
        })}
      </nav>

      {/* 预览面板：不接指针事件，鼠标从刻度移向它时不会来回闪 */}
      {hovered !== null && hoveredTick !== undefined && (
        <div
          role="tooltip"
          style={{ top: hovered.top, transform: "translateY(-50%)" }}
          className={cn(
            "pointer-events-none absolute left-full ml-2 w-72 rounded-xl p-3",
            "border border-border/60 bg-popover text-popover-foreground shadow-[var(--composer-shadow)]",
          )}
        >
          <p className={cn(mono, "text-foreground/35")}>{tickTitle(hoveredTick)}</p>
          <p
            className={cn(
              "mt-1.5 max-h-28 overflow-hidden text-[13px] leading-relaxed",
              "whitespace-pre-wrap text-foreground/80",
            )}
          >
            {tickPreview(hoveredTick) === "" ? t("chat.messageMapEmpty") : tickPreview(hoveredTick)}
          </p>
        </div>
      )}
    </div>
  );
}
