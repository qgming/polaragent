import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsUpDown,
  Clock3,
  ExternalLink,
  FolderOpen,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  SettingDropdown,
} from "@/components/settings/settings-shared";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  openPath,
  pickWorkingDirectory,
} from "@/lib/electron/electron-api";
import {
  buildCronExpression,
  buildEveryMs,
  parseCronPreset,
  splitEveryMs,
  WEEKDAY_ORDER,
  type CalendarPreset,
  type EveryUnit,
} from "@/lib/schedule/presets";
import { cn } from "@/lib/utils";
import type { AgentConfig } from "@/types/config";
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@/types/schedule";

type ScheduleMode = "at" | "every" | "cron";

type SchedulePlanValue = "at" | "every" | CalendarPreset;

interface EditorState {
  name: string;
  enabled: boolean;
  mode: ScheduleMode;
  runAt: string;
  repeatValue: string;
  repeatUnit: EveryUnit;
  calendarPreset: CalendarPreset;
  calendarMinute: string;
  calendarTime: string;
  calendarWeekdays: number[];
  calendarDayOfMonth: string;
  cronExpr: string;
  message: string;
  workingDir: string;
  agentId: string;
}

interface ScheduleEditorModalProps {
  open: boolean;
  task?: ScheduledTask | null;
  agents: AgentConfig[];
  onClose: () => void;
  onSave: (request: CreateScheduledTaskRequest | UpdateScheduledTaskRequest) => Promise<void> | void;
}

const FIELD_INPUT_CLASS =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20";

const DROPDOWN_TRIGGER_CLASS = "h-10 w-full justify-between rounded-lg px-3 text-sm";
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const REPEAT_PRESETS: Array<{ value: string; unit: EveryUnit; labelKey: string }> = [
  { value: "15", unit: "minutes", labelKey: "editor.repeatPresets.15m" },
  { value: "30", unit: "minutes", labelKey: "editor.repeatPresets.30m" },
  { value: "1", unit: "hours", labelKey: "editor.repeatPresets.1h" },
  { value: "6", unit: "hours", labelKey: "editor.repeatPresets.6h" },
  { value: "1", unit: "days", labelKey: "editor.repeatPresets.1d" },
];

const REPEAT_UNIT_OPTIONS: EveryUnit[] = ["minutes", "hours", "days", "seconds", "milliseconds"];

const WEEKDAY_KEYS: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

const SCHEDULE_PLAN_OPTIONS: SchedulePlanValue[] = ["at", "every", "hourly", "daily", "weekly", "monthly", "advanced"];

function formatDateTimeInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createEmptyEditor(): EditorState {
  return {
    name: "",
    enabled: true,
    mode: "at",
    runAt: "",
    repeatValue: "1",
    repeatUnit: "hours",
    calendarPreset: "daily",
    calendarMinute: "0",
    calendarTime: "09:00",
    calendarWeekdays: [1, 2, 3, 4, 5],
    calendarDayOfMonth: "1",
    cronExpr: "0 9 * * *",
    message: "",
    workingDir: "",
    agentId: "default",
  };
}

function editorFromTask(task: ScheduledTask): EditorState {
  const base = createEmptyEditor();

  if (task.schedule.kind === "at") {
    return {
      ...base,
      name: task.name,
      enabled: task.enabled,
      mode: "at",
      runAt: formatDateTimeInput(task.schedule.at),
      message: task.payload.message,
      workingDir: task.payload.workingDir || "",
      agentId: task.payload.agentId || "default",
    };
  }

  if (task.schedule.kind === "every") {
    const every = splitEveryMs(task.schedule.everyMs);
    return {
      ...base,
      name: task.name,
      enabled: task.enabled,
      mode: "every",
      repeatValue: every.value,
      repeatUnit: every.unit,
      message: task.payload.message,
      workingDir: task.payload.workingDir || "",
      agentId: task.payload.agentId || "default",
    };
  }

  const cronPreset = parseCronPreset(task.schedule.expr);
  return {
    ...base,
    name: task.name,
    enabled: task.enabled,
    mode: "cron",
    calendarPreset: cronPreset.preset,
    calendarMinute: cronPreset.minute,
    calendarTime: cronPreset.time,
    calendarWeekdays: cronPreset.weekdays,
    calendarDayOfMonth: cronPreset.dayOfMonth,
    cronExpr: cronPreset.expr,
    message: task.payload.message,
    workingDir: task.payload.workingDir || "",
    agentId: task.payload.agentId || "default",
  };
}

