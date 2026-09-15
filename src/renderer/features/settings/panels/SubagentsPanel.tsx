import { FolderOpen, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { field, ghostButton, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { Textarea } from "@/renderer/components/ui/textarea";
import { thinkingLabelKey } from "@/renderer/features/chat/thinking";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { ALL_THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "@/shared/contracts/common";
import type { ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_NAME_PATTERN,
  type SubagentCatalog,
  type SubagentInfo,
  type SubagentWriteRequest,
  subagentCanMutate,
} from "@/shared/contracts/subagent";
import {
  PanelLoading,
  SettingsField,
  SettingsSection,
  secondaryButton,
  settingsInput,
  settingsTextarea,
} from "../settings-shared";

/**
 * 模型下拉的值编码（`serviceId::modelId`）。
 * 与模型服务面板的「默认路由模型」用同一套编码：两个面板存的是同一种引用，
 * 分开编码只会让「同一个模型在两处看起来不一样」。
 */
const MODEL_SEPARATOR = "::";

/**
 * `read()` 给的是磁盘原文（含 frontmatter），而编辑框只编辑 prompt 正文。
 * 不切开的话保存时会把 frontmatter 当成正文再写一遍，磁盘上就会攒出第二份 ——
 * 结构化字段（名称、工具、模型……）由主进程按请求体重新序列化，这里只需要正文。
 */
function promptBody(content: string): string {
  const matched = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return matched === null ? content : content.slice(matched[0].length);
}

/**
 * 轮次上限的文本 → 落盘值。
 *
 * 留空表示「用默认」；非整数、小于 1 或超过上限的值同样按默认处理，不写进设置 ——
 * 上限是防止一个定义把子智能体跑爆的硬约束（见契约注释），
 * 与其把一个会被运行层拒绝的数字写盘，不如顺手夹回默认。
 */
function parseMaxTurns(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SUBAGENT_MAX_TURNS) return null;
  return parsed;
}

/** 表单字段块：眉题 + 控件 + 说明（校验失败时说明换成原因） */
function FieldBlock({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className={typeEyebrow}>{label}</span>
      {children}
      {error === undefined ? (
        hint === undefined ? null : (
          <p className="text-[11px] text-ink-4">{hint}</p>
        )
      ) : (
        <p className="text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );
}

/** 编辑器目标：null = 关闭；`info: null` = 新建 */
type EditorTarget = { info: SubagentInfo | null } | null;

/**
 * 定义编辑器（新建 / 编辑共用）。
 *
 * 编辑时先把磁盘原文读回来：正文进 textarea，结构化字段进各自控件 ——
 * 用户不该在文本框里手写 frontmatter（写坏了就是一条读不出来的定义）。
 */
function SubagentEditor({
  info,
  services,
  onClose,
  onSaved,
}: {
  info: SubagentInfo | null;
  services: ModelServiceConfig[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(info?.name ?? "");
  const [description, setDescription] = useState(info?.description ?? "");
  // 新建时预勾只读三件套：与「没有显式指定工具」的运行时默认值一致
  const [tools, setTools] = useState<string[]>(info?.tools ?? [...DEFAULT_SUBAGENT_TOOLS]);
  const [model, setModel] = useState<ModelRef | null>(info?.model ?? null);
  const [thinking, setThinking] = useState<ThinkingLevel | null>(info?.thinkingLevel ?? null);
  const [maxTurns, setMaxTurns] = useState(info === null ? "" : String(info.maxTurns));
  // null = 正文还没读回来（编辑态）；新建时直接是空串，不必等一次 IPC
  const [prompt, setPrompt] = useState<string | null>(info === null ? "" : null);
  const [readFailed, setReadFailed] = useState(false);
  const [errors, setErrors] = useState({ name: false, description: false, prompt: false });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const loadPrompt = useCallback(async () => {
    if (info === null) {
      setPrompt("");
      return;
    }
    setPrompt(null);
    setReadFailed(false);
    try {
      const result = await window.oint.subagents.read(info.name);
      setPrompt(promptBody(result.content));
    } catch {
      setReadFailed(true);
    }
  }, [info]);

  useEffect(() => {
    void loadPrompt();
  }, [loadPrompt]);

  const title = info === null ? t("settings.subagentNew") : t("settings.subagentEdit");

  if (prompt === null) {
    return (
      <SettingsSection title={title}>
        {readFailed ? (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{t("errors.loadFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void loadPrompt()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <PanelLoading />
        )}
      </SettingsSection>
    );
  }

  const toggleTool = (tool: string, checked: boolean) => {
    setTools((current) => (checked ? [...current, tool] : current.filter((item) => item !== tool)));
  };

  const handleModelChange = (value: string) => {
    const at = value.indexOf(MODEL_SEPARATOR);
    if (at < 0) {
      setModel(null);
      return;
    }
    setModel({
      serviceId: value.slice(0, at),
      modelId: value.slice(at + MODEL_SEPARATOR.length),
    });
  };

  const handleSave = async () => {
    // 校验一次算全：三处问题一起标出来，不要逼用户改一个再发现下一个
    const nextErrors = {
      name: !SUBAGENT_NAME_PATTERN.test(name.trim()),
      description: description.trim() === "",
      prompt: prompt.trim() === "",
    };
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.description || nextErrors.prompt) return;

    setSaving(true);
    setSaveFailed(false);
    const request: SubagentWriteRequest = {
      name: name.trim(),
      description: description.trim(),
      prompt,
      // 按契约里的规范顺序写：同一组工具不因勾选先后产生不同的文件内容
      tools: SUBAGENT_ASSIGNABLE_TOOLS.filter((tool) => tools.includes(tool)),
      model,
      thinkingLevel: thinking,
      maxTurns: parseMaxTurns(maxTurns),
    };
    // 编辑时带上原名：主进程据此定位旧文件（名称变了就是重命名，旧文件要清掉）
    if (info !== null) request.originalName = info.name;
    try {
      await window.oint.subagents.write(request);
    } catch {
      setSaveFailed(true);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
  };

  const modelValue = model === null ? "" : `${model.serviceId}${MODEL_SEPARATOR}${model.modelId}`;

  return (
    <SettingsSection title={title}>
      <FieldBlock
        label={t("settings.subagentName")}
        hint={t("settings.subagentNameHint")}
        error={errors.name ? t("settings.subagentNameInvalid") : undefined}
      >
        <input
          type="text"
          value={name}
          aria-label={t("settings.subagentName")}
          aria-invalid={errors.name}
          onChange={(event) => setName(event.target.value)}
          className={cn(settingsInput, "w-full font-mono")}
        />
      </FieldBlock>

      <FieldBlock
        label={t("settings.subagentDescription")}
        hint={t("settings.subagentDescriptionHint")}
        error={errors.description ? t("settings.subagentDescriptionRequired") : undefined}
      >
        <input
          type="text"
          value={description}
          aria-label={t("settings.subagentDescription")}
          aria-invalid={errors.description}
          onChange={(event) => setDescription(event.target.value)}
          className={cn(settingsInput, "w-full")}
        />
      </FieldBlock>

      <FieldBlock
        label={t("settings.subagentPrompt")}
        hint={t("settings.subagentPromptHint")}
        error={errors.prompt ? t("settings.subagentPromptRequired") : undefined}
      >
        <Textarea
          value={prompt}
          aria-label={t("settings.subagentPrompt")}
          aria-invalid={errors.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className={cn(settingsTextarea, "min-h-[220px] resize-y")}
        />
      </FieldBlock>

      <FieldBlock label={t("settings.subagentTools")} hint={t("settings.subagentToolsHint")}>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={tools.includes(tool)}
                aria-label={tool}
                onChange={(event) => toggleTool(tool, event.target.checked)}
                className="size-3.5 accent-foreground"
              />
              <span className={mono}>{tool}</span>
            </label>
          ))}
        </div>
      </FieldBlock>

      <div className="grid grid-cols-2 gap-3">
        <FieldBlock label={t("settings.subagentModel")}>
          <select
            value={modelValue}
            aria-label={t("settings.subagentModel")}
            onChange={(event) => handleModelChange(event.target.value)}
            className={cn(settingsInput, "w-full")}
          >
            {/* 原生 select 允许空串值，因此「跟随主会话」直接用它，不必借 Radix 的哨兵 */}
            <option value="">{t("settings.subagentModelInherit")}</option>
            {services.flatMap((service) =>
              service.models.map((entry) => (
                <option
                  key={`${service.id}${MODEL_SEPARATOR}${entry.id}`}
                  value={`${service.id}${MODEL_SEPARATOR}${entry.id}`}
                >
                  {`${service.name} · ${entry.name ?? entry.id}`}
                </option>
              )),
            )}
          </select>
        </FieldBlock>

        <FieldBlock label={t("settings.subagentThinking")}>
          <select
            value={thinking ?? ""}
            aria-label={t("settings.subagentThinking")}
            onChange={(event) =>
              setThinking(event.target.value === "" ? null : (event.target.value as ThinkingLevel))
            }
            className={cn(settingsInput, "w-full")}
          >
            <option value="">{t("settings.subagentThinkingInherit")}</option>
            {ALL_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(thinkingLabelKey(level))}
              </option>
            ))}
          </select>
        </FieldBlock>
      </div>

      <FieldBlock label={t("settings.subagentMaxTurns")}>
        <input
          type="number"
          min={1}
          max={MAX_SUBAGENT_MAX_TURNS}
          value={maxTurns}
          aria-label={t("settings.subagentMaxTurns")}
          placeholder={t("settings.subagentMaxTurnsInherit", { count: DEFAULT_SUBAGENT_MAX_TURNS })}
          onChange={(event) => setMaxTurns(event.target.value)}
          className={cn(settingsInput, "w-28 font-mono")}
        />
      </FieldBlock>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-destructive">{saveFailed ? t("errors.generic") : ""}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("settings.subagentCancel")}
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? t("common.loading") : t("settings.subagentSave")}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

function SubagentsPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [catalog, setCatalog] = useState<SubagentCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [confirmRemove, setConfirmRemove] = useState<SubagentInfo | null>(null);

  // 设置面板不挂在某个会话上，扫描起点用默认工作目录（与技能面板同口径）
  const workingDir = settings.defaultWorkingDir ?? undefined;

  const refresh = useCallback(async () => {
    setFailed(false);
    setCatalog(null);
    try {
      setCatalog(await window.oint.subagents.list(workingDir));
    } catch {
      setFailed(true);
      setCatalog({ subagents: [], diagnostics: [] });
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = (name: string, enabled: boolean) => {
    const disabled = new Set(settings.disabledSubagentNames);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    void update({ disabledSubagentNames: [...disabled] });
  };

  const handleReveal = async (name: string) => {
    setActionFailed(false);
    try {
      const result = await window.oint.subagents.reveal(name);
      if (!result.ok) setActionFailed(true);
    } catch {
      setActionFailed(true);
    }
  };

  const handleRemove = async (info: SubagentInfo) => {
    setConfirmRemove(null);
    setActionFailed(false);
    try {
      await window.oint.subagents.remove(info.name);
    } catch {
      setActionFailed(true);
      return;
    }
    // 删掉之后目录变了：重新拉一次，别让列表停在快照上
    await refresh();
  };

  const handleSaved = async () => {
    setEditor(null);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SettingsField
          label={t("settings.subagentsEnabled")}
          description={t("settings.subagentsEnabledDesc")}
          control={
            <Switch
              size="sm"
              checked={settings.subagentsEnabled}
              onCheckedChange={(checked) => void update({ subagentsEnabled: checked })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.subagentsList")}
        description={t("settings.subagentsListDesc")}
      >
        {failed ? (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{t("errors.loadFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void refresh()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : catalog === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : catalog.subagents.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-ink-3">
            {t("settings.subagentsEmpty")}
            <span className="mt-1 block text-xs text-ink-4">
              {t("settings.subagentsEmptyHint")}
            </span>
          </p>
        ) : (
          <div className="space-y-2">
            {catalog.subagents.map((info) => {
              // 设置里的禁用名单是唯一事实来源，避免列表快照过期（与技能列表同口径）
              const enabled = !settings.disabledSubagentNames.includes(info.name);
              const canWrite = subagentCanMutate(info.tools);
              return (
                <div
                  key={`${info.source}:${info.name}`}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium">{info.name}</span>
                      <Badge
                        variant="outline"
                        className={cn(mono, "border-border/60 px-1.5 text-ink-3")}
                      >
                        {info.source === "user"
                          ? t("rightPanel.subagentSourceUser")
                          : t("rightPanel.subagentSourceBuiltin")}
                      </Badge>
                      {/* 写权限是「会不会动我的文件」这件事，比工具清单本身更该一眼看到 */}
                      <Badge
                        variant="outline"
                        className={cn(
                          mono,
                          "border-border/60 px-1.5",
                          canWrite ? "text-amber-600 dark:text-amber-400" : "text-ink-3",
                        )}
                      >
                        {canWrite
                          ? t("settings.subagentToolsCanWrite")
                          : t("settings.subagentToolsReadOnly")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{info.description}</p>
                    {info.tools.length === 0 ? null : (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {info.tools.map((tool) => (
                          <span
                            key={tool}
                            className={cn(field, mono, "rounded-full px-1.5 py-0.5 text-ink-3")}
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-ink-4">
                      {t("settings.subagentModel")}
                      {" · "}
                      {info.model === null
                        ? t("settings.subagentModelInherit")
                        : info.model.modelId}
                    </p>
                    {info.source === "builtin" ? (
                      <p className="mt-0.5 text-xs text-ink-4">
                        {t("settings.subagentBuiltinHint")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {info.source === "user" ? (
                      <>
                        <button
                          type="button"
                          aria-label={t("settings.subagentEdit")}
                          title={t("settings.subagentEdit")}
                          className={cn(ghostButton, "size-6 shrink-0")}
                          onClick={() => setEditor({ info })}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("settings.subagentReveal")}
                          title={t("settings.subagentReveal")}
                          className={cn(ghostButton, "size-6 shrink-0")}
                          onClick={() => void handleReveal(info.name)}
                        >
                          <FolderOpen className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("settings.subagentDelete")}
                          title={t("settings.subagentDelete")}
                          className={cn(ghostButton, "size-6 shrink-0 hover:text-destructive")}
                          onClick={() => setConfirmRemove(info)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </>
                    ) : null}
                    {/* 无障碍名带上定义名：一列开关都叫「启用」的话读屏用户分不出是哪一个 */}
                    <Switch
                      size="sm"
                      aria-label={`${info.name} · ${
                        enabled ? t("settings.subagentEnabled") : t("settings.subagentDisabled")
                      }`}
                      checked={enabled}
                      onCheckedChange={(checked) => handleToggle(info.name, checked)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {actionFailed ? (
          <p className="text-[13px] text-destructive">{t("errors.generic")}</p>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            onClick={() => setEditor({ info: null })}
          >
            {t("settings.subagentNew")}
          </Button>
        </div>
      </SettingsSection>

      {/* 解析失败的定义必须在界面上出现：静默消失会让人以为「我放的文件没生效」 */}
      {catalog !== null && catalog.diagnostics.length > 0 ? (
        <SettingsSection title={t("settings.subagentDiagnostics")}>
          <ul className="space-y-1 rounded-xl border border-amber-600/25 bg-amber-600/[0.08] p-3 text-amber-600 dark:text-amber-400">
            {catalog.diagnostics.map((item) => (
              <li key={item} className={cn(mono, "break-all")}>
                {item}
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      {editor === null ? null : (
        <SubagentEditor
          info={editor.info}
          services={settings.services}
          onClose={() => setEditor(null)}
          onSaved={() => void handleSaved()}
        />
      )}

      {/* 删除定义二次确认（与模型服务面板同一个口径：不可撤销的动作一律确认） */}
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <DialogContent className="rounded-xl">
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>
              {t("settings.subagentDeleteConfirm", { name: confirmRemove?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => confirmRemove && void handleRemove(confirmRemove)}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SubagentsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <SubagentsPanelBody settings={settings} />;
}
