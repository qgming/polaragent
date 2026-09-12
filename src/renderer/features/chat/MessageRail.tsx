import type { ThreadMessage } from "@assistant-ui/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 *
 * 入参是这一格的**全部成员**：一次回复可能落成好几条相邻的助手消息，流式时正文写在前面那条、
 * 新内容还在后面那条生成，只看第一条会在流式途中读出空白。拼接后由面板高度与 aria-label 截断。
 */
function railPreview(members: readonly ThreadMessage[]): string {
  const texts: string[] = [];
  const tools: string[] = [];
  let reasoning = "";
  for (const message of members) {
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.trim() !== "") texts.push(part.text.trim());
      } else if (part.type === "tool-call") {
        tools.push(part.toolName);
      } else if (part.type === "reasoning" && reasoning === "") {
        reasoning = part.text.trim();
      }
    }
  }
  if (texts.length > 0) return texts.join("\n");
  if (tools.length > 0) return tools.join(" · ");
  return reasoning;
}

interface RailTick {
  key: string;
  /** 这一格跳到哪条消息。有多个成员时取**第一条**：一次回复从它的开头读起 */
  targetId: string;
  /** 这一格对应的消息（多成员时是第一条）；null = 「更早的消息」那一格（聚合，没有单条消息） */
  message: ThreadMessage | null;
  /** 这一格的成员：一次回复的全部相邻助手消息，或单独一条用户消息；聚合格为空 */
  members: readonly ThreadMessage[];
  /** members 的 id 投影。高亮查找走它（见下面 matchedIndex）：流式时视口最下面那条可能是组内任意一位 */
  memberIds: readonly string[];
  /** 聚合格里没被逐格画出来的**格数**（不是消息条数：一次回复只算一格） */
  hiddenCount: number;
  /** 这一格的基准线长 */
  base: number;
}

/**
 * 把消息切成「格」：相邻的助手消息属于**同一次运行**，合成一格；用户消息各自一格。
 *
 * 依据是 pi 每遇到一次 message_start 就新开一条助手消息（工具调用之后必然如此），
 * 所以「某条用户消息之后、下一条用户消息之前的全部助手消息」正好就是一次完整回复；
 * Thread 里运行段的起止（IsRunStart / IsRunEnd）用的也是同一个口径。
 * 纯函数：只看 role 的相邻关系，不碰 store，也不看 DOM。
 */