function buildCalendarExpr(editor: EditorState, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (editor.calendarPreset === "advanced") {
    if (!editor.cronExpr.trim()) {
      throw new Error(t("validation.cronRequired"));
    }
    return editor.cronExpr.trim();
  }

  try {
    return buildCronExpression({
      preset: editor.calendarPreset,
      minute: editor.calendarMinute,
      time: editor.calendarTime,
      weekdays: editor.calendarWeekdays,
      dayOfMonth: editor.calendarDayOfMonth,
      expr: editor.cronExpr,
    });
  } catch {
    if (editor.calendarPreset === "hourly") {
      throw new Error(t("validation.hourlyMinuteInvalid"));
    }
    if (editor.calendarPreset === "weekly") {
      throw new Error(t("validation.weeklyInvalid"));
    }
    if (editor.calendarPreset === "monthly") {
      throw new Error(t("validation.monthlyInvalid"));
    }
    throw new Error(t("validation.calendarTimeInvalid"));
  }
}

function getSchedulePlan(editor: EditorState): SchedulePlanValue {
  if (editor.mode === "at") return "at";
  if (editor.mode === "every") return "every";
  return editor.calendarPreset;
}

function setSchedulePlan(editor: EditorState, value: SchedulePlanValue): EditorState {
  if (value === "at") {
    return { ...editor, mode: "at" };
  }

  if (value === "every") {
    return { ...editor, mode: "every" };
  }

  return {
    ...editor,
    mode: "cron",
    calendarPreset: value,
  };
}

function toRequest(editor: EditorState, t: (key: string, options?: Record<string, unknown>) => string): CreateScheduledTaskRequest {
  if (!editor.name.trim()) throw new Error(t("validation.nameRequired"));
  if (!editor.message.trim()) throw new Error(t("validation.messageRequired"));

  return {
    name: editor.name.trim(),
    description: "",
    enabled: editor.enabled,
    schedule: (() => {
      if (editor.mode === "at") {
        if (!editor.runAt) throw new Error(t("validation.atRequired"));
        return { kind: "at", at: new Date(editor.runAt).toISOString() } as const;
      }

      if (editor.mode === "every") {
        const everyMs = buildEveryMs(editor.repeatValue, editor.repeatUnit);
        if (!Number.isFinite(everyMs) || everyMs <= 0) {
          throw new Error(t("validation.everyRequired"));
        }

        return {
          kind: "every",
          everyMs,
        } as const;
      }

      return {
        kind: "cron",
        expr: buildCalendarExpr(editor, t),
      } as const;
    })(),
    payload: {
      kind: "agentTurn",
      message: editor.message.trim(),
      ...(editor.workingDir.trim() ? { workingDir: editor.workingDir.trim() } : {}),
      ...(editor.agentId.trim() ? { agentId: editor.agentId.trim() } : {}),
      permissionMode: "ai_review",
    },
    missedRunPolicy: "run_latest",
  };
}

