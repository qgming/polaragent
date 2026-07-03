// i18n 语言配置常量与工具函数
// src/i18n/config.ts

/** 支持的语言选项（下拉框用） */
export const supportedLanguages = [
  { value: "system", label: "跟随系统", labelEn: "System" },
  { value: "zh-CN", label: "简体中文", labelEn: "Simplified Chinese" },
  { value: "en-US", label: "English", labelEn: "English" },
] as const;

/** i18n 语言类型，与 Settings.appearance.language 的 union 同步 */
export type LanguageValue = (typeof supportedLanguages)[number]["value"];

/** 回退语言（当翻译缺失时使用） */
export const fallbackLanguage = "zh-CN";

/** i18n 命名空间列表 */
export const namespaceList = ["common", "settings", "nav", "chat", "home", "agents", "knowledge", "skills", "tools", "team", "tutorial", "schedule"] as const;

/**
 * 将用户设置中的 language 值解析为实际 BCP 47 语言代码。
 * "system" 模式下从 navigator.language 推断，其他值直接返回。
 */
export function resolveLanguage(preference: string): string {
  if (preference === "system" || !preference) {
    return normalizeNavLang(navigator.language);
  }
  return preference;
}

/**
 * 将 navigator.language 映射为项目支持的语言代码。
 * 不认识的语言回退到 en-US。
 */
function normalizeNavLang(lang: string): string {
  const lower = lang.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return "en-US";
}
