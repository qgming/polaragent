import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CalendarClock,
  ChevronsUpDown,
  ExternalLink,
  FolderOpen,
  Sparkles,
  X,
  type LucideIcon,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import type { ToolPermissionMode } from "@/types/permissions";
import type {
  CreateScheduledTaskRequest,
  MissedRunPolicy,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@/types/schedule";

type ScheduleMode = "at" | "every" | "cron";

interface EditorState {
  name: string;
  enabled: boolean;
  mode: ScheduleMode;
  runAt: string;
  repeatValue: string;
  repeatUnit: EveryUnit;
  repeatStartAt: string;
  calendarPreset: CalendarPreset;
  calendarMinute: string;
  calendarTime: string;
  calendarWeekdays: number[];
  calendarDayOfMonth: string;
  cronExpr: string;
  message: string;
  workingDir: string;
  agentId: string;
  permissionMode: ToolPermissionMode;
  missedRunPolicy: MissedRunPolicy;
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

const PERMISSION_OPTIONS: ToolPermissionMode[] = ["safe", "ai_review", "readonly", "full"];
const MISSED_RUN_OPTIONS: MissedRunPolicy[] = ["run_latest", "run_all", "skip", "prompt"];
const REPEAT_PRESETS: Array<{ value: string; unit: EveryUnit; labelKey: string }> = [
  { value: "15", unit: "minutes", labelKey: "editor.repeatPresets.15m" },
  { value: "30", unit: "minutes", labelKey: "editor.repeatPresets.30m" },
  { value: "1", unit: "hours", labelKey: "editor.repeatPresets.1h" },
  { value: "6", unit: "hours", labelKey: "editor.repeatPresets.6h" },
  { value: "1", unit: "days", labelKey: "editor.repeatPresets.1d" },
];

const MODE_OPTIONS: Array<{ value: ScheduleMode; labelKey: string }> = [
  { value: "at", labelKey: "editor.at" },
  { value: "every", labelKey: "editor.every" },
  { value: "cron", labelKey: "editor.cron" },
];

const CALENDAR_OPTIONS: CalendarPreset[] = ["hourly", "daily", "weekly", "monthly", "advanced"];
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
    repeatStartAt: "",
    calendarPreset: "daily",
    calendarMinute: "0",
    calendarTime: "09:00",
    calendarWeekdays: [1, 2, 3, 4, 5],
    calendarDayOfMonth: "1",
    cronExpr: "0 9 * * *",
    message: "",
    workingDir: "",
    agentId: "default",
    permissionMode: "ai_review",
    missedRunPolicy: "run_latest",
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
      permissionMode: task.payload.permissionMode || "ai_review",
      missedRunPolicy: task.missedRunPolicy,
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
      repeatStartAt: formatDateTimeInput(task.schedule.startAt),
      message: task.payload.message,
      workingDir: task.payload.workingDir || "",
      agentId: task.payload.agentId || "default",
      permissionMode: task.payload.permissionMode || "ai_review",
      missedRunPolicy: task.missedRunPolicy,
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
    permissionMode: task.payload.permissionMode || "ai_review",
    missedRunPolicy: task.missedRunPolicy,
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

function getCalendarPreview(editor: EditorState, t: (key: string, options?: Record<string, unknown>) => string): string {
  try {
    return buildCalendarExpr(editor, t);
  } catch (error) {
    return error instanceof Error ? error.message : t("validation.cronRequired");
  }
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
          ...(editor.repeatStartAt ? { startAt: new Date(editor.repeatStartAt).toISOString() } : {}),
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
      permissionMode: editor.permissionMode,
    },
    missedRunPolicy: editor.missedRunPolicy,
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

  const selectedUnitDescription = useMemo(
    () => t(`editor.unitDescriptions.${editor.repeatUnit}`),
    [editor.repeatUnit, t],
  );

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

  const calendarPresetOptions = useMemo(
    () => CALENDAR_OPTIONS.map((preset) => ({
      value: preset,
      label: t(`editor.calendarPresets.${preset}.title`),
    })),
    [t],
  );

  const permissionModeOptions = useMemo(
    () => PERMISSION_OPTIONS.map((mode) => ({
      value: mode,
      label: t(`editor.permissionOptions.${mode}.title`),
    })),
    [t],
  );

  const missedRunPolicyOptions = useMemo(
    () => MISSED_RUN_OPTIONS.map((policy) => ({
      value: policy,
      label: t(`editor.missedRunOptions.${policy}.title`),
    })),
    [t],
  );

  const repeatSummary = useMemo(
    () => t("summary.every", {
      value: editor.repeatValue || "0",
      unit: t(`editor.units.${editor.repeatUnit}`),
    }),
    [editor.repeatUnit, editor.repeatValue, t],
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
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(780px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1080px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">
          {task ? t("editor.editTitle") : t("editor.createTitle")}
        </ModalTitle>

        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">
            {task ? t("editor.editTitle") : t("editor.createTitle")}
          </span>
        </header>

        <ModalBody className="space-y-7 bg-background px-6 py-5">
          <section className="grid gap-5 border-b border-border pb-5 md:grid-cols-[minmax(0,1fr)_300px]">
            <FieldBlock label={t("editor.name")} hint={t("editor.nameHint")}>
              <input
                className={FIELD_INPUT_CLASS}
                value={editor.name}
                onChange={(event) => setEditor((state) => ({ ...state, name: event.target.value }))}
                placeholder={t("editor.namePlaceholder")}
              />
            </FieldBlock>

            <FieldBlock label={t("editor.agentId")} hint={t("editor.agentHint")}>
              <SettingDropdown
                value={editor.agentId}
                onChange={(value) => setEditor((state) => ({ ...state, agentId: value }))}
                options={agentOptions}
                placeholder={selectedAgent ? `${selectedAgent.avatar || ""} ${selectedAgent.name}`.trim() : editor.agentId || "default"}
                className="h-10 w-full justify-between"
              />
            </FieldBlock>
          </section>

          <EditorSection
            className="border-b border-border pb-6"
            icon={CalendarClock}
            title={t("editor.sections.scheduleTitle")}
            description={t("editor.sections.scheduleDescription")}
          >
            <Tabs value={editor.mode} onValueChange={(value) => setEditor((state) => ({ ...state, mode: value as ScheduleMode }))}>
              <TabsList className="grid h-10 w-full grid-cols-3 rounded-xl bg-muted p-1">
                {MODE_OPTIONS.map((item) => (
                  <TabsTrigger key={item.value} value={item.value} className="h-8 rounded-lg text-sm data-[state=active]:bg-background data-[state=active]:ring-1 data-[state=active]:ring-border data-[state=active]:shadow-sm">
                    {t(item.labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="mt-5 space-y-4">
              {editor.mode === "at" ? (
                <div className="max-w-[360px]">
                  <FieldBlock label={t("editor.atTime")} hint={t("editor.atTimeHint")}>
                    <input
                      type="datetime-local"
                      className={FIELD_INPUT_CLASS}
                      value={editor.runAt}
                      onChange={(event) => setEditor((state) => ({ ...state, runAt: event.target.value }))}
                    />
                  </FieldBlock>
                </div>
              ) : null}

              {editor.mode === "every" ? (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <FieldBlock label={t("editor.repeatValue")} hint={t("editor.repeatValueHint")}>
                      <input
                        type="number"
                        min="1"
                        className={FIELD_INPUT_CLASS}
                        value={editor.repeatValue}
                        onChange={(event) => setEditor((state) => ({ ...state, repeatValue: event.target.value }))}
                      />
                    </FieldBlock>

                    <FieldBlock label={t("editor.repeatUnit")} hint={t("editor.repeatUnitHint")}>
                      <SettingDropdown
                        value={editor.repeatUnit}
                        onChange={(value) => setEditor((state) => ({ ...state, repeatUnit: value as EveryUnit }))}
                        options={repeatUnitOptions}
                        className="h-10 w-full justify-between"
                      />
                      <div className="mt-1.5 text-xs leading-5 text-muted-foreground">{selectedUnitDescription}</div>
                    </FieldBlock>
                  </div>

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

                  <div className="grid gap-4 md:grid-cols-2">
                    <FieldBlock label={t("editor.startAt")} hint={t("editor.startAtHint")}>
                      <input
                        type="datetime-local"
                        className={FIELD_INPUT_CLASS}
                        value={editor.repeatStartAt}
                        onChange={(event) => setEditor((state) => ({ ...state, repeatStartAt: event.target.value }))}
                      />
                    </FieldBlock>
                  </div>

                  <InlineSummary label={t("editor.schedulePreview")} value={repeatSummary} />
                </div>
              ) : null}

              {editor.mode === "cron" ? (
                <div className="space-y-4">
                  <FieldBlock label={t("editor.mode")} hint={t(`editor.calendarPresets.${editor.calendarPreset}.description`)}>
                    <SettingDropdown
                      value={editor.calendarPreset}
                      onChange={(value) => setEditor((state) => ({ ...state, calendarPreset: value as CalendarPreset }))}
                      options={calendarPresetOptions}
                      className="h-10 w-full justify-between md:max-w-[220px]"
                    />
                  </FieldBlock>

                  {editor.calendarPreset === "hourly" ? (
                    <div className="max-w-[220px]">
                      <FieldBlock label={t("editor.calendarMinute")} hint={t("editor.calendarMinuteHint")}> 
                        <input
                          type="number"
                          min="0"
                          max="59"
                          className={FIELD_INPUT_CLASS}
                          value={editor.calendarMinute}
                          onChange={(event) => setEditor((state) => ({ ...state, calendarMinute: event.target.value }))}
                        />
                      </FieldBlock>
                    </div>
                  ) : null}

                  {editor.calendarPreset === "daily" ? (
                    <div className="max-w-[220px]">
                      <FieldBlock label={t("editor.calendarTime")} hint={t("editor.calendarTimeHint")}> 
                        <input
                          type="time"
                          className={FIELD_INPUT_CLASS}
                          value={editor.calendarTime}
                          onChange={(event) => setEditor((state) => ({ ...state, calendarTime: event.target.value }))}
                        />
                      </FieldBlock>
                    </div>
                  ) : null}

                  {editor.calendarPreset === "weekly" ? (
                    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                      <FieldBlock label={t("editor.calendarTime")} hint={t("editor.calendarTimeHint")}> 
                        <input
                          type="time"
                          className={FIELD_INPUT_CLASS}
                          value={editor.calendarTime}
                          onChange={(event) => setEditor((state) => ({ ...state, calendarTime: event.target.value }))}
                        />
                      </FieldBlock>
                      <FieldBlock label={t("editor.calendarWeekdays")} hint={t("editor.calendarWeekdaysHint")}> 
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
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
                                  "flex h-10 items-center justify-center rounded-lg border text-sm font-medium transition-colors",
                                  selected
                                    ? "border-ring bg-background text-foreground"
                                    : "border-input bg-background text-muted-foreground hover:text-foreground",
                                )}
                              >
                                {t(`editor.weekdaysShort.${WEEKDAY_KEYS[day]}`)}
                              </button>
                            );
                          })}
                        </div>
                      </FieldBlock>
                    </div>
                  ) : null}

                  {editor.calendarPreset === "monthly" ? (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <FieldBlock label={t("editor.calendarTime")} hint={t("editor.calendarTimeHint")}> 
                        <input
                          type="time"
                          className={FIELD_INPUT_CLASS}
                          value={editor.calendarTime}
                          onChange={(event) => setEditor((state) => ({ ...state, calendarTime: event.target.value }))}
                        />
                      </FieldBlock>
                      <FieldBlock label={t("editor.calendarDayOfMonth")} hint={t("editor.calendarDayOfMonthHint")}> 
                        <input
                          type="number"
                          min="1"
                          max="31"
                          className={FIELD_INPUT_CLASS}
                          value={editor.calendarDayOfMonth}
                          onChange={(event) => setEditor((state) => ({ ...state, calendarDayOfMonth: event.target.value }))}
                        />
                      </FieldBlock>
                    </div>
                  ) : null}

                  {editor.calendarPreset === "advanced" ? (
                    <div>
                      <FieldBlock label={t("editor.cronExpr")} hint={t("editor.cronExprHint")}> 
                        <input
                          className={FIELD_INPUT_CLASS}
                          value={editor.cronExpr}
                          onChange={(event) => setEditor((state) => ({ ...state, cronExpr: event.target.value }))}
                          placeholder="0 9 * * 1-5"
                        />
                      </FieldBlock>
                    </div>
                  ) : null}

                  <InlineSummary label={t("editor.schedulePreview")} value={getCalendarPreview(editor, t)} mono={editor.calendarPreset === "advanced"} />
                </div>
              ) : null}
            </div>
          </EditorSection>

          <EditorSection
            className="border-b border-border pb-6"
            icon={FolderOpen}
            title={t("editor.sections.environmentTitle")}
            description={t("editor.sections.environmentDescription")}
          >
            <div className="space-y-4">
              <div className="max-w-[760px]">
                <FieldBlock label={t("editor.workingDir")} hint={t("editor.workingDirHint")}>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void handlePickWorkingDir()} className={selectorButtonClass("flex-1")}>
                      <div className="flex min-w-0 items-center gap-3">
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 text-left">
                          <div className={cn("truncate text-[15px] font-medium", !editor.workingDir && "text-muted-foreground")} title={editor.workingDir || undefined}>
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

              <div className="grid gap-4 md:grid-cols-2">
                <FieldBlock label={t("editor.permissionMode")} hint={t("editor.permissionHint")}>
                  <SettingDropdown
                    value={editor.permissionMode}
                    onChange={(value) => setEditor((state) => ({ ...state, permissionMode: value as ToolPermissionMode }))}
                    options={permissionModeOptions}
                    className="h-10 w-full justify-between"
                  />
                  <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {t(`editor.permissionOptions.${editor.permissionMode}.description`)}
                  </div>
                </FieldBlock>

                <FieldBlock label={t("editor.missedRunPolicy")} hint={t("editor.missedRunPolicyHint")}>
                  <SettingDropdown
                    value={editor.missedRunPolicy}
                    onChange={(value) => setEditor((state) => ({ ...state, missedRunPolicy: value as MissedRunPolicy }))}
                    options={missedRunPolicyOptions}
                    className="h-10 w-full justify-between"
                  />
                  <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {t(`editor.missedRunOptions.${editor.missedRunPolicy}.description`)}
                  </div>
                </FieldBlock>
              </div>
            </div>
          </EditorSection>

          <EditorSection
            icon={Sparkles}
            title={t("editor.sections.messageTitle")}
            description={t("editor.sections.messageDescription")}
          >
            <FieldBlock label={t("editor.message")} hint={t("editor.messageHint")}>
              <Textarea
                className="app-scrollbar min-h-[220px] rounded-lg border-input bg-background px-3 py-2 text-sm leading-6"
                value={editor.message}
                onChange={(event) => setEditor((state) => ({ ...state, message: event.target.value }))}
                placeholder={t("editor.messagePlaceholder")}
              />
            </FieldBlock>
          </EditorSection>
        </ModalBody>

        <ModalFooter className="justify-between gap-4 border-border bg-background px-6 py-4 max-sm:flex-col max-sm:items-stretch">
          <div className="flex min-w-0 items-center gap-3">
              <Switch checked={editor.enabled} onCheckedChange={(enabled) => setEditor((state) => ({ ...state, enabled }))} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("editor.enabled")}</div>
                <div className="text-xs leading-5 text-muted-foreground">{t("editor.enabledHint")}</div>
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

function EditorSection({
  className,
  icon: Icon,
  title,
  description,
  children,
}: {
  className?: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-normal">{title}</h3>
          <p className="mt-1 max-w-[72ch] text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-2.5">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </label>
  );
}

function InlineSummary({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/30 px-3 py-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn("font-medium text-foreground", mono && "font-mono text-[13px]")}>{value}</span>
    </div>
  );
}

function selectorButtonClass(extraClassName?: string) {
  return cn(
    "flex h-10 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 text-sm transition-colors hover:bg-muted/35 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
    extraClassName,
  );
}
