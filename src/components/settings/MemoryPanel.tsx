import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  Database,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import { defaultSettings } from "@/config/defaults";
import type { MemoryItem, MemoryScope, MemoryType } from "@/lib/memory";
import { memoryApiConfigFromSettings } from "@/lib/memory";
import { useMemoryStore } from "@/stores/memory-store";
import type { Settings } from "@/types/config";
import { cn } from "@/lib/utils";
import { PageTitle, SettingDropdown, SettingRow } from "./settings-shared";

const MEMORY_TYPES: MemoryType[] = [
  "preference",
  "profile",
  "project",
  "instruction",
  "correction",
  "communication",
  "workflow",
  "tool",
  "goal",
  "constraint",
];

export function MemoryPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const memory = settings.memory ?? defaultSettings.memory!;
  const stats = useMemoryStore((state) => state.stats);
  const memories = useMemoryStore((state) => state.memories);
  const isLoading = useMemoryStore((state) => state.isLoading);
  const isRebuilding = useMemoryStore((state) => state.isRebuilding);
  const error = useMemoryStore((state) => state.error);
  const lastAutoWriteError = useMemoryStore((state) => state.lastAutoWriteError);
  const loadMemories = useMemoryStore((state) => state.loadMemories);
  const loadStats = useMemoryStore((state) => state.loadStats);
  const rebuildMemoryIndex = useMemoryStore((state) => state.rebuildMemoryIndex);
  const updateMemoryItem = useMemoryStore((state) => state.updateMemoryItem);
  const archiveMemoryItem = useMemoryStore((state) => state.archiveMemoryItem);
  const deleteMemoryItem = useMemoryStore((state) => state.deleteMemoryItem);

  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | MemoryScope>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | MemoryType>("all");
  const [showDisabled, setShowDisabled] = useState(false);
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);

  useEffect(() => {
    void loadMemories({ includeArchived: true });
    void loadStats();
  }, [loadMemories, loadStats]);

  const embeddingReady = Boolean(memoryApiConfigFromSettings(settings));

  const setMemory = (updates: Partial<NonNullable<Settings["memory"]>>) =>
    onUpdate({
      memory: {
        ...memory,
        ...updates,
        retrieval: {
          ...memory.retrieval,
          ...(updates?.retrieval ?? {}),
        },
      },
    });

  const filtered = useMemo(
    () =>
      memories.filter((item) => {
        if (!showDisabled && item.archived) return false;
        if (scopeFilter !== "all" && item.scope !== scopeFilter) return false;
        if (typeFilter !== "all" && item.type !== typeFilter) return false;
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) return true;
        return `${item.content} ${item.tags.join(" ")} ${item.projectKey ?? ""}`
          .toLowerCase()
          .includes(trimmed);
      }),
    [memories, query, scopeFilter, showDisabled, typeFilter],
  );

  return (
    <section>
      <PageTitle title={t("memory.title")} description={t("memory.description")} />

      <div className="mt-8 divide-y divide-border rounded-xl border border-border bg-card">
        <SettingRow
          title={t("memory.enabled")}
          description={t("memory.enabledDesc")}
          control={
            <Switch
              checked={memory.enabled}
              onCheckedChange={(checked) => void setMemory({ enabled: checked })}
            />
          }
        />
        <SettingRow
          title={t("memory.autoWrite")}
          description={t("memory.autoWriteDesc")}
          control={
            <Switch
              checked={memory.autoWrite}
              disabled={!memory.enabled}
              onCheckedChange={(checked) => void setMemory({ autoWrite: checked })}
            />
          }
        />
        <SettingRow
          title={t("memory.projectMemory")}
          description={t("memory.projectMemoryDesc")}
          control={
            <Switch
              checked={memory.projectMemoryEnabled}
              disabled={!memory.enabled}
              onCheckedChange={(checked) =>
                void setMemory({ projectMemoryEnabled: checked })
              }
            />
          }
        />
        <SettingRow
          title={t("memory.reuseKnowledgeEmbedding")}
          description={t("memory.reuseKnowledgeEmbeddingDesc")}
          control={
            <Switch
              checked={memory.reuseKnowledgeEmbedding}
              disabled={!memory.enabled}
              onCheckedChange={(checked) =>
                void setMemory({ reuseKnowledgeEmbedding: checked })
              }
            />
          }
        />
        <SettingRow
          title={t("memory.sensitiveFilter")}
          description={t("memory.sensitiveFilterDesc")}
          control={
            <Switch
              checked={memory.sensitiveFilter}
              disabled={!memory.enabled}
              onCheckedChange={(checked) =>
                void setMemory({ sensitiveFilter: checked })
              }
            />
          }
        />
      </div>

      <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card">
        <SettingRow
          title={t("memory.topK")}
          description={t("memory.topKDesc")}
          control={
            <SettingDropdown
              value={String(memory.retrieval.topK)}
              onChange={(value) =>
                void setMemory({ retrieval: { ...memory.retrieval, topK: Number(value) } })
              }
              options={[3, 5, 8, 10, 15, 20].map((value) => ({
                value: String(value),
                label: String(value),
              }))}
            />
          }
        />
        <SettingRow
          title={t("memory.threshold")}
          description={t("memory.thresholdDesc")}
          control={
            <SettingDropdown
              value={String(memory.retrieval.threshold)}
              onChange={(value) =>
                void setMemory({
                  retrieval: { ...memory.retrieval, threshold: Number(value) },
                })
              }
              options={[0.5, 0.6, 0.62, 0.7, 0.75, 0.8, 0.85, 0.9].map(
                (value) => ({
                  value: String(value),
                  label: String(value),
                }),
              )}
            />
          }
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t("memory.active")} value={stats?.active ?? 0} />
        <StatCard label={t("memory.globalCount")} value={stats?.byScope.global ?? 0} />
        <StatCard label={t("memory.projectCount")} value={stats?.byScope.project ?? 0} />
      </div>

      {!embeddingReady ? (
        <StatusBanner icon={Database} message={t("memory.embeddingMissing")} />
      ) : null}
      {error ? <StatusBanner icon={Brain} message={error} variant="error" /> : null}
      {lastAutoWriteError ? (
        <StatusBanner
          icon={Brain}
          message={t("memory.lastAutoWriteError", { message: lastAutoWriteError })}
          variant="warning"
        />
      ) : null}

      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">{t("memory.management")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("memory.managementDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => void rebuildMemoryIndex()}
            disabled={isRebuilding || !embeddingReady}
          >
            {isRebuilding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {t("memory.rebuild")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ring"
              placeholder={t("memory.searchPlaceholder")}
            />
          </div>
          <SettingDropdown
            value={scopeFilter}
            onChange={(value) => setScopeFilter(value as "all" | MemoryScope)}
            options={[
              { value: "all", label: t("memory.allScopes") },
              { value: "global", label: t("memory.scope.global") },
              { value: "project", label: t("memory.scope.project") },
            ]}
          />
          <SettingDropdown
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as "all" | MemoryType)}
            options={[
              { value: "all", label: t("memory.allTypes") },
              ...MEMORY_TYPES.map((type) => ({
                value: type,
                label: t(`memory.type.${type}`),
              })),
            ]}
          />
          <label className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground">
            <Switch
              checked={showDisabled}
              onCheckedChange={setShowDisabled}
              className="scale-90"
            />
            {t("memory.showDisabled")}
          </label>
        </div>

        <div className="divide-y divide-border">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("common:loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              {t("memory.empty")}
            </div>
          ) : (
            filtered.map((item) => (
              <MemoryRow
                key={item.id}
                memory={item}
                disabled={isLoading}
                onEdit={() => setEditingMemory(item)}
                onToggleEnabled={(id, enabled) =>
                  void archiveMemoryItem(id, !enabled)
                }
                onDelete={() => setDeleteTarget(item)}
              />
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("memory.deleteTitle")}
        message={t("memory.deleteMessage")}
        confirmLabel={t("common:delete")}
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) void deleteMemoryItem(deleteTarget.id);
        }}
      />

      <MemoryEditModal
        memory={editingMemory}
        open={Boolean(editingMemory)}
        onOpenChange={(open) => {
          if (!open) setEditingMemory(null);
        }}
        onSave={updateMemoryItem}
      />
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function StatusBanner({
  icon: Icon,
  message,
  variant = "warning",
}: {
  icon: LucideIcon;
  message: string;
  variant?: "warning" | "error";
}) {
  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        variant === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function MemoryRow({
  memory,
  disabled,
  onEdit,
  onToggleEnabled,
  onDelete,
}: {
  memory: MemoryItem;
  disabled: boolean;
  onEdit: () => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("settings");
  const isEnabled = !memory.archived;
  const isIndexed = Boolean(memory.indexed);
  const statusLabel = isEnabled
    ? isIndexed
      ? t("memory.indexed")
      : t("memory.notIndexed")
    : t("memory.disabledStatus");

  return (
    <div className={cn("px-5 py-4", memory.archived && "opacity-60")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{t(`memory.scope.${memory.scope}`)}</Badge>
            <Badge>{t(`memory.type.${memory.type}`)}</Badge>
            <StatusBadge
              label={statusLabel}
              tone={isEnabled && isIndexed ? "success" : "muted"}
            />
            <span className="text-xs text-muted-foreground">
              {formatDate(memory.updatedAt)}
            </span>
          </div>

          <p className="text-sm leading-6">{memory.content}</p>
          {memory.tags.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {memory.tags.join(", ")}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          <Button
            size="sm"
            variant="outline"
            title={t("common:edit")}
            aria-label={t("common:edit")}
            onClick={onEdit}
            disabled={disabled}
          >
            <Pencil className="size-4" />
            {t("common:edit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            title={t("common:delete")}
            aria-label={t("common:delete")}
            onClick={onDelete}
            disabled={disabled}
          >
            <Trash2 className="size-4" />
            {t("common:delete")}
          </Button>
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => onToggleEnabled(memory.id, checked)}
            disabled={disabled}
            aria-label={isEnabled ? t("memory.disableMemory") : t("memory.enableMemory")}
          />
        </div>
      </div>
    </div>
  );
}

function MemoryEditModal({
  memory,
  open,
  onOpenChange,
  onSave,
}: {
  memory: MemoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "type" | "tags" | "archived">>,
  ) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryType>("preference");
  const [tags, setTags] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!memory) return;
    setContent(memory.content);
    setType(memory.type);
    setTags(memory.tags.join(", "));
    setEnabled(!memory.archived);
  }, [memory]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!memory || !content.trim()) return;

    setSubmitting(true);
    try {
      await onSave(memory.id, {
        content: content.trim(),
        type,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        archived: !enabled,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!memory) return null;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="lg">
        <ModalHeader>
          <ModalTitle>{t("memory.editTitle")}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                {t("memory.content")} <span className="text-destructive">*</span>
              </span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={4}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                required
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t("memory.typeLabel")}
                </span>
                <SettingDropdown
                  value={type}
                  onChange={(value) => setType(value as MemoryType)}
                  className="w-full rounded-md"
                  options={MEMORY_TYPES.map((item) => ({
                    value: item,
                    label: t(`memory.type.${item}`),
                  }))}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t("memory.tags")}
                </span>
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                  placeholder={t("memory.tagsPlaceholder")}
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2.5">
              <div>
                <p className="text-sm text-foreground">{t("memory.enabledMemory")}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("memory.enabledMemoryDesc")}
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              {t("memory.disabledMemoryHint")}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={!content.trim() || submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("common:save")}
              </Button>
            </div>
          </form>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "muted";
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" ? "bg-emerald-500" : "bg-muted-foreground/45",
        )}
      />
      {label}
    </span>
  );
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}
