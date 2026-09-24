/**
 * 统计界面的读数格式：token 量级、时长、日期。
 *
 * `Intl.NumberFormat` 的 compact 记法**跟着语言走**，这正是参考界面的中文口径：
 * zh-CN 给「19.9亿 / 4254.3万」，en-US 给「2B / 1.2M」—— 同一份数据、两种语言各自
 * 落到本地人一眼能读的量级上。自己写一套换算表反而两边都别扭（中文读者不认 2B，
 * 英文读者不认 2亿）。
 */
import { dayKeyToDate } from "@/shared/local-day";

/** compact 读数：1.2亿 / 12.3M；小于 1000 时给整数（"823" 比 "823" 直白） */
export function formatTokens(value: number, language: string): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1000) return String(rounded);
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(rounded);
}

/**
 * 百分比读数：81% / 16% / 2.8% / 0.4% / <0.1%。
 *
 * 两条规则都是为了不撒谎：
 *  · 小占比（< 10%）带一位小数，否则 0.4% 会被归成「0%」，让「用过但很少」的模型
 *    看起来完全没用过；对称地，99.7% 不能显示成「100%」（那意味着「只有这一个模型」）；
 *  · 真的小到四舍五入就是 0 时（< 0.05%）写「<0.1%」而不是「0%」——
 *    图例下面那行精确 token 数会告诉用户它确实用过一点。
 */
export function formatPercent(share: number, language: string): string {
  // NaN 要显式挡掉：Math.max(0, NaN) 还是 NaN，会直接渲染出「NaN%」
  const exact = Number.isFinite(share) ? Math.min(100, Math.max(0, share * 100)) : 0;
  if (exact > 0 && exact < 0.05) {
    return `<${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(0.1)}%`;
  }
  const needsDecimal = (exact > 0 && exact < 10) || (exact > 99 && exact < 100);
  return `${new Intl.NumberFormat(language, {
    minimumFractionDigits: 0,
    maximumFractionDigits: needsDecimal ? 1 : 0,
  }).format(exact)}%`;
}

/**
 * 时长读数：天数 → 小时分钟 → 分钟 → 秒。
 *
 * 分段而不是一律折成「267 分钟」：聊天跨度几小时到几天都有，读的人要的是量级。
 * 文案走 i18n（`stats.durationXxx`），由调用方传 `t` 进来 —— 这个模块保持纯函数。
 */
export function formatDuration(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return t("stats.durationSeconds", { seconds: totalSeconds });
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return t("stats.durationMinutes", { minutes: totalMinutes });
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return t("stats.durationHours", {
      hours: totalHours,
      minutes: totalMinutes % 60,
    });
  }
  return t("stats.durationDays", {
    days: Math.floor(totalHours / 24),
    hours: totalHours % 24,
  });
}

/** 横轴 / 悬浮提示的日期：zh-CN「9月17日」，en-US「Sep 17」 */
export function formatDayLabel(dateKey: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(
    dayKeyToDate(dateKey),
  );
}

/** 热力图的月份标签：zh-CN「10月」，en-US「Oct」 */
export function formatMonthLabel(dateKey: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short" }).format(dayKeyToDate(dateKey));
}

/** 悬浮提示里的完整日期：zh-CN「2026年9月17日」，en-US「Sep 17, 2026」 */
export function formatFullDate(dateKey: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(dayKeyToDate(dateKey));
}

/** 界面语言 → Intl 用的 locale（i18n 的取值本身就是 BCP 47，直接用） */
export function localeOf(language: string | undefined): string {
  return language === undefined || language === "" ? "en-US" : language;
}
