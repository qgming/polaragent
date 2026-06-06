// 主题应用 hook —— 主窗口与预览窗口共用
// src/hooks/useTheme.ts
//
// 订阅 config store 的 theme 设置，应用到 <html class="dark">。
// 支持 dark / light / system（跟随系统偏好）。

import { useEffect } from "react";
import { useConfigStore } from "@/stores/config-store";

/**
 * 应用主题到当前窗口的 <html> 元素。
 * 订阅 config store 的 theme 设置（dark / light / system），
 * 并监听系统偏好变化（system 模式时）。
 */
export function useTheme() {
  const theme = useConfigStore((state) => state.settings.appearance.theme);

  useEffect(() => {
    const applyTheme = () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)")
        .matches;
      const isDark = theme === "dark" || (theme === "system" && prefersDark);
      document.documentElement.classList.toggle("dark", isDark);
    };

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);
}
