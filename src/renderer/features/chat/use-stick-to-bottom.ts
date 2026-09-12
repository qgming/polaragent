// 贴底跟随：流式输出时，**只在用户本来就在底部**才跟着往下滚。
//
// 为什么不用 assistant-ui Viewport 自带的 autoScroll：它的 handleScroll
// （node_modules/@assistant-ui/react/dist/primitives/thread/useThreadViewportAutoScroll.js:59-70）
// 把「向上滚」和「向下滚但没到底」分开处理 —— 前者确实会停止跟随，但后者是**空分支**，
// 什么都不改，于是用户往下滑一点点（离底还很远）就会重新贴回去；手感上就是「滚动被抢」。
// 这里换成显式状态机，规则只有三条：
//   1. 向上滑一下 → 立刻停止跟随（先于距离判断，且不留窗口）；
//   2. 已经到底 → 稍等片刻恢复跟随；这段窗口里再上滑就作废；
//   3. 跟随中内容变高 → 直接贴到底。
// 用户点「滚动到底部」按钮走第 2 条：按钮把视口滚到底，滚动事件随即触发恢复。
//
// 判定逻辑与 DOM 分开：nextStickState 是纯函数，能直接单测；副作用都在 useStickToBottom 里。

import { type RefObject, useEffect, useRef } from "react";

/** 距底部多少像素内算「在底部」 */
export const STICK_THRESHOLD_PX = 8;

/** 滚到最底部之后等多久恢复跟随；期间用户再上滑就作废 */
export const STICK_RESUME_DELAY_MS = 180;

/** 距底部的像素数（内容不满一屏时为 0） */
export function distanceFromBottom(box: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);
}

export interface StickScrollSample {
  /** 上一次滚动事件时的 scrollTop；还没有过滚动事件时为 null */
  previousScrollTop: number | null;
  scrollTop: number;
  /** 当前距底部的像素数 */
  distance: number;
  /** 判定之前是否处于跟随状态 */
  following: boolean;
}

export interface StickScrollDecision {
  following: boolean;
  /** 是否需要重排一次「恢复跟随」的定时器 */
  scheduleResume: boolean;
}

/**
 * 一次滚动事件之后的跟随判定（纯函数）。
 *
 * 判定顺序是**先方向、再看距离**：反过来的话，「在底部边缘向上滑 2px」会被距离阈值判成
 * 「仍然在底部」，跟随就停不下来 —— 而用户表达的意图明明是「我要自己看」。
 */
export function nextStickState(sample: StickScrollSample): StickScrollDecision {
  const { previousScrollTop, scrollTop, distance, following } = sample;

  // 1. 向上滑：立刻停跟随，并且作废待恢复
  if (previousScrollTop !== null && scrollTop < previousScrollTop) {
    return { following: false, scheduleResume: false };
  }

  // 2. 不在底部：保持「不跟随」，也不排恢复（只有真的到底才恢复）
  if (distance > STICK_THRESHOLD_PX) return { following: false, scheduleResume: false };

  // 3. 到底了：已在跟随就什么都不做；否则等一小会儿再恢复
  return { following, scheduleResume: !following };
}

/**
 * 把贴底跟随挂到视口上。
 *
 * 挂载方式与本文件其它效果一致：用 effect 读 ref.current —— 视口就在同一个组件的 JSX 里，
 * effect 执行时它一定已经挂上了。
 */
export function useStickToBottom(viewportRef: RefObject<HTMLDivElement | null>): void {
  const followingRef = useRef(true);
  const lastScrollTopRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const cancelResume = () => {
      if (resumeTimerRef.current === null) return;
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    };

    /** 跟随中：内容变高就把视口贴到底 */
    const stick = () => {
      if (!followingRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
      // 立刻回写：这次赋值自己会派发一个 scroll 事件，别让它被当成「用户滚动」
      lastScrollTopRef.current = viewport.scrollTop;
    };

    /**
     * 流式输出每来一个 token 都会改 DOM，所以用 rAF 合并，避免每 token 都强制一次布局。
     * 不跟随时这里是空转（stick 自己会提前返回）。
     */
    const scheduleStick = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        stick();
      });
    };

    const handleScroll = () => {
      const decision = nextStickState({
        previousScrollTop: lastScrollTopRef.current,
        scrollTop: viewport.scrollTop,
        distance: distanceFromBottom(viewport),
        following: followingRef.current,
      });
      lastScrollTopRef.current = viewport.scrollTop;

      if (!decision.scheduleResume) cancelResume();
      followingRef.current = decision.following;
      if (!decision.scheduleResume) return;

      // 恢复之前再确认一次：这段窗口里内容可能又长高了，人已经不在底部，那就不该贴回去
      resumeTimerRef.current = setTimeout(() => {
        resumeTimerRef.current = null;
        if (distanceFromBottom(viewport) > STICK_THRESHOLD_PX) return;
        followingRef.current = true;
      }, STICK_RESUME_DELAY_MS);
    };

    /**
     * 内容变高不一定伴随 scroll 事件（内容在长、scrollTop 没变），所以单独观察 DOM。
     * 只观察视口子树 —— 输入框那边的变化（待办条展开之类）不该影响消息区滚动。
     */
    const observer = new MutationObserver(scheduleStick);

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });

    return () => {
      cancelResume();
      if (frameRef.current !== null) cancelFrame(frameRef);
      viewport.removeEventListener("scroll", handleScroll);
      observer.disconnect();
      // 视口换了（切会话）→ 回到默认跟随，并把基线清掉，避免拿旧会话的 scrollTop 比方向
      followingRef.current = true;
      lastScrollTopRef.current = null;
    };
  }, [viewportRef]);
}

/** rAF 取消的薄封装：把「可能为 null」的判断收在一处 */
function cancelFrame(ref: { current: number | null }): void {
  if (ref.current === null) return;
  cancelAnimationFrame(ref.current);
  ref.current = null;
}
