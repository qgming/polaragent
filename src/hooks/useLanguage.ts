// 语言应用 hook —— 订阅 config store 的语言设置，同步到 i18next
// src/hooks/useLanguage.ts
//
// 与 useTheme hook 对标：订阅 config store → 应用副作用（i18n.changeLanguage）。

import { useEffect } from "react";
import { useConfigStore } from "@/stores/config-store";
import i18n, { changeLanguage } from "@/i18n";
import { resolveLanguage } from "@/i18n/config";

/**
 * 订阅 config store 的 appearance.language 设置，
 * 当语言偏好变化时调用 i18n.changeLanguage()。
 * 支持 "system" 模式（从 navigator.language 自动推断）。
 */
export function useLanguage() {
  const language = useConfigStore(
    (state) => state.settings.appearance.language,
  );

  useEffect(() => {
    const resolved = resolveLanguage(language);
    if (i18n.language !== resolved) {
      void changeLanguage(resolved);
    }
  }, [language]);
}
