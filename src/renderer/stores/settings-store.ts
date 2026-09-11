import { create } from "zustand";
import type { Settings } from "@/shared/contracts";

interface SettingsState {
  settings: Settings | null;
  loaded: boolean;
  load(): Promise<void>;
  /** 乐观更新 + 落盘，失败回滚 */
  update(patch: Partial<Settings>): Promise<void>;
  /** 把 theme 应用到 html 的 dark 类（system 跟随系统偏好） */
  applyTheme(): void;
  /** 把 chatFont / chatFontSize 写到 CSS 变量 */
  applyTypography(): void;
  /** 把 density 写到 html 的 data-density（间距令牌在 index.css 里按该属性分档） */
  applyDensity(): void;
  /** 读取设置并应用主题、排版与密度，注册系统主题监听 */
  init(): Promise<void>;
}

/** 系统主题监听器（模块级，避免重复注册） */
let mediaQuery: MediaQueryList | null = null;

function onSystemThemeChange(): void {
  const { settings, applyTheme } = useSettingsStore.getState();
  // 仅当用户选择跟随系统时才响应
  if (settings?.theme === "system") applyTheme();
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    const settings = await window.polaragent.settings.read();
    set({ settings, loaded: true });
  },

  async update(patch) {
    const prev = get().settings;
    if (!prev) return;
    const next = { ...prev, ...patch };
    set({ settings: next });
    try {
      await window.polaragent.settings.write(next);
    } catch (error) {
      // 落盘失败：回滚并告警
      set({ settings: prev });
      console.warn("settings.write 失败，已回滚", error);
      return;
    }
    if (patch.theme !== undefined) get().applyTheme();
    if (patch.chatFont !== undefined || patch.chatFontSize !== undefined) {
      get().applyTypography();
    }
    if (patch.density !== undefined) get().applyDensity();
  },

  applyTheme() {
    const { settings } = get();
    if (!settings) return;
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  },

  applyTypography() {
    const { settings } = get();
    if (!settings) return;
    const style = document.documentElement.style;
    // 字体留空 = 「跟随界面」：必须删掉变量而不是写空串。
    // 写空串会让消费侧的 var(--chat-font, var(--font-sans)) 把空值当合法值用掉，
    // 兜底字体反而失效（这也是原来「对话字体」改了没反应的一部分原因）。
    const font = settings.chatFont.trim();
    if (font === "") style.removeProperty("--chat-font");
    else style.setProperty("--chat-font", font);
    style.setProperty("--chat-font-size", `${settings.chatFontSize}px`);
  },

  applyDensity() {
    const { settings } = get();
    if (!settings) return;
    document.documentElement.dataset.density = settings.density;
  },

  async init() {
    await get().load();
    get().applyTheme();
    get().applyTypography();
    get().applyDensity();
    // 替换旧的监听器，保证只挂一个
    mediaQuery?.removeEventListener("change", onSystemThemeChange);
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", onSystemThemeChange);
  },
}));
