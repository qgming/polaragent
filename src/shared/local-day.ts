/**
 * 本地日期运算：统计数据里的「一天」是**用户所在时区的一天**，不是 UTC 的一天。
 *
 * 为什么不让两个进程各写一份：热力图的格子、趋势图的横轴、连续天数三者必须落在同一套
 * 日期上；主进程算出 `today`、渲染层据此排格子，任何一侧用了 UTC 都会出现「昨天那格的
 * 数字跑到今天」这类只在跨时区时显形的偏差。
 *
 * 日期键统一是 `YYYY-MM-DD`（本地日历日）。解析**不用** `Date.parse` ——
 * `"2026-09-24"` 会被它当成 UTC 零点解析，在 UTC+8 就变回前一天 16:00，
 * 于是「加一天」加出来还是同一天。
 */

/** 本地日历日 → `YYYY-MM-DD` */
export function dayKeyOf(at: number): string {
  return formatDayKey(new Date(at));
}

/** `YYYY-MM-DD` → 该日本地零点 */
export function dayKeyToDate(key: string): Date {
  const [year, month, day] = splitDayKey(key);
  return new Date(year, month - 1, day);
}

/** 日期键加减天数（跨月、跨年、夏令时都由 Date 自己处理） */
export function addDays(key: string, delta: number): string {
  const [year, month, day] = splitDayKey(key);
  return formatDayKey(new Date(year, month - 1, day + delta));
}

/** 两日之差（`to - from`，按日历日算；from 晚于 to 时为负） */
export function diffDays(from: string, to: string): number {
  // 用本地零点做差再按天取整：夏令时那天只有 23 小时，直接除以 86400000 会得到 0.96
  const millis = dayKeyToDate(to).getTime() - dayKeyToDate(from).getTime();
  return Math.round(millis / 86_400_000);
}

function formatDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 拆日期键；格式不对时按「1970-01-01」处理，绝不抛错（外部 JSON 可能被手改坏） */
function splitDayKey(key: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return [1970, 1, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
