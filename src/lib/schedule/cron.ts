import type { ScheduleCronConfig } from "@/types/schedule";

interface CronField {
  values: Set<number>;
}

interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

function parseNumber(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 范围无效: ${value}`);
  }
  return parsed;
}

function expandPart(part: string, min: number, max: number, label: string): number[] {
  const trimmed = part.trim();
  if (!trimmed) throw new Error(`${label} 不能为空`);

  const [rangeSource, stepSource] = trimmed.split("/");
  const step = stepSource ? parseNumber(stepSource, 1, max - min + 1, `${label} 步长`) : 1;

  if (rangeSource === "*") {
    const values: number[] = [];
    for (let value = min; value <= max; value += step) {
      values.push(value);
    }
    return values;
  }

  const [startSource, endSource] = rangeSource.split("-");
  const start = parseNumber(startSource, min, max, `${label} 起点`);
  const end = endSource
    ? parseNumber(endSource, min, max, `${label} 终点`)
    : start;

  if (end < start) {
    throw new Error(`${label} 范围无效: ${trimmed}`);
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function parseField(source: string, min: number, max: number, label: string, mapSunday = false): CronField {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    for (const value of expandPart(part, min, max, label)) {
      if (mapSunday && value === 7) {
        values.add(0);
      } else {
        values.add(value);
      }
    }
  }
  return { values };
}

export function parseCronExpression(expr: string): ParsedCronExpression {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron 表达式必须包含 5 段: 分 时 日 月 周");
  }

  return {
    minute: parseField(parts[0], 0, 59, "分钟"),
    hour: parseField(parts[1], 0, 23, "小时"),
    dayOfMonth: parseField(parts[2], 1, 31, "日期"),
    month: parseField(parts[3], 1, 12, "月份"),
    dayOfWeek: parseField(parts[4], 0, 7, "星期", true),
  };
}

function matches(field: CronField, value: number): boolean {
  return field.values.has(value);
}

export function nextCronOccurrence(expr: string, fromMs: number): number {
  const parsed = parseCronExpression(expr);
  const cursor = new Date(fromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (
      matches(parsed.minute, cursor.getMinutes()) &&
      matches(parsed.hour, cursor.getHours()) &&
      matches(parsed.dayOfMonth, cursor.getDate()) &&
      matches(parsed.month, cursor.getMonth() + 1) &&
      matches(parsed.dayOfWeek, cursor.getDay())
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new Error(`Cron 表达式在可搜索范围内没有下一个触发时间: ${expr}`);
}

export function validateCronConfig(schedule: ScheduleCronConfig): void {
  parseCronExpression(schedule.expr);
}

