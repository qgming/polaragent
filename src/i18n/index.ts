// i18next 初始化 — 必须在 React 渲染前导入
// src/i18n/index.ts

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { fallbackLanguage, namespaceList } from "./config";

// 静态导入所有语言包（确保打包后语言切换立即可用，无需异步加载）
import zhCN_common from "./locales/zh-CN/common.json";
import zhCN_settings from "./locales/zh-CN/settings.json";
import zhCN_nav from "./locales/zh-CN/nav.json";
import zhCN_chat from "./locales/zh-CN/chat.json";
import zhCN_home from "./locales/zh-CN/home.json";
import zhCN_agents from "./locales/zh-CN/agents.json";
import zhCN_knowledge from "./locales/zh-CN/knowledge.json";
import zhCN_skills from "./locales/zh-CN/skills.json";
import zhCN_tools from "./locales/zh-CN/tools.json";
import zhCN_team from "./locales/zh-CN/team.json";
import zhCN_tutorial from "./locales/zh-CN/tutorial.json";
import zhCN_schedule from "./locales/zh-CN/schedule.json";

import enUS_common from "./locales/en-US/common.json";
import enUS_settings from "./locales/en-US/settings.json";
import enUS_nav from "./locales/en-US/nav.json";
import enUS_chat from "./locales/en-US/chat.json";
import enUS_home from "./locales/en-US/home.json";
import enUS_agents from "./locales/en-US/agents.json";
import enUS_knowledge from "./locales/en-US/knowledge.json";
import enUS_skills from "./locales/en-US/skills.json";
import enUS_tools from "./locales/en-US/tools.json";
import enUS_team from "./locales/en-US/team.json";
import enUS_tutorial from "./locales/en-US/tutorial.json";
import enUS_schedule from "./locales/en-US/schedule.json";

/** 语言资源表：key 为 BCP 47 语言代码，value 为各命名空间翻译 */
const resources = {
  "zh-CN": {
    common: zhCN_common,
    settings: zhCN_settings,
    nav: zhCN_nav,
    chat: zhCN_chat,
    home: zhCN_home,
    agents: zhCN_agents,
    knowledge: zhCN_knowledge,
    skills: zhCN_skills,
    tools: zhCN_tools,
    team: zhCN_team,
    tutorial: zhCN_tutorial,
    schedule: zhCN_schedule,
  },
  "en-US": {
    common: enUS_common,
    settings: enUS_settings,
    nav: enUS_nav,
    chat: enUS_chat,
    home: enUS_home,
    agents: enUS_agents,
    knowledge: enUS_knowledge,
    skills: enUS_skills,
    tools: enUS_tools,
    team: enUS_team,
    tutorial: enUS_tutorial,
    schedule: enUS_schedule,
  },
};

/**
 * 初次语言检测：
 *   1. 优先读取 localStorage 缓存（上次运行写入）
 *   2. 否则从 navigator.language 推断
 * 不使用 i18next-browser-languagedetector——Electron 环境下 localStorage 跨 window origin 冲突。
 */
function getInitialLanguage(): string {
  try {
    const cached = localStorage.getItem("polaragent-lang");
    if (cached) return cached;
  } catch (e) {
    console.warn("无法读取 localStorage:", e);
  }
  
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("zh")) return "zh-CN";
  return "en-US";
}

// 立即同步初始化 i18next
// 所有资源已静态导入，无异步依赖，init() 会立即返回
i18n.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: fallbackLanguage,
  ns: namespaceList,
  defaultNS: "common",
  interpolation: { escapeValue: false },
  // React 19 兼容配置
  react: {
    useSuspense: false, // 禁用 Suspense，避免异步加载问题
  },
});

export default i18n;

/** 供 useLanguage hook 调用：切换语言并同步 localStorage */
export function changeLanguage(lang: string) {
  try {
    localStorage.setItem("polaragent-lang", lang);
  } catch (e) {
    console.warn("无法写入 localStorage:", e);
  }
  return i18n.changeLanguage(lang);
}
