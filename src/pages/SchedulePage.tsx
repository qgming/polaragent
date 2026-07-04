import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  Clock3,
  ExternalLink,
  FileClock,
  MoreHorizontal,
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
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
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
type ScheduleTab = "tasks" | "logs";

interface GlobalScheduleLogItem extends ScheduleLogEntry {
  taskName: string;
  agentName: string;
}

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

function parseDateFilter(value: string, endOfDay = false): number | null {
  if (!value) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  const timestamp = date.getTime();
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

function getAgentDisplayName(
  agentId: string | undefined,
  agents: Array<{ id: string; name: string }>,
): string {
  const normalizedId = (agentId || "default").trim() || "default";
  const agent = agents.find((item) => item.id === normalizedId);
  if (!agent) return normalizedId;
  return agent.name || agent.id;
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
  const toggleTask = useScheduleStore((state) => state.toggleTask);
  const runTaskNow = useScheduleStore((state) => state.runTaskNow);
  const logsByTask = useScheduleStore((state) => state.logsByTask);
  const agents = useConfigStore((state) => state.agents);
  const toast = useToast();
  const agentDisplayNames = useMemo(() => {
    const entries: Array<[string, string]> = agents.map((agent) => [
      agent.id,
      getAgentDisplayName(agent.id, agents),
    ]);
    return new Map<string, string>(entries);
  }, [agents]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null);
  const [selectedLog, setSelectedLog] = useState<GlobalScheduleLogItem | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleTab>("tasks");
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskFilterStatus>("all");
  const [selectedLogTaskId, setSelectedLogTaskId] = useState<string>("all");
  const [logStatusFilter, setLogStatusFilter] = useState<LogFilterStatus>("all");
  const [logFromValue, setLogFromValue] = useState("");
  const [logToValue, setLogToValue] = useState("");

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task] as const)),
    [tasks],
  );

  const filteredTasks = useMemo(() => {
    const query = taskSearchQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      const runtime = runtimeStates[task.id];
      const matchesStatus =
        taskStatusFilter === "all" ||
        (taskStatusFilter === "enabled" && task.enabled) ||
        (taskStatusFilter === "disabled" && !task.enabled) ||
        (taskStatusFilter === "running" && runtime?.state === "running");

      if (!matchesStatus) return false;
      if (!query) return true;

      const haystack = [
        task.name,
        task.description,
        task.payload.message,
        task.payload.agentId,
        agentDisplayNames.get(task.payload.agentId || "default"),
        task.payload.workingDir,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [agentDisplayNames, runtimeStates, taskSearchQuery, taskStatusFilter, tasks]);

  const allLogs = useMemo<GlobalScheduleLogItem[]>(() => (
    Object.entries(logsByTask)
      .flatMap(([taskId, logs]) => {
        const task = taskById.get(taskId);
        const taskName = task?.name || taskId;
        const agentName = agentDisplayNames.get(task?.payload.agentId || "default") || (task?.payload.agentId || "default");
        return logs.map((log) => ({
          ...log,
          taskName,
          agentName,
        }));
      })
      .sort((a, b) => b.runAt - a.runAt)
  ), [agentDisplayNames, logsByTask, taskById]);

  const filteredLogs = useMemo(() => {
    const fromTs = parseDateFilter(logFromValue, false);
    const toTs = parseDateFilter(logToValue, true);

    return allLogs.filter((log) => {
      if (fromTs !== null && log.runAt < fromTs) {
        return false;
      }

      if (toTs !== null && log.runAt > toTs) {
        return false;
      }

      if (selectedLogTaskId !== "all" && log.taskId !== selectedLogTaskId) {
        return false;
      }

      if (logStatusFilter !== "all" && log.status !== logStatusFilter) {
        return false;
      }

      return true;
    });
  }, [allLogs, logFromValue, logStatusFilter, logToValue, selectedLogTaskId]);

  const selectedLogTaskLabel = selectedLogTaskId === "all"
    ? t("logs.taskFilterAll")
    : taskById.get(selectedLogTaskId)?.name || selectedLogTaskId;

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

  const openLogs = (task: ScheduledTask) => {
    setActiveTab("logs");
    setSelectedLogTaskId(task.id);
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
          <IconActionButton label={t("toolbar.refresh")} onClick={() => void loadTasks()} disabled={isLoading} variant="ghost" size="icon">
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </IconActionButton>

          {activeTab === "tasks" ? (
            <>
              <div className="relative w-[300px] max-w-full">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className={cn(INPUT_CLASS, "rounded-full pl-9 pr-3")}
                  type="search"
                  value={taskSearchQuery}
                  onChange={(event) => setTaskSearchQuery(event.target.value)}
                  placeholder={t("toolbar.searchPlaceholder")}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="min-w-[180px] justify-between">
                    {t(`toolbar.statusLabels.${taskStatusFilter}`)}
                    <ChevronsUpDown className="size-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  <DropdownMenuRadioGroup value={taskStatusFilter} onValueChange={(value) => setTaskStatusFilter(value as TaskFilterStatus)}>
                    {(["all", "enabled", "disabled", "running"] as const).map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {t(`toolbar.statusLabels.${value}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={openCreate}>
                <Plus className="size-4" />
                {t("toolbar.create")}
              </Button>
            </>
          ) : (
            <>
              <input
                className="h-9 w-[150px] rounded-xl border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
                type="date"
                value={logFromValue}
                onChange={(event) => setLogFromValue(event.target.value)}
              />
              <input
                className="h-9 w-[150px] rounded-xl border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
                type="date"
                value={logToValue}
                onChange={(event) => setLogToValue(event.target.value)}
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="min-w-[160px] justify-between rounded-xl px-4">
                    {selectedLogTaskLabel}
                    <ChevronsUpDown className="size-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  <DropdownMenuRadioGroup value={selectedLogTaskId} onValueChange={setSelectedLogTaskId}>
                    <DropdownMenuRadioItem value="all">{t("logs.taskFilterAll")}</DropdownMenuRadioItem>
                    {tasks.map((task) => (
                      <DropdownMenuRadioItem key={task.id} value={task.id}>
                        {task.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="min-w-[160px] justify-between rounded-xl px-4">
                    {logStatusFilter === "all" ? t("logs.statusFilterAll") : t(`logs.statusLabels.${logStatusFilter}`)}
                    <ChevronsUpDown className="size-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[220px]">
                  <DropdownMenuRadioGroup value={logStatusFilter} onValueChange={(value) => setLogStatusFilter(value as LogFilterStatus)}>
                    <DropdownMenuRadioItem value="all">{t("logs.statusFilterAll")}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="success">{t("logs.statusLabels.success")}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="failed">{t("logs.statusLabels.failed")}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="running">{t("logs.statusLabels.running")}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="skipped">{t("logs.statusLabels.skipped")}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        <PageHero
          title={t("page.title")}
          bannerTitle={t("page.bannerTitle")}
          bannerDescription={t("page.bannerDescription")}
          icon={AlarmClock}
          kitLabel={t("page.kitLabel")}
          rotate="left"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ScheduleTab)}>
            <TabsList className="h-9 bg-transparent p-0">
              <ScheduleTabTrigger value="tasks">{t("tabs.tasks")}</ScheduleTabTrigger>
              <ScheduleTabTrigger value="logs">{t("tabs.logs")}</ScheduleTabTrigger>
            </TabsList>
          </Tabs>
        </div>

        {activeTab === "tasks" ? (filteredTasks.length === 0 ? (
          <div className="mt-3 flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center">
            <FileClock className="size-10 text-muted-foreground" />
            <h2 className="mt-4 text-base font-semibold">{tasks.length === 0 ? t("page.emptyTitle") : t("page.emptyFilteredTitle")}</h2>
            <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
              {tasks.length === 0 ? t("page.emptyDescription") : t("page.emptyFilteredDescription")}
            </p>
          </div>
        ) : (
          <section className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filteredTasks.map((task) => {
              const agentDisplayName = agentDisplayNames.get(task.payload.agentId || "default") || (task.payload.agentId || "default");
              return (
                <div
                  key={task.id}
                  className="flex min-h-[184px] flex-col rounded-xl border border-border bg-card p-3.5 transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2.5">
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={(checked) => void toggleTask(task.id, checked)}
                      aria-label={task.enabled ? t("task.disable") : t("task.enable")}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={t("task.more")}
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => void runTaskNow(task.id).then(() => toast.success(t("actions.runQueued"))).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}>
                          <Play className="size-4" />
                          {t("task.manualRun")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openLogs(task)}>
                          <FileClock className="size-4" />
                          {t("task.logs")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openEdit(task)}>
                          <Pencil className="size-4" />
                          {t("task.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleOpenWorkingDir(task.payload.workingDir)} disabled={!task.payload.workingDir}>
                          <ExternalLink className="size-4" />
                          {t("task.openWorkingDir")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setDeletingTask(task)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-4" />
                          {t("task.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="mt-3 min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold leading-6 text-foreground">{task.name}</h2>
                    <p className="mt-1.5 line-clamp-3 text-sm leading-5 text-muted-foreground">
                      {task.description || task.payload.message}
                    </p>
                    <div className="mt-3.5 border-t border-border/80 pt-2.5">
                      <div
                        className="inline-flex max-w-full items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground"
                        title={`${describeSchedule(task, t, i18n.language)}${agentDisplayName ? ` · ${String(agentDisplayName)}` : ""}`}
                      >
                        <Clock3 className="size-4 shrink-0" />
                        <span className="truncate">{describeSchedule(task, t, i18n.language)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )) : (allLogs.length === 0 ? (
          <div className="mt-3 flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center">
            <FileClock className="size-10 text-muted-foreground" />
            <h2 className="mt-4 text-base font-semibold">{t("logs.empty")}</h2>
            <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
              {t("logs.description")}
            </p>
          </div>
        ) : (
          <section className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            {filteredLogs.length === 0 ? (
              <div className="flex min-h-[220px] items-center justify-center px-6 text-sm text-muted-foreground">
                {t("logs.emptyFiltered")}
              </div>
            ) : filteredLogs.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => setSelectedLog(log)}
                className="grid w-full gap-3 border-b border-border px-5 py-3 text-left transition-colors hover:bg-muted/35 last:border-b-0 md:grid-cols-[170px_minmax(0,1fr)_96px_92px] md:items-center"
              >
                <div className="text-sm font-medium text-foreground">
                  {formatTime(log.runAt, i18n.language)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{log.taskName}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {log.agentName} · {getTriggeredByLabel(log.triggeredBy, t)}
                  </div>
                </div>
                <div>
                  <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {getLogStatusLabel(log.status, t)}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">{log.duration}ms</div>
              </button>
            ))}
          </section>
        ))}
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

      <ScheduleLogDetailModal
        log={selectedLog}
        onClose={() => setSelectedLog(null)}
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

function ScheduleTabTrigger({
  children,
  value,
}: {
  children: ReactNode;
  value: ScheduleTab;
}) {
  return (
    <TabsTrigger
      value={value}
      className="mr-7 h-9 gap-2 rounded-none bg-transparent px-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function DetailMetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ScheduleLogDetailModal({
  log,
  onClose,
}: {
  log: GlobalScheduleLogItem | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("schedule");
  const toast = useToast();

  const handleOpenWorkingDir = async (workingDir?: string) => {
    if (!workingDir) return;
    try {
      await openPath(workingDir);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Modal open={log !== null} onOpenChange={(next) => !next && onClose()}>
      <ModalContent size="xl" showCloseButton={true}>
        <ModalHeader>
          <ModalTitle>{t("logs.detailTitle")}{log ? ` · ${log.taskName}` : ""}</ModalTitle>
          <ModalDescription>{log ? formatTime(log.runAt, i18n.language) : t("logs.description")}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          {!log ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t("logs.empty")}</div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <DetailMetaCard label={t("task.logs")} value={getLogStatusLabel(log.status, t)} />
                <DetailMetaCard label={t("logs.duration")} value={`${log.duration}ms`} />
                <DetailMetaCard label={t("logs.triggeredBy")} value={getTriggeredByLabel(log.triggeredBy, t)} />
                <DetailMetaCard label={t("editor.agentId")} value={log.agentName} />
              </div>

              <div className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
                <MetaLine label={t("editor.name")} value={log.taskName} />
                <MetaLine label={t("logs.title")} value={formatTime(log.runAt, i18n.language)} />
                <MetaLine label="Run ID" value={log.runId} mono />
                <MetaLine label="Thread ID" value={log.threadId || "-"} mono />
                <MetaLine label="Working Dir" value={log.workingDir || "-"} mono />
                <MetaLine label="Run Dir" value={log.runDir || "-"} mono />
              </div>

              {log.workingDir ? (
                <div className="flex justify-end">
                  <Button variant="outline" onClick={() => void handleOpenWorkingDir(log.workingDir)}>
                    <ExternalLink className="size-4" />
                    {t("common:openInExplorer")}
                  </Button>
                </div>
              ) : null}

              {log.output ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">{t("logs.output")}</div>
                  <pre className="app-scrollbar max-h-[280px] overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{log.output}</pre>
                </div>
              ) : null}

              {log.error ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">{t("logs.error")}</div>
                  <pre className="app-scrollbar max-h-[220px] overflow-x-auto rounded-md bg-destructive/5 p-3 text-xs text-destructive whitespace-pre-wrap">{log.error}</pre>
                </div>
              ) : null}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function MetaLine({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 truncate text-sm text-foreground", mono && "font-mono text-[12px]")} title={value}>
        {value}
      </div>
    </div>
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