function groupRuns(messages: readonly ThreadMessage[]): ThreadMessage[][] {
  const groups: ThreadMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    // 相邻助手 = 同一次运行，并进上一格；用户消息（或列表开头）永远另起一格
    if (last !== undefined && message.role === "assistant" && last[0]?.role === "assistant") {
      last.push(message);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

/**
 * 刻度条的数据：最近 MAX_TICKS **格**，一格 = 一次完整的 AI 回复或一条用户消息。
 *
 * 超出上限时最上面多出一格「更早的消息」，代表没有逐格画出来的那些（点它跳到已加载的最早一条，
 * 继续往上滚还会自动翻页，见 Thread 里的哨兵）。取**最近**的若干格而不是最早的，
 * 因为这条轨道服务的是「刚说过的话在哪」，越近越常回看。
 * 折叠的单位是**格**：一次回复里的相邻助手消息不会各占一格，也就一起被折掉。
 *
 * 纯函数、不碰 i18n：文案在渲染时按当前语言解析，切换语言才会跟着换。
 */
function buildTicks(messages: readonly ThreadMessage[]): RailTick[] {
  const groups = groupRuns(messages);
  const overflow = groups.length > MAX_TICKS;
  const shown = overflow ? groups.slice(-(MAX_TICKS - 1)) : groups;
  const ticks: RailTick[] = [];

  const first = groups[0]?.[0];
  if (overflow && first !== undefined) {
    ticks.push({
      key: "earlier",
      targetId: first.id,
      message: null,
      members: [],
      memberIds: [],
      hiddenCount: groups.length - shown.length,
      base: BASE_WIDTH.earlier,
    });
  }

  for (const group of shown) {
    const head = group[0];
    if (head === undefined) continue;
    ticks.push({
      key: head.id,
      // 跳到这次回复的**开头**那条：跳转 / 搜索落点 / 高亮都按消息 id 走，新粒度不用改别处
      targetId: head.id,
      message: head,
      members: group,
      memberIds: group.map((message) => message.id),
      hiddenCount: 0,
      base: head.role === "user" ? BASE_WIDTH.user : BASE_WIDTH.assistant,
    });
  }
  return ticks;
}

/**
 * 消息地图：对话区**左缘**的一条刻度轨道，一次完整的 AI 回复一格（相邻的助手消息合成一格，
 * 见 groupRuns），用户消息各自一格。
 *
 * · 左侧让开 8px（gap-2），与侧栏分界线之间留出同样的呼吸；整体在界面高度上垂直居中；
 *   线长 2px、槽位 10px（上下各 4px），相邻两条线之间因此也正好 8px —— 与左边距同值；
 * · hover / 键盘聚焦某格 → 线长按 150% / 140% / 130% / 120% / 110% 向两侧衰减，
 *   颜色同时加深，并在该格右侧弹出这一格的预览（角色 + 内容摘要）；预览取格内全部成员，
 *   所以流式进行中的一格显示的是「已有正文 + 正在流的内容」；点击 → 跳到这一格开头的消息。
 *   定位（滚到视口中央、尊重 prefers-reduced-motion）与左侧竖条标记都在 Thread 里统一处理，
 *   这里不另写一份滚动逻辑，也顺带让「跳到了哪条」有个持续可见的落点；
 * · 页面上能看到的最下面那条所属的格加深加长，滚动时用 rAF 节流重算。
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

  /**
   * 高亮值的写入闸门：**只在值真的变了才 setState**。
   *
   * `messages` 的数组身份会随每次渲染变化（库把 thread 消息重新归一化），
   * 于是下面那个「消息变化就重算」的 effect 会在每次渲染后重跑。
   * 若这里无条件 setState，就变成 effect → setState → 重渲染 → effect 的无限循环：
   * React 嵌套更新超过 50 层会抛 #185（Maximum update depth exceeded），
   * 而没有错误边界时整棵树会被卸载 —— 表现就是流式输出中途**整屏变白**。
   * 闸门把「同值重复写入」变成 no-op，循环从根上断掉。
   */
  const commitActiveId = useCallback((next: string | null) => {
    setActiveId((prev) => (prev === next ? prev : next));
  }, []);

  const ticks = useMemo(() => buildTicks(messages), [messages]);

  /**
   * 消息集合的稳定签名：条数 + 末条 id。
   * 用它当 effect 依赖，而不是 `messages` 数组本身 —— 数组身份每次渲染都变，
   * 直接依赖会让 effect 每渲染必跑一次（内容增长已由 MutationObserver / ResizeObserver 覆盖）。
   */
  const railSignature = `${messages.length}:${messages.at(-1)?.id ?? ""}`;

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
      // 走闸门写入：同值重复写入是 no-op，避免 effect ↔ setState 互相触发
      commitActiveId(current);
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
    // commitActiveId 是 useCallback([]) 的空依赖稳定引用，加上不会让 effect 重建
  }, [viewportRef, commitActiveId]);

  // 消息集合变化后重算一次：新消息刚渲染进 DOM，当前读到的那条可能已经变了。
  // 依赖用签名而不是 messages 数组本身：数组身份每次渲染都变，直接依赖会让
  // 这个 effect 每渲染后必跑（配合下面 setState 就是 React #185 白屏的那条循环）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 签名变化才是这次的触发条件
  useEffect(() => {
    updateActiveRef.current();
  }, [railSignature]);

  // 按格数判断而不是消息条数：一次回复现在只占一格，两条相邻助手消息其实只有一格，
  // 若按消息数判断会画出孤零零一格（连不成地图）
  if (ticks.length < 2) return null;

  /** 预览面板的标题：消息的角色，或「更早的消息」 */
  const tickTitle = (tick: RailTick) =>
    tick.message === null
      ? t("chat.messageMapEarlier")
      : tick.message.role === "user"
        ? t("chat.messageMapUser")
        : t("chat.messageMapAssistant");

  /**
   * 预览面板的正文：聚合格给出格数，其余把这一格全部成员的摘要拼起来。
   * 进行中但还没产出内容的格会得到空串，调用处回落到「没有文字内容」文案，不会画成空白条。
   */
  const tickPreview = (tick: RailTick) =>
    tick.message === null
      ? t("chat.messageMapEarlierCount", { count: tick.hiddenCount })
      : railPreview(tick.members);

  /**
   * 亮的是哪一格。
   *
   * 比对的是 memberIds 而不是 targetId：activeId 是**消息 id**（视口里最下面那条），
   * 而一格装着一次回复里的好几条相邻助手消息 —— 流式时新的助手消息会不停往后开，
   * 只要还落在这一格内，高亮就留在原地，不会一格一格往下跳。
   *
   * activeId 也有可能落在刻度窗口之外：格子超过 30 时轨道只画最近 30 格，
   * 此时「底部可见的那条」可能是更早的消息，找不到对应刻度。
   * 这种情况点亮最上面那一格 —— 它就是「更早的消息」，正是那些消息所在的位置。
   * （早先的实现会退回首条消息，视觉上就变成「永远亮着最顶那格」。）
   */
  const matchedIndex =
    activeId === null ? -1 : ticks.findIndex((tick) => tick.memberIds.includes(activeId));
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
          <p className={cn(mono, "text-ink-4")}>{tickTitle(hoveredTick)}</p>
          <p
            className={cn(
              "mt-1.5 max-h-28 overflow-hidden text-[13px] leading-relaxed",
              "whitespace-pre-wrap text-ink-2",
            )}
          >
            {tickPreview(hoveredTick) === "" ? t("chat.messageMapEmpty") : tickPreview(hoveredTick)}
          </p>
        </div>
      )}
    </div>
  );
}
