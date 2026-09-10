/** 时间与数值格式化工具：用于侧边栏分组、token 与时长显示 */

/** 去掉小数末尾的 0（1.0 → 1、1.20 → 1.2） */
function trimZero(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** 距今相对日期：今天 / 昨天 / M月D日（跨年带年份） */
export function formatRelativeDay(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 除以 86400000 用 round 兜底夏令时导致的 23/25 小时差
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (date.getFullYear() !== today.getFullYear()) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** HH:mm */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** token 数缩写：999 / 1.2k / 100k / 1.24M */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trimZero((n / 1_000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(2))}M`;
}

/** 时长缩写：0.5s / 1.2s / 45s / 2m3s / 5m */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${trimZero(totalSeconds.toFixed(1))}s`;
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const total = Math.round(totalSeconds);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/** 字节数缩写：512B / 1.5KB / 3.2MB / 1.1GB */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${trimZero((n / 1024).toFixed(1))}KB`;
  if (n < 1024 ** 3) return `${trimZero((n / 1024 ** 2).toFixed(1))}MB`;
  return `${trimZero((n / 1024 ** 3).toFixed(1))}GB`;
}
