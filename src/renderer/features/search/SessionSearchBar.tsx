import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { findMatches } from "./find-matches";

export type { SearchMatch } from "./find-matches";
export { findMatches } from "./find-matches";

/** 当前命中：父组件可据此把对应消息滚动进视口并高亮 */
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

interface SessionSearchBarProps {
  /**
   * 当前命中变化回调；无命中时为 null。
   * 注意：本组件只负责搜索与计数，滚动定位到消息由 Thread 车道消费该回调实现。
   */
  onActiveHitChange?: (hit: SessionSearchHit | null) => void;
}

/**
 * 会话内搜索条（B8）：固定在内容区顶部的一行。
 * 命中高亮与滚动条刻度同样由 Thread 车道基于 onActiveHitChange 实现。
 */
export function SessionSearchBar({ onActiveHitChange }: SessionSearchBarProps) {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.sessionSearchOpen);
  const query = useUiStore((s) => s.sessionSearchQuery);
  const setSessionSearchQuery = useUiStore((s) => s.setSessionSearchQuery);
  const closeSessionSearch = useUiStore((s) => s.closeSessionSearch);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const messagesBySession = useChatStore((s) => s.messagesBySession);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastQueryRef = useRef(query);
  const [activeIndex, setActiveIndex] = useState(0);

  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const matches = useMemo(() => findMatches(messages, query), [messages, query]);

  // 展开为逐条命中：携带消息内序号与全局序号，便于父组件定位
  const hits = useMemo<SessionSearchHit[]>(() => {
    const flat: SessionSearchHit[] = [];
    for (const match of matches) {
      for (let i = 0; i < match.count; i += 1) {
        flat.push({
          messageId: match.messageId,
          indexInMessage: i,
          globalIndex: flat.length,
          count: match.count,
          snippet: match.snippet,
        });
      }
    }
    return flat;
  }, [matches]);

  const total = hits.length;
  const safeIndex = total === 0 ? 0 : Math.min(activeIndex, total - 1);
  const activeHit = hits[safeIndex] ?? null;

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 查询变化（含全局搜索带入关键词）时回到首个命中
  useEffect(() => {
    if (lastQueryRef.current === query) return;
    lastQueryRef.current = query;
    setActiveIndex(0);
  }, [query]);

  // 把当前命中交给父组件；本车道不负责滚动定位
  useEffect(() => {
    onActiveHitChange?.(activeHit);
  }, [activeHit, onActiveHitChange]);

  if (!open) return null;

  /** 循环切换命中：delta 为 +1 / -1 */
  const step = (delta: number) => {
    if (total === 0) return;
    setActiveIndex((prev) => {
      const current = Math.min(prev, total - 1);
      return (current + delta + total) % total;
    });
  };

  /** Esc / 关闭按钮：关闭并清除查询（B8 ④ 关闭清除高亮） */
  const closeAndClear = () => {
    setSessionSearchQuery("");
    closeSessionSearch();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组合期间不响应快捷键
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndClear();
    }
  };

  return (
    <search className="flex h-10 shrink-0 items-center gap-2 border-border border-b bg-background px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setSessionSearchQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("chat.searchPlaceholder")}
        aria-label={t("common.search")}
        className="h-8 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
      />
      <span
        aria-live="polite"
        className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
      >
        {total === 0 ? "0/0" : `${safeIndex + 1}/${total}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("chat.searchPrev")}
        disabled={total === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("chat.searchNext")}
        disabled={total === 0}
        onClick={() => step(1)}
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("common.close")}
        onClick={closeAndClear}
      >
        <X className="size-4" />
      </Button>
    </search>
  );
}
