import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@/shared/i18n";

// 初始语言跟随系统：zh 前缀用简体中文，其余回落英文；中文作为兜底语言
const initialLanguage = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

export default i18n;
