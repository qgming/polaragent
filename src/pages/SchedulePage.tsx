import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  ExternalLink,
  FileClock,
  Filter,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ChevronsUpDown,
} from "lucide-react";

import { PageHero } from "@/components/PageHero";
import { ScheduleEditorModal } from "@/components/schedule/ScheduleEditorModal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from "@/components/ui/modal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/useToast";
import { openPath } from "@/lib/electron/electron-api";
import { splitEveryMs, parseCronPreset } from "@/lib/schedule/presets";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/config-store";
import { useScheduleStore } from "@/stores/schedule-store";
import type {
  CreateScheduledTaskRequest,
  ScheduleLogEntry,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@/types/schedule";

type TaskFilterStatus = "all" | "enabled" | "disabled" | "running";
type LogFilterStatus = "all" | ScheduleLogEntry["status"];

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20";

const WEEKDAY_KEYS: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

function formatTime(value?: number, locale = "zh-CN"): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale);
}

function formatDateTimeForFilter(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function describeSchedule(
  task: ScheduledTask,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale: string,
): string {
  if (task.schedule.kind === "at") {
    return new Date(task.schedule.at).toLocaleString(locale);
  }

  if (task.schedule.kind === "every") {
    const every = splitEveryMs(task.schedule.everyMs);
    return t("summary.every", {
      value: every.value,
      unit: t(`editor.units.${every.unit}`),
    });
  }

  const parsed = parseCronPreset(task.schedule.expr);
  if (parsed.preset === "hourly") {
    return t("summary.hourly", { minute: String(parsed.minute).padStart(2, "0") });
  }
  if (parsed.preset === "daily") {
    return t("summary.daily", { time: parsed.time });
  }
  if (parsed.preset === "weekly") {
    return t("summary.weekly", {
      days: parsed.weekdays.map((day) => t(`editor.weekdaysShort.${WEEKDAY_KEYS[day]}`)).join(" / "),
      time: parsed.time,
    });
  }
  if (parsed.preset === "monthly") {
    return t("summary.monthly", { day: parsed.dayOfMonth, time: parsed.time });
  }
  return task.schedule.expr;
}

function getLogStatusLabel(
  status: ScheduleLogEntry["status"],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(`logs.statusLabels.${status}`);
}

function getTriggeredByLabel(
  triggeredBy: ScheduleLogEntry["triggeredBy"],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(`logs.triggeredByLabels.${triggeredBy}`);
}

export function SchedulePage() {
  const { t, i18n } = useTranslation("schedule");
  const tasks = useScheduleStore((state) => state.tasks);
  const runtimeStates = useScheduleStore((state) => state.runtimeStates);
  const isLoading = useScheduleStore((state) => state.isLoading);
  const initialize = useScheduleStore((state) => state.initialize);
  const loadTasks = useScheduleStore((state) => state.loadTasks);
  const createTask = useScheduleStore((state) => state.createTask);
  const updateTask = useScheduleStore((state) => state.updateTask);
  const deleteTask = useScheduleStore((state) => state.deleteTask);
  const runTaskNow = useScheduleStore((state) => state.runTaskNow);
  const loadLogs = useScheduleStore((state) => state.loadLogs);
  const logsByTask = useScheduleStore((state) => state.logsByTask);
  const agents = useConfigStore((state) => state.agents);
  const toast = useToast();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null);
  const [logTask, setLogTask] = useState<ScheduledTask | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilterStatus>("all");

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const stats = useMemo(() => {
    const running = Object.values(runtimeStates).filter((state) => state.state === "running").length;
    return {
      total: tasks.length,
      enabled: tasks.filter((task) => task.enabled).length,
      running,
      runs: Object.values(logsByTask).reduce((sum, logs) => sum + logs.length, 0),
    };
  }, [logsByTask, runtimeStates, tasks]);

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      const runtime = runtimeStates[task.id];
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "enabled" && task.enabled) ||
        (statusFilter === "disabled" && !task.enabled) ||
        (statusFilter === "running" && runtime?.state === "running");

      if (!matchesStatus) return false;
      if (!query) return true;

      const haystack = [
        task.name,
        task.description,
        task.payload.message,
        task.payload.agentId,
        task.payload.workingDir,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [runtimeStates, searchQuery, statusFilter, tasks]);

  const openCreate = () => {
    setEditingTask(null);
    setEditorOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setEditorOpen(true);
  };

  const handleSave = async (request: CreateScheduledTaskRequest | UpdateScheduledTaskRequest) => {
    try {
      if ("id" in request) {
        await updateTask(request);
        toast.success(t("actions.updated"));
      } else {
        await createTask(request);
        toast.success(t("actions.created"));
      }
      setEditorOpen(false);
      setEditingTask(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const handleDelete = async () => {
    if (!deletingTask) return;
    await deleteTask(deletingTask.id);
    toast.success(t("actions.deleted"));
    setDeletingTask(null);
  };

  const openLogs = async (task: ScheduledTask) => {
    await loadLogs(task.id);
    setLogTask(task);
  };

  const handleOpenWorkingDir = async (workingDir?: string) => {
    if (!workingDir) return;
    try {
      await openPath(workingDir);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1120px] px-6 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
          <div className="mr-auto flex min-w-[280px] flex-1 flex-wrap gap-2">
            <label className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={cn(INPUT_CLASS, "pl-9")}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("toolbar.searchPlaceholder")}
              />
            </label>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="min-w-[180px] justify-between">
                  <span className="flex items-center gap-2">
                    <Filter className="size-4 text-muted-foreground" />
                    {t(`toolbar.statusLabels.${statusFilter}`)}
                  </span>
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[220px]">
                <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as TaskFilterStatus)}>
                  {(["all", "enabled", "disabled", "running"] as const).map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {t(`toolbar.statusLabels.${value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <IconActionButton label={t("toolbar.refresh")} onClick={() => void loadTasks()} disabled={isLoading} variant="ghost" size="icon">
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </IconActionButton>
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            {t("toolbar.create")}
          </Button>
        </div>

        <PageHero
          title={t("page.title")}
          bannerTitle={t("page.bannerTitle")}
          bannerDescription={t("page.bannerDescription")}
          icon={AlarmClock}
          kitLabel={t("page.kitLabel")}
          rotate="left"
        />

        <section className="mt-5 grid gap-3 md:grid-cols-4">
          <StatCard label={t("stats.total")} value={String(stats.total)} />
          <StatCard label={t("stats.enabled")} value={String(stats.enabled)} />
          <StatCard label={t("stats.running")} value={String(stats.running)} />
          <StatCard label={t("stats.runs")} value={String(stats.runs)} />
        </section>

        {filteredTasks.length === 0 ? (
          <div className="mt-5 flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center">
            <FileClock className="size-10 text-muted-foreground" />
            <h2 className="mt-4 text-base font-semibold">{tasks.length === 0 ? t("page.emptyTitle") : t("page.emptyFilteredTitle")}</h2>
            <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
              {tasks.length === 0 ? t("page.emptyDescription") : t("page.emptyFilteredDescription")}
            </p>
          </div>
        ) : (
          <section className="mt-5 overflow-hidden rounded-xl border border-border bg-card">
            {filteredTasks.map((task) => {
              const runtime = runtimeStates[task.id];
              const isRunning = runtime?.state === "running";
              return (
                <div
                  key={task.id}
                  className="grid min-h-[120px] grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border px-5 py-4 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold">{task.name}</h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {describeSchedule(task, t, i18n.language)}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs",
                          isRunning
                            ? "bg-accent text-accent-foreground"
                            : task.enabled
                              ? "bg-emerald-500/10 text-emerald-700"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {isRunning ? t("task.running") : task.enabled ? t("task.enabled") : t("task.disabled")}
                      </span>
                    </div>
                    {task.description ? <p className="mt-2 text-sm text-muted-foreground">{task.description}</p> : null}
                    <div className="mt-3 grid gap-1 text-sm text-muted-foreground md:grid-cols-2">
                      <div>{t("task.nextRun")}: {runtime?.nextRunAt ? formatTime(runtime.nextRunAt, i18n.language) : "-"}</div>
                      <div>{t("task.lastRun")}: {task.lastRunAt ? formatTime(task.lastRunAt, i18n.language) : t("task.never")}</div>
                      <div>{t("task.agent")}: {task.payload.agentId || "default"}</div>
                      <div>{t("task.workingDir")}: {task.payload.workingDir || "-"}</div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm">{task.payload.message}</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <IconActionButton
                      label={t("task.manualRun")}
                      onClick={() => void runTaskNow(task.id).then(() => toast.success(t("actions.runQueued"))).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}
                    >
                      <Play className="size-4" />
                    </IconActionButton>
                    <IconActionButton
                      label={t("task.openWorkingDir")}
                      onClick={() => void handleOpenWorkingDir(task.payload.workingDir)}
                      disabled={!task.payload.workingDir}
                    >
                      <ExternalLink className="size-4" />
                    </IconActionButton>
                    <IconActionButton label={t("task.logs")} onClick={() => void openLogs(task)}>
                      <FileClock className="size-4" />
                    </IconActionButton>
                    <IconActionButton label={t("task.edit")} onClick={() => openEdit(task)}>
                      <Pencil className="size-4" />
                    </IconActionButton>
                    <IconActionButton label={t("task.delete")} onClick={() => setDeletingTask(task)}>
                      <Trash2 className="size-4" />
                    </IconActionButton>
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </div>

      <ScheduleEditorModal
        open={editorOpen}
        task={editingTask}
        agents={agents}
        onClose={() => {
          setEditorOpen(false);
          setEditingTask(null);
        }}
        onSave={handleSave}
      />

      <ScheduleLogsModal
        task={logTask}
        logs={logTask ? (logsByTask[logTask.id] || []) : []}
        onClose={() => setLogTask(null)}
      />

      <ConfirmDialog
        open={deletingTask !== null}
        onOpenChange={(open) => !open && setDeletingTask(null)}
        title={t("task.delete")}
        message={deletingTask?.name || ""}
        confirmLabel={t("task.delete")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ScheduleLogsModal({
  task,
  logs,
  onClose,
}: {
  task: ScheduledTask | null;
  logs: ScheduleLogEntry[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("schedule");
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<LogFilterStatus>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");

  const handleOpenWorkingDir = async (workingDir?: string) => {
    if (!workingDir) return;
    try {
      await openPath(workingDir);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!task) {
      setStatusFilter("all");
      setSearchQuery("");
      setFromValue("");
      setToValue("");
    }
  }, [task]);

  const filteredLogs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const fromTs = formatDateTimeForFilter(fromValue);
    const toTs = formatDateTimeForFilter(toValue);

    return logs.filter((log) => {
      if (statusFilter !== "all" && log.status !== statusFilter) {
        return false;
      }

      if (fromTs !== null && log.runAt < fromTs) {
        return false;
      }

      if (toTs !== null && log.runAt > toTs) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        log.status,
        log.triggeredBy,
        log.output,
        log.error,
        log.threadId,
        log.workingDir,
        log.runDir,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [fromValue, logs, searchQuery, statusFilter, toValue]);

  const logStats = useMemo(() => {
    const total = filteredLogs.length;
    const success = filteredLogs.filter((log) => log.status === "success").length;
    const failed = filteredLogs.filter((log) => log.status === "failed").length;
    const averageDuration = total > 0
      ? Math.round(filteredLogs.reduce((sum, log) => sum + log.duration, 0) / total)
      : 0;

    return { total, success, failed, averageDuration };
  }, [filteredLogs]);

  return (
    <Modal open={task !== null} onOpenChange={(next) => !next && onClose()}>
      <ModalContent size="xl" showCloseButton={true}>
        <ModalHeader>
          <ModalTitle>{t("logs.title")}{task ? ` · ${task.name}` : ""}</ModalTitle>
          <ModalDescription>{t("logs.description")}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          {logs.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t("logs.empty")}</div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <StatCard label={t("logs.totalRuns")} value={String(logStats.total)} />
                <StatCard label={t("logs.successRuns")} value={String(logStats.success)} />
                <StatCard label={t("logs.failedRuns")} value={String(logStats.failed)} />
                <StatCard label={t("logs.averageDuration")} value={`${logStats.averageDuration}ms`} />
              </div>

              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_1fr_1fr]">
                <label className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={cn(INPUT_CLASS, "pl-9")}
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("logs.searchPlaceholder")}
                  />
                </label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="justify-between">
                      {statusFilter === "all" ? t("logs.filterAll") : statusFilter}
                      <ChevronsUpDown className="size-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[180px]">
                    <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as LogFilterStatus)}>
                      <DropdownMenuRadioItem value="all">{t("logs.filterAll")}</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="success">{t("logs.statusLabels.success")}</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="failed">{t("logs.statusLabels.failed")}</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="skipped">{t("logs.statusLabels.skipped")}</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  className={INPUT_CLASS}
                  type="datetime-local"
                  value={fromValue}
                  onChange={(event) => setFromValue(event.target.value)}
                  placeholder={t("logs.from")}
                />
                <input
                  className={INPUT_CLASS}
                  type="datetime-local"
                  value={toValue}
                  onChange={(event) => setToValue(event.target.value)}
                  placeholder={t("logs.to")}
                />
              </div>

              <div className="text-sm text-muted-foreground">
                {t("logs.showing", { filtered: filteredLogs.length, total: logs.length })}
              </div>

              {filteredLogs.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">{t("logs.emptyFiltered")}</div>
              ) : filteredLogs.map((log) => (
                <div key={log.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-medium">{formatTime(log.runAt, i18n.language)}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t("logs.status")}: {getLogStatusLabel(log.status, t)}</span>
                    <span className="text-muted-foreground">{t("logs.duration")}: {log.duration}ms</span>
                    <span className="text-muted-foreground">{t("logs.triggeredBy")}: {getTriggeredByLabel(log.triggeredBy, t)}</span>
                    {log.workingDir ? (
                      <IconActionButton
                        label={t("common:openInExplorer")}
                        onClick={() => void handleOpenWorkingDir(log.workingDir)}
                      >
                        <FileClock className="size-4" />
                      </IconActionButton>
                    ) : null}
                  </div>
                  {log.output ? (
                    <pre className="app-scrollbar mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{log.output}</pre>
                  ) : null}
                  {log.error ? (
                    <pre className="app-scrollbar mt-3 overflow-x-auto rounded-md bg-destructive/5 p-3 text-xs text-destructive whitespace-pre-wrap">{log.error}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function IconActionButton({
  children,
  label,
  onClick,
  disabled = false,
  size = "icon-sm",
  variant = "outline",
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: "icon" | "icon-sm";
  variant?: "outline" | "ghost";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size={size} onClick={onClick} disabled={disabled}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