export function ScheduleEditorModal({
  open,
  task,
  agents,
  onClose,
  onSave,
}: ScheduleEditorModalProps) {
  const { t } = useTranslation("schedule");
  const [editor, setEditor] = useState<EditorState>(createEmptyEditor());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEditor(task ? editorFromTask(task) : createEmptyEditor());
  }, [open, task]);

  useEffect(() => {
    if (!open) {
      setIsSaving(false);
    }
  }, [open]);

  const selectedAgent = agents.find((agent) => agent.id === editor.agentId) || null;
  const schedulePlan = getSchedulePlan(editor);

  const agentOptions = useMemo(
    () => agents.map((agent) => ({
      value: agent.id,
      label: `${agent.avatar || ""} ${agent.name}`.trim() || agent.id,
    })),
    [agents],
  );

  const repeatUnitOptions = useMemo(
    () => REPEAT_UNIT_OPTIONS.map((unit) => ({
      value: unit,
      label: t(`editor.units.${unit}`),
    })),
    [t],
  );

  const schedulePlanOptions = useMemo(
    () => SCHEDULE_PLAN_OPTIONS.map((option) => ({
      value: option,
      label: option === "at" || option === "every"
        ? t(`editor.planOptions.${option}`)
        : t(`editor.calendarPresets.${option}.title`),
    })),
    [t],
  );

  const handlePickWorkingDir = async () => {
    const dir = await pickWorkingDirectory();
    if (!dir) return;
    setEditor((state) => ({ ...state, workingDir: dir }));
  };

  const handleSubmit = async () => {
    setIsSaving(true);
    try {
      const request = toRequest(editor, t);
      if (task) {
        await onSave({ ...request, id: task.id });
      } else {
        await onSave(request);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()}>
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(780px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(555px,calc(100%-2rem))] rounded-xl bg-background">
        <ModalTitle className="sr-only">
          {task ? t("editor.editTitle") : t("editor.createTitle")}
        </ModalTitle>

        <header className="flex h-11 shrink-0 items-center border-b border-border bg-background px-3 pr-14">
          <span className="min-w-0 truncate text-sm text-foreground">
            {task ? t("editor.editTitle") : t("editor.createTitle")}
          </span>
        </header>

        <ModalBody className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-background px-5 py-5">
          <section className="space-y-3">
            <FieldBlock label={t("editor.name")}>
              <input
                className={FIELD_INPUT_CLASS}
                value={editor.name}
                onChange={(event) => setEditor((state) => ({ ...state, name: event.target.value }))}
                placeholder={t("editor.namePlaceholder")}
              />
            </FieldBlock>
          </section>

          <section className="space-y-3">
            <FieldBlock label={t("editor.agentId")}>
              <SettingDropdown
                value={editor.agentId}
                onChange={(value) => setEditor((state) => ({ ...state, agentId: value }))}
                options={agentOptions}
                placeholder={selectedAgent ? `${selectedAgent.avatar || ""} ${selectedAgent.name}`.trim() : editor.agentId || "default"}
                className={DROPDOWN_TRIGGER_CLASS}
              />
            </FieldBlock>
          </section>

          <section className="space-y-3">
            <div className="space-y-3">
              <FieldBlock label={t("editor.schedulePlan")}>
                {schedulePlan === "monthly" ? (
                  <div className="grid gap-3 md:grid-cols-[170px_150px_1fr]">
                    <SettingDropdown
                      value={schedulePlan}
                      onChange={(value) => setEditor((state) => setSchedulePlan(state, value as SchedulePlanValue))}
                      options={schedulePlanOptions}
                      className={DROPDOWN_TRIGGER_CLASS}
                    />
                    <MonthlyDayPicker
                      value={editor.calendarDayOfMonth}
                      onChange={(value) => setEditor((state) => ({ ...state, calendarDayOfMonth: value }))}
                      label={t("editor.monthlyDayValue", { day: Number(editor.calendarDayOfMonth) || 1 })}
                    />
                    <TimeInput
                      value={editor.calendarTime}
                      onChange={(value) => setEditor((state) => ({ ...state, calendarTime: value }))}
                    />
                  </div>
                ) : schedulePlan === "every" ? (
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
                    <input
                      type="number"
                      min="1"
                      className={FIELD_INPUT_CLASS}
                      value={editor.repeatValue}
                      onChange={(event) => setEditor((state) => ({ ...state, repeatValue: event.target.value }))}
                    />
                    <SettingDropdown
                      value={editor.repeatUnit}
                      onChange={(value) => setEditor((state) => ({ ...state, repeatUnit: value as EveryUnit }))}
                      options={repeatUnitOptions}
                      className={DROPDOWN_TRIGGER_CLASS}
                    />
                  </div>
                ) : schedulePlan === "advanced" ? (
                  <div className="grid gap-3 md:grid-cols-[170px_minmax(0,1fr)]">
                    <SettingDropdown
                      value={schedulePlan}
                      onChange={(value) => setEditor((state) => setSchedulePlan(state, value as SchedulePlanValue))}
                      options={schedulePlanOptions}
                      className={DROPDOWN_TRIGGER_CLASS}
                    />
                    <input
                      className={FIELD_INPUT_CLASS}
                      value={editor.cronExpr}
                      onChange={(event) => setEditor((state) => ({ ...state, cronExpr: event.target.value }))}
                      placeholder="0 9 * * 1-5"
                    />
                  </div>
                ) : schedulePlan === "hourly" ? (
                  <div className="grid gap-3 md:grid-cols-[170px_150px]">
                    <SettingDropdown
                      value={schedulePlan}
                      onChange={(value) => setEditor((state) => setSchedulePlan(state, value as SchedulePlanValue))}
                      options={schedulePlanOptions}
                      className={DROPDOWN_TRIGGER_CLASS}
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      className={FIELD_INPUT_CLASS}
                      value={editor.calendarMinute}
                      onChange={(event) => setEditor((state) => ({ ...state, calendarMinute: event.target.value }))}
                      placeholder={t("editor.calendarMinute")}
                    />
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-[170px_1fr]">
                    <SettingDropdown
                      value={schedulePlan}
                      onChange={(value) => setEditor((state) => setSchedulePlan(state, value as SchedulePlanValue))}
                      options={schedulePlanOptions}
                      className={DROPDOWN_TRIGGER_CLASS}
                    />
                    <TimeInput
                      type={schedulePlan === "at" ? "datetime-local" : "time"}
                      value={schedulePlan === "at" ? editor.runAt : editor.calendarTime}
                      onChange={(value) => setEditor((state) => ({
                        ...state,
                        ...(schedulePlan === "at" ? { runAt: value } : { calendarTime: value }),
                      }))}
                    />
                  </div>
                )}
              </FieldBlock>

              {schedulePlan === "every" ? (
                <div className="space-y-3">
                  <FieldBlock label={t("editor.repeatPresetsTitle")}>
                    <div className="flex flex-wrap gap-2">
                      {REPEAT_PRESETS.map((preset) => {
                        const active = editor.repeatValue === preset.value && editor.repeatUnit === preset.unit;
                        return (
                          <Button
                            key={`${preset.value}-${preset.unit}`}
                            type="button"
                            variant={active ? "default" : "outline"}
                            size="sm"
                            className={cn(active ? "shadow-none" : "bg-background/55")}
                            onClick={() => setEditor((state) => ({ ...state, repeatValue: preset.value, repeatUnit: preset.unit }))}
                          >
                            {t(preset.labelKey)}
                          </Button>
                        );
                      })}
                    </div>
                  </FieldBlock>
                </div>
              ) : null}

              {schedulePlan === "weekly" ? (
                <FieldBlock label={t("editor.calendarWeekdays")}>
                  <div className="flex flex-wrap gap-2.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const selected = editor.calendarWeekdays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => setEditor((state) => ({
                            ...state,
                            calendarWeekdays: selected
                              ? state.calendarWeekdays.filter((item) => item !== day)
                              : [...state.calendarWeekdays, day],
                          }))}
                          className={cn(
                            "flex size-11 items-center justify-center rounded-full border text-base font-medium transition-colors",
                            selected
                              ? "border-foreground bg-foreground text-background"
                              : "border-input bg-background text-foreground hover:border-foreground/40",
                          )}
                        >
                          {t(`editor.weekdaysShort.${WEEKDAY_KEYS[day]}`)}
                        </button>
                      );
                    })}
                  </div>
                </FieldBlock>
              ) : null}

            </div>
          </section>

          <section className="space-y-3">
            <div className="space-y-3">
              <FieldBlock label={t("editor.workingDir")}>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void handlePickWorkingDir()} className={selectorButtonClass("flex-1")}>
                    <div className="flex min-w-0 items-center gap-3">
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 text-left">
                        <div className={cn("truncate font-medium", !editor.workingDir && "text-muted-foreground")} title={editor.workingDir || undefined}>
                          {editor.workingDir || t("editor.workingDirPlaceholder")}
                        </div>
                      </div>
                    </div>
                    <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                  {editor.workingDir ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            onClick={() => void openPath(editor.workingDir)}
                          >
                            <ExternalLink className="size-4" />
                            <span className="sr-only">{t("editor.openWorkingDir")}</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("editor.openWorkingDir")}</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            onClick={() => setEditor((state) => ({ ...state, workingDir: "" }))}
                          >
                            <X className="size-4" />
                            <span className="sr-only">{t("editor.clearWorkingDir")}</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("editor.clearWorkingDir")}</TooltipContent>
                      </Tooltip>
                    </>
                  ) : null}
                </div>
              </FieldBlock>
            </div>
          </section>

          <section className="min-h-0 flex-1 space-y-3">
            <FieldBlock label={t("editor.message")}>
              <Textarea
                rows={10}
                className="app-scrollbar h-full min-h-[240px] flex-1 overflow-y-auto rounded-lg border-input bg-background px-3 py-2 text-sm leading-6"
                value={editor.message}
                onChange={(event) => setEditor((state) => ({ ...state, message: event.target.value }))}
                placeholder={t("editor.messagePlaceholder")}
              />
            </FieldBlock>
          </section>
        </ModalBody>

        <ModalFooter className="justify-between gap-4 bg-background px-6 py-4 max-sm:flex-col max-sm:items-stretch">
          <div className="flex min-w-0 items-center gap-3">
              <Switch checked={editor.enabled} onCheckedChange={(enabled) => setEditor((state) => ({ ...state, enabled }))} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("editor.enabled")}</div>
              </div>
          </div>

          <div className="flex items-center gap-3 self-end max-sm:w-full max-sm:justify-end">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>{t("editor.cancel")}</Button>
            <Button onClick={() => void handleSubmit()} disabled={isSaving}>{t("editor.save")}</Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <div>
        <div className="text-sm font-medium leading-5">{label}</div>
        {hint ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </label>
  );
}

function TimeInput({
  type = "time",
  value,
  onChange,
}: {
  type?: "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <input
        type={type}
        className={cn(FIELD_INPUT_CLASS, "pr-10")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Clock3 className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function MonthlyDayPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const currentValue = Number(value) || 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={selectorButtonClass()}>
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={8} className="w-[min(480px,calc(100vw-4rem))] rounded-xl border-border bg-popover p-3 shadow-lg">
        <div className="grid grid-cols-7 gap-2">
          {MONTH_DAYS.map((day) => {
            const selected = day === currentValue;
            return (
              <button
                key={day}
                type="button"
                onClick={() => {
                  onChange(String(day));
                  setOpen(false);
                }}
                className={cn(
                  "flex h-10 items-center justify-center rounded-lg text-sm font-medium transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-foreground hover:bg-muted",
                )}
              >
                {day}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function selectorButtonClass(extraClassName?: string) {
  return cn(
    "flex h-10 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 text-sm transition-colors hover:bg-muted/35 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
    extraClassName,
  );
}
