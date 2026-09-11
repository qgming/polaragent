import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ConversationSearch,
  type SearchHit,
} from "@/renderer/components/assistant-ui/elements/conversation-search";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { buildSnippet, escapeRegExp, findMatches, messageText } from "./find-matches";

export type { SearchMatch } from "./find-matches";
export { findMatches } from "./find-matches";

/** 当前命中：父组件据此把对应消息滚进视口并高亮 */
export interface SessionSearchHit {
  messageId: string;
  /** 该消息内的第几个命中（从 0 开始） */
  indexInMessage: number;
  /** 全部命中中的序号（从 0 开始） */
  globalIndex: number;
  /** 该消息的命中总数 */
  count: number;
  snippet: string;
}

/** 渲染用的命中：官方 ConversationSearch 要的上下文片段，外加定位所需的会话内信息 */
interface Hit extends SearchHit, SessionSearchHit {}

interface SessionSearchBarProps {
  /**
   * 当前命中变化回调；无命中时为 null。
   * 注意：本组件只负责搜索与计数，滚动定位到消息由 Thread 车道消费该回调实现。
   */
  onActiveHitChange?: (hit: SessionSearchHit | null) => void;
}

/**
 * 会话内搜索（Ctrl+F）：命中计数、上下切换与滚动条刻度都由官方 ConversationSearch 呈现。
 * 打开/关闭与查询词仍由 ui-store 持有（全局搜索带入关键词也要走同一条路）。
 */
export function SessionSearchBar({ onActiveHitChange }: SessionSearchBarProps) {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.sessionSearchOpen);
  const query = useUiStore((s) => s.sessionSearchQuery);
  const setSessionSearchQuery = useUiStore((s) => s.setSessionSearchQuery);
  const closeSessionSearch = useUiStore((s) => s.closeSessionSearch);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const messagesBySession = useChatStore((s) => s.messagesBySession);

  const lastQueryRef = useRef(query);
  const [activeIndex, setActiveIndex] = useState(0);

  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];

  /**
   * 逐条命中展开成扁平的 hit 列表：官方组件需要每个命中的前后文与滚动条位置，
   * 而 findMatches 只给每条消息的首个片段，所以这里自己再扫一遍取全部出现位置。
   */
  const hits = useMemo<Hit[]>(() => {
    const keyword = query.trim();
    if (!keyword) return [];
    const pattern = new RegExp(escapeRegExp(keyword), "gi");
    const perMessage = new Map(findMatches(messages, keyword).map((m) => [m.messageId, m.count]));
    const flat: Hit[] = [];
    for (const message of messages) {
      const text = messageText(message);
      if (!text) continue;
      const count = perMessage.get(message.id) ?? 0;
      if (count === 0) continue;
      let indexInMessage = 0;
      for (const match of text.matchAll(pattern)) {
        const at = match.index ?? 0;
        const start = Math.max(0, at - 24);
        const end = Math.min(text.length, at + match[0].length + 24);
        flat.push({
          id: `${message.id}#${indexInMessage}`,
          before: (start > 0 ? "…" : "") + text.slice(start, at).replace(/\s+/g, " "),
          match: match[0],
          after:
            text.slice(at + match[0].length, end).replace(/\s+/g, " ") +
            (end < text.length ? "…" : ""),
          // 刻度取每段的中心，避免末尾命中落在 100% 时贴底溢出一半
          position: ((indexInMessage + 0.5) / count) * 100,
          messageId: message.id,
          indexInMessage,
          globalIndex: flat.length,
          count,
          snippet: buildSnippet(text, at, keyword.length),
        });
        indexInMessage += 1;
      }
    }
    return flat;
  }, [messages, query]);

  const total = hits.length;
  const safeIndex = total === 0 ? 0 : Math.min(activeIndex, total - 1);
  const activeHit = hits[safeIndex] ?? null;

  // 查询变化（含全局搜索带入关键词）时回到首个命中
  useEffect(() => {
    if (lastQueryRef.current === query) return;
    lastQueryRef.current = query;
    setActiveIndex(0);
  }, [query]);

  /**
   * 打开即聚焦输入框。官方 ConversationSearch 不转发 ref，也不自带 autoFocus，
   * 而 Enter/Esc 挂在容器上 —— 不聚焦的话焦点留在 Composer，
   * 会出现「直接打字没反应、Enter 把消息发出去、Esc 关不掉搜索条」。
   */
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);

  // 把当前命中交给父组件；本车道不负责滚动定位
  useEffect(() => {
    onActiveHitChange?.(activeHit);
  }, [activeHit, onActiveHitChange]);

  /** 循环切换命中：delta 为 +1 / -1 */
  const step = (delta: number) => {
    if (total === 0) return;
    setActiveIndex((prev) => {
      const current = Math.min(prev, total - 1);
      return (current + delta + total) % total;
    });
  };

  /** Esc：关闭并清除查询（关闭即清除高亮） */
  const closeAndClear = () => {
    setSessionSearchQuery("");
    closeSessionSearch();
  };

  // 原生监听要拿到最新的闭包，但又不能因为 total 变化就反复重挂监听
  const stepRef = useRef(step);
  const closeAndClearRef = useRef(closeAndClear);
  stepRef.current = step;
  closeAndClearRef.current = closeAndClear;

  /**
   * Esc 关闭、Enter 上下切换要挂在容器上，但官方 ConversationSearch 不转发 onKeyDown，
   * 且容器本身是不可交互元素（挂 onKeyDown 会被 a11y 规则拦），因此走原生监听。
   */
  useEffect(() => {
    if (!open) return undefined;
    const node = containerRef.current;
    if (!node) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // 中文输入法组合期间不响应快捷键
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        stepRef.current(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndClearRef.current();
      }
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="flex shrink-0 justify-center border-b border-border/60 bg-background px-4 py-2"
    >
      <ConversationSearch
        query={query}
        hits={hits}
        activeIndex={safeIndex}
        onQueryChange={setSessionSearchQuery}
        onStep={step}
        aria-label={t("chat.searchPlaceholder")}
        className="max-w-[var(--layout-thread-max-width)]"
      />
    </div>
  );
}
