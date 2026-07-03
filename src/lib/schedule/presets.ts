export type EveryUnit = "milliseconds" | "seconds" | "minutes" | "hours" | "days";

export const EVERY_UNIT_MS: Record<EveryUnit, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

export type CalendarPreset = "hourly" | "daily" | "weekly" | "monthly" | "advanced";

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

type WeekdayValue = (typeof WEEKDAY_ORDER)[number];

const WEEKDAY_INDEX = new Map<number, number>(WEEKDAY_ORDER.map((day, index) => [day, index]));

export interface ParsedCalendarPreset {
  preset: CalendarPreset;
  minute: string;
  time: string;
  weekdays: number[];
  dayOfMonth: string;
  expr: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function splitEveryMs(everyMs: number): { value: string; unit: EveryUnit } {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    return { value: "1", unit: "hours" };
  }

  const orderedUnits: EveryUnit[] = ["days", "hours", "minutes", "seconds", "milliseconds"];
  for (const unit of orderedUnits) {
    const unitMs = EVERY_UNIT_MS[unit];
    if (everyMs % unitMs === 0) {
      return { value: String(everyMs / unitMs), unit };
    }
  }

  return { value: String(everyMs), unit: "milliseconds" };
}

export function buildEveryMs(value: string | number, unit: EveryUnit): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Number.NaN;
  }
  return numeric * EVERY_UNIT_MS[unit];
}

export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59)) {
    return null;
  }

  return { hour, minute };
}

export function normalizeWeekdays(days: number[]): number[] {
  return [...new Set(days.map((day) => (day === 7 ? 0 : day)).filter((day) => WEEKDAY_INDEX.has(day as WeekdayValue)))]
    .sort((a, b) => (WEEKDAY_INDEX.get(a) ?? 99) - (WEEKDAY_INDEX.get(b) ?? 99));
}

export function buildCronExpression(input: Omit<ParsedCalendarPreset, "expr"> & { expr?: string }): string {
  if (input.preset === "advanced") {
    return input.expr?.trim() || "";
  }

  if (input.preset === "hourly") {
    const minute = Number(input.minute);
    if (!inRange(minute, 0, 59)) throw new Error("Invalid minute");
    return `${minute} * * * *`;
  }

  const parsedTime = parseClockTime(input.time);
  if (!parsedTime) throw new Error("Invalid time");

  if (input.preset === "daily") {
    return `${parsedTime.minute} ${parsedTime.hour} * * *`;
  }

  if (input.preset === "weekly") {
    const weekdays = normalizeWeekdays(input.weekdays);
    if (weekdays.length === 0) throw new Error("Invalid weekdays");
    return `${parsedTime.minute} ${parsedTime.hour} * * ${weekdays.join(",")}`;
  }

  const dayOfMonth = Number(input.dayOfMonth);
  if (!inRange(dayOfMonth, 1, 31)) throw new Error("Invalid day of month");
  return `${parsedTime.minute} ${parsedTime.hour} ${dayOfMonth} * *`;
}

export function parseCronPreset(expr: string): ParsedCalendarPreset {
  const trimmed = expr.trim();

  const hourlyMatch = trimmed.match(/^(\d{1,2}) \* \* \* \*$/);
  if (hourlyMatch) {
    const minute = Number(hourlyMatch[1]);
    if (inRange(minute, 0, 59)) {
      return {
        preset: "hourly",
        minute: String(minute),
        time: "09:00",
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: "1",
        expr: trimmed,
      };
    }
  }

  const dailyMatch = trimmed.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (dailyMatch) {
    const minute = Number(dailyMatch[1]);
    const hour = Number(dailyMatch[2]);
    if (inRange(minute, 0, 59) && inRange(hour, 0, 23)) {
      return {
        preset: "daily",
        minute: "0",
        time: `${pad2(hour)}:${pad2(minute)}`,
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: "1",
        expr: trimmed,
      };
    }
  }

  const weeklyMatch = trimmed.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/);
  if (weeklyMatch) {
    const minute = Number(weeklyMatch[1]);
    const hour = Number(weeklyMatch[2]);
    const weekdays = normalizeWeekdays(weeklyMatch[3].split(",").map((item) => Number(item)));
    if (inRange(minute, 0, 59) && inRange(hour, 0, 23) && weekdays.length > 0) {
      return {
        preset: "weekly",
        minute: "0",
        time: `${pad2(hour)}:${pad2(minute)}`,
        weekdays,
        dayOfMonth: "1",
        expr: trimmed,
      };
    }
  }

  const monthlyMatch = trimmed.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (monthlyMatch) {
    const minute = Number(monthlyMatch[1]);
    const hour = Number(monthlyMatch[2]);
    const dayOfMonth = Number(monthlyMatch[3]);
    if (inRange(minute, 0, 59) && inRange(hour, 0, 23) && inRange(dayOfMonth, 1, 31)) {
      return {
        preset: "monthly",
        minute: "0",
        time: `${pad2(hour)}:${pad2(minute)}`,
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: String(dayOfMonth),
        expr: trimmed,
      };
    }
  }

  return {
    preset: "advanced",
    minute: "0",
    time: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: "1",
    expr: trimmed,
  };
}
