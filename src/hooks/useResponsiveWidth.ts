// 响应式宽度检测 hook
// 用于根据窗口宽度动态调整 UI 显示模式

import { useEffect, useState } from "react";

export type WidthBreakpoint = "narrow" | "medium" | "wide";

const DEFAULT_WINDOW_WIDTH = 1024;
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 320;

function getWindowWidth(defaultWidth = DEFAULT_WINDOW_WIDTH): number {
  return typeof window === "undefined" ? defaultWidth : window.innerWidth;
}

function getWidthBreakpoint(width: number): WidthBreakpoint {
  if (width < 600) return "narrow";
  if (width < 800) return "medium";
  return "wide";
}

export function getResponsivePanelWidth(width: number): number {
  return Math.round(
    Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width * 0.28)),
  );
}

export function useWindowWidth(defaultWidth = DEFAULT_WINDOW_WIDTH): number {
  const [width, setWidth] = useState(() => getWindowWidth(defaultWidth));

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleResize = () => setWidth(getWindowWidth(defaultWidth));

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [defaultWidth]);

  return width;
}

/**
 * 检测当前窗口宽度所属的断点区间
 * - narrow: < 600px (纯图标模式)
 * - medium: 600-800px (紧凑模式)
 * - wide: >= 800px (完整模式)
 */
export function useResponsiveWidth(): WidthBreakpoint {
  return getWidthBreakpoint(useWindowWidth());
}

export function useResponsivePanelWidth(): number {
  return getResponsivePanelWidth(useWindowWidth());
}
