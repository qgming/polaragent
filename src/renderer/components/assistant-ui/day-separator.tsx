import { useTranslation } from "react-i18next";

/**
 * 日期分隔（B3）：跨天时插入 mono 眉题横线，按当前语言格式化完整日期。
 * 由 Thread 层比较相邻消息 createdAt 后决定是否渲染。
 */
export function DaySeparator({ date }: { date: Date }) {
  const { i18n } = useTranslation();
  const label = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

/** 两个日期是否属于同一天（本地时区） */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
