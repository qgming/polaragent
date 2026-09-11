import { Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghostButton, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow, typePackage } from "@/renderer/components/assistant-ui/type";
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
import { Input } from "@/renderer/components/ui/input";
import { Switch } from "@/renderer/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { WireFormat } from "@/shared/contracts/common";
import type { ModelCatalogEntry } from "@/shared/contracts/models";
import type { ModelEntry, ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  SELECT_NONE,
  SettingsField,
  SettingsSection,
  SettingsSelect,
  secondaryButton,
  settingsInput,
} from "../settings-shared";

/** 草稿模型携带稳定 key，避免用数组下标做 React key；保存时剥离 */
interface DraftModel extends ModelEntry {
  key: string;
}

interface ServiceDraft {
  /** 空串表示新增服务 */
  id: string;
  name: string;
  baseUrl: string;
  /** 已保存的 API Key；界面不回显，仅用于「未改 key」的兜底 */
  apiKey: string;
  /** 本次编辑新输入的 Key；非空时保存将覆盖 apiKey */
  apiKeyInput: string;
  wireFormat: WireFormat;
  models: DraftModel[];
}

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok" | "error"; message: string };

/** 单行 models.dev 匹配提示：error 用警示色，其余用弱化色 */
interface MatchNote {
  text: string;
  tone: "ok" | "error";
}

/** 命名空间分隔符：`serviceId::modelId` */
const MODEL_VALUE_SEPARATOR = "::";

function toDraft(service?: ModelServiceConfig): ServiceDraft {
  return {
    id: service?.id ?? "",
    name: service?.name ?? "",
    baseUrl: service?.baseUrl ?? "",
    apiKey: service?.apiKey ?? "",
    apiKeyInput: "",
    wireFormat: service?.wireFormat ?? "openai-completions",
    models: (service?.models ?? []).map((model) => ({ ...model, key: crypto.randomUUID() })),
  };
}

/** 空串 → undefined；非法数字同样回落 undefined，避免脏值写盘 */
function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 表单字段块：眉题 + 控件 + 可选说明 */
function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className={typeEyebrow}>{label}</span>
      {children}
      {hint ? <p className="text-[11px] text-foreground/40">{hint}</p> : null}
    </div>
  );
}

/** 服务编辑弹窗：字段 + 模型列表编辑器 + 拉取模型 */
function ServiceEditor({
  draft,
  onChange,
  onClose,
  onSave,
}: {
  draft: ServiceDraft;
  onChange: (next: ServiceDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const [fetch, setFetch] = useState<FetchState>({ status: "idle" });
  const [matchNotes, setMatchNotes] = useState<Record<string, MatchNote>>({});
  // 异步匹配返回时用 ref 读取最新草稿，避免闭包里的旧 draft 覆盖用户输入
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const noteTimers = useRef<Record<string, number>>({});

  useEffect(
    () => () => {
      for (const timer of Object.values(noteTimers.current)) window.clearTimeout(timer);
    },
    [],
  );

  const isNew = draft.id === "";
  const effectiveApiKey = draft.apiKeyInput.trim() !== "" ? draft.apiKeyInput.trim() : draft.apiKey;
  // 校验：Base URL 必填、模型 ID 非空、最大输出非法（<1）时禁止保存
  const canSave =
    draft.baseUrl.trim() !== "" &&
    draft.models.every(
      (m) => m.id.trim() !== "" && (m.maxTokens === undefined || m.maxTokens >= 1),
    );

  const patchModel = (index: number, patch: Partial<ModelEntry>) => {
    onChange({
      ...draft,
      models: draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
    });
  };

  /** 按稳定 key 打补丁：异步返回时数组下标可能已漂移 */
  const patchModelByKey = (key: string, patch: Partial<ModelEntry>) => {
    const current = draftRef.current;
    onChange({
      ...current,
      models: current.models.map((model) => (model.key === key ? { ...model, ...patch } : model)),
    });
  };

  /** 单行提示：transient 时 1.5s 后自动消失（自动匹配成功用） */
  const showNote = (key: string, text: string, tone: MatchNote["tone"], transient = false) => {
    setMatchNotes((notes) => ({ ...notes, [key]: { text, tone } }));
    const pending = noteTimers.current[key];
    if (pending !== undefined) window.clearTimeout(pending);
    if (!transient) {
      delete noteTimers.current[key];
      return;
    }
    noteTimers.current[key] = window.setTimeout(() => {
      setMatchNotes((notes) => {
        const next = { ...notes };
        delete next[key];
        return next;
      });
      delete noteTimers.current[key];
    }, 1500);
  };

  /** 用目录条目强制覆盖模型元数据 */
  const applyCatalogEntry = (key: string, entry: ModelCatalogEntry) => {
    patchModelByKey(key, {
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      reasoning: entry.reasoning,
      input: [...entry.input],
    });
  };

  /** 模型 ID 失焦：仅在元数据三项全空时自动匹配，失败静默 */
  const handleIdBlur = async (key: string) => {
    const model = draftRef.current.models.find((item) => item.key === key);
    if (!model) return;
    const id = model.id.trim();
    if (id === "") return;
    const untouched = !model.name?.trim() && model.contextWindow == null && model.maxTokens == null;
    if (!untouched) return;
    try {
      const result = await window.polaragent.models.lookup(id);
      if (!result.ok || result.match === null) return;
      // 等待期间用户可能已开始填写，确认仍为空再回填
      const latest = draftRef.current.models.find((item) => item.key === key);
      if (!latest || latest.id.trim() !== id) return;
      if (latest.name?.trim() || latest.contextWindow != null || latest.maxTokens != null) return;
      applyCatalogEntry(key, result.match);
      showNote(key, t("settings.catalogMatched"), "ok", true);
    } catch {
      // 自动匹配失败不打扰输入
    }
  };

  /** 显式匹配按钮：命中即覆盖，未命中/失败给出明确提示 */
  const handleCatalogMatch = async (key: string) => {
    const model = draftRef.current.models.find((item) => item.key === key);
    const id = model?.id.trim() ?? "";
    if (id === "") return;
    try {
      const result = await window.polaragent.models.lookup(id);
      if (!result.ok) {
        showNote(key, t("settings.catalogFailed"), "error");
        return;
      }
      if (result.match === null) {
        showNote(key, t("settings.catalogNotFound"), "error");
        return;
      }
      applyCatalogEntry(key, result.match);
      showNote(key, t("settings.catalogMatched"), "ok", true);
    } catch {
      showNote(key, t("settings.catalogFailed"), "error");
    }
  };

  const addModel = () => {
    onChange({ ...draft, models: [...draft.models, { id: "", key: crypto.randomUUID() }] });
  };

  const removeModel = (index: number) => {
    onChange({ ...draft, models: draft.models.filter((_, i) => i !== index) });
  };

  const handleFetch = async () => {
    if (!draft.baseUrl.trim()) return;
    setFetch({ status: "loading" });
    try {
      const result = await window.polaragent.services.fetchModels({
        baseUrl: draft.baseUrl.trim(),
        apiKey: effectiveApiKey,
        wireFormat: draft.wireFormat,
      });
      if (!result.ok) {
        setFetch({ status: "error", message: `${t("settings.fetchFailed")}：${result.reason}` });
        return;
      }
      const existing = new Set(draft.models.map((m) => m.id.trim()));
      const added = result.modelIds.filter((id) => !existing.has(id));
      if (added.length === 0) {
        // 没有新模型属于信息提示，不算失败
        setFetch({ status: "ok", message: t("settings.fetchModelsEmpty") });
        return;
      }
      onChange({
        ...draft,
        models: [...draft.models, ...added.map((id) => ({ id, key: crypto.randomUUID() }))],
      });
      setFetch({ status: "ok", message: `${t("settings.fetchModels")} +${added.length}` });
    } catch (error) {
      setFetch({
        status: "error",
        message: `${t("settings.testFailed")}：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[86vh] w-[560px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        <DialogHeader className="border-border/60 border-b p-4 pr-12">
          <DialogTitle className={cn(typeEyebrow, "font-normal")}>
            {isNew ? t("settings.addService") : t("settings.editService")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("settings.modelServicesDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <FieldBlock label={t("settings.serviceName")}>
            <Input
              value={draft.name}
              placeholder={t("settings.serviceName")}
              aria-label={t("settings.serviceName")}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className={settingsInput}
            />
          </FieldBlock>

          <FieldBlock label={t("settings.baseUrl")} hint={t("settings.baseUrlHint")}>
            <Input
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              aria-label={t("settings.baseUrl")}
              onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
              className={cn(settingsInput, "font-mono")}
            />
          </FieldBlock>

          <FieldBlock label={t("settings.apiKey")}>
            <div className="relative">
              {/* 已保存的 key 只用 placeholder 遮罩回显，用户输入新值才覆盖 */}
              <Input
                type={showApiKey ? "text" : "password"}
                value={draft.apiKeyInput}
                placeholder={draft.apiKey ? "••••••" : ""}
                aria-label={t("settings.apiKey")}
                autoComplete="off"
                onChange={(e) => onChange({ ...draft, apiKeyInput: e.target.value })}
                className={cn(settingsInput, "pr-9 font-mono")}
              />
              <button
                type="button"
                aria-label={t("settings.apiKey")}
                onClick={() => setShowApiKey((value) => !value)}
                className={cn(ghostButton, "absolute top-1/2 right-1 size-6 -translate-y-1/2")}
              >
                {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </FieldBlock>

          <FieldBlock label={t("settings.wireFormat")}>
            <SettingsSelect
              ariaLabel={t("settings.wireFormat")}
              value={draft.wireFormat}
              onChange={(value) => onChange({ ...draft, wireFormat: value as WireFormat })}
              className="w-full max-w-none"
              items={[
                { value: "openai-completions", label: t("settings.wireFormatCompletions") },
                { value: "openai-responses", label: t("settings.wireFormatResponses") },
              ]}
            />
          </FieldBlock>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={typeEyebrow}>
                {t("settings.models")} · {draft.models.length}
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={addModel}>
                <Plus className="size-3.5" />
                {t("settings.addModel")}
              </Button>
            </div>

            {draft.models.map((model, index) => {
              const imageEnabled = model.input?.includes("image") ?? false;
              // 与主进程装配保持一致：达到/超过上下文窗口视为误填，不会传递给服务端
              const exceedsContext =
                model.maxTokens !== undefined &&
                model.contextWindow !== undefined &&
                model.maxTokens >= model.contextWindow;
              const note = matchNotes[model.key];
              return (
                <div
                  key={model.key}
                  className="space-y-2 rounded-[10px] border border-border/60 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={model.id}
                      placeholder={t("settings.modelId")}
                      aria-label={t("settings.modelId")}
                      onChange={(e) => patchModel(index, { id: e.target.value })}
                      onBlur={() => void handleIdBlur(model.key)}
                      className={cn(settingsInput, "flex-1 font-mono")}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={t("settings.catalogMatch")}
                          className={cn(ghostButton, "size-7 shrink-0")}
                          onClick={() => void handleCatalogMatch(model.key)}
                        >
                          <WandSparkles className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("settings.catalogMatch")}</TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      className={cn(ghostButton, "size-7 shrink-0 hover:text-destructive")}
                      onClick={() => removeModel(index)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <Input
                    value={model.name ?? ""}
                    placeholder={t("settings.modelName")}
                    aria-label={t("settings.modelName")}
                    onChange={(e) => patchModel(index, { name: e.target.value })}
                    className={settingsInput}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      value={model.contextWindow ?? ""}
                      placeholder={t("settings.contextWindow")}
                      aria-label={t("settings.contextWindow")}
                      onChange={(e) =>
                        patchModel(index, { contextWindow: parseOptionalNumber(e.target.value) })
                      }
                      className={cn(settingsInput, "font-mono")}
                    />
                    <Input
                      type="number"
                      value={model.maxTokens ?? ""}
                      placeholder={t("settings.maxTokens")}
                      aria-label={t("settings.maxTokens")}
                      aria-invalid={exceedsContext}
                      onChange={(e) =>
                        patchModel(index, { maxTokens: parseOptionalNumber(e.target.value) })
                      }
                      className={cn(
                        settingsInput,
                        "font-mono",
                        exceedsContext && "border-destructive",
                      )}
                    />
                  </div>
                  {exceedsContext ? (
                    <p className="text-[11px] text-destructive">
                      {t("settings.maxTokensExceedsContext")}
                    </p>
                  ) : (
                    <p className="text-[11px] text-foreground/40">{t("settings.maxTokensHint")}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="flex items-center gap-1.5 text-xs text-foreground/45">
                      <Switch
                        size="sm"
                        aria-label={t("settings.reasoning")}
                        checked={model.reasoning ?? false}
                        onCheckedChange={(checked) => patchModel(index, { reasoning: checked })}
                      />
                      {t("settings.reasoning")}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-foreground/45">
                      <Switch
                        size="sm"
                        aria-label={t("settings.inputImage")}
                        checked={imageEnabled}
                        onCheckedChange={(checked) =>
                          patchModel(index, {
                            input: checked
                              ? [...new Set([...(model.input ?? ["text"]), "image" as const])]
                              : (model.input ?? []).filter((kind) => kind !== "image"),
                          })
                        }
                      />
                      {t("settings.inputImage")}
                    </span>
                  </div>
                  {note ? (
                    <p
                      className={cn(
                        "text-[11px]",
                        note.tone === "error" ? "text-destructive" : "text-foreground/40",
                      )}
                    >
                      {note.text}
                    </p>
                  ) : null}
                </div>
              );
            })}

            {fetch.status !== "idle" ? (
              <p
                className={cn(
                  "text-xs",
                  fetch.status === "error" ? "text-destructive" : "text-foreground/45",
                )}
              >
                {fetch.status === "loading" ? t("common.loading") : fetch.message}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between border-border/60 border-t p-4 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={fetch.status === "loading" || draft.baseUrl.trim() === ""}
            onClick={() => void handleFetch()}
          >
            <RefreshCw className={cn("size-3.5", fetch.status === "loading" && "animate-spin")} />
            {t("settings.fetchModels")}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" disabled={!canSave} onClick={onSave}>
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServicesPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ModelServiceConfig | null>(null);

  const handleSave = () => {
    if (!draft) return;
    // 剥离草稿 key，仅保留契约字段；名称为空时回落 baseUrl，保证卡片可读
    const models: ModelEntry[] = draft.models.map(({ key, ...model }) => ({
      ...model,
      id: model.id.trim(),
    }));
    const next: ModelServiceConfig = {
      id: draft.id || crypto.randomUUID(),
      name: draft.name.trim() || draft.baseUrl.trim(),
      baseUrl: draft.baseUrl.trim(),
      // 用户输入了新 Key 才覆盖；否则沿用已保存的（界面不回显）
      apiKey: draft.apiKeyInput.trim() !== "" ? draft.apiKeyInput.trim() : draft.apiKey,
      wireFormat: draft.wireFormat,
      models,
    };
    const services = draft.id
      ? settings.services.map((service) => (service.id === next.id ? next : service))
      : [...settings.services, next];
    void update({ services });
    setDraft(null);
  };

  const handleRemove = (service: ModelServiceConfig) => {
    const patch: Partial<Settings> = {
      services: settings.services.filter((item) => item.id !== service.id),
    };
    // 被删服务若被默认模型/AI 审批模型引用，一并清空避免悬空引用
    if (settings.defaultModel?.serviceId === service.id) patch.defaultModel = null;
    if (settings.aiApprovalModel?.serviceId === service.id) patch.aiApprovalModel = null;
    void update(patch);
    setConfirmRemove(null);
  };

  const defaultModelValue = settings.defaultModel
    ? `${settings.defaultModel.serviceId}${MODEL_VALUE_SEPARATOR}${settings.defaultModel.modelId}`
    : SELECT_NONE;

  // 下拉项的值不允许为空串，「未指定」走 SELECT_NONE 哨兵
  const defaultModelItems = [
    { value: SELECT_NONE, label: "—" },
    ...settings.services.flatMap((service) =>
      service.models.map((model) => ({
        value: `${service.id}${MODEL_VALUE_SEPARATOR}${model.id}`,
        label: `${service.name} · ${model.name ?? model.id}`,
      })),
    ),
  ];

  const handleDefaultModelChange = (value: string) => {
    if (value === SELECT_NONE) {
      void update({ defaultModel: null });
      return;
    }
    const index = value.indexOf(MODEL_VALUE_SEPARATOR);
    const serviceId = value.slice(0, index);
    const modelId = value.slice(index + MODEL_VALUE_SEPARATOR.length);
    if (serviceId && modelId) void update({ defaultModel: { serviceId, modelId } });
  };

  return (
    <div className="space-y-6">
      {/* 分类名已由模态的大标题给出（「模型服务」），这里只留一句范围说明与动作，不重复标题 */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs text-foreground/45">
          {t("settings.modelServicesDesc")}
        </p>
        <Button type="button" size="sm" onClick={() => setDraft(toDraft())}>
          <Plus className="size-4" />
          {t("settings.addService")}
        </Button>
      </div>

      {settings.services.length === 0 ? (
        <div className="rounded-xl border border-border/60 p-6 text-center">
          <p className="text-[13.5px] font-medium">{t("settings.noServices")}</p>
          <p className="mt-1 text-xs text-foreground/45">{t("settings.noServicesHint")}</p>
          <Button type="button" size="sm" className="mt-3" onClick={() => setDraft(toDraft())}>
            <Plus className="size-4" />
            {t("settings.addService")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {settings.services.map((service) => (
            <div
              key={service.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{service.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(mono, "border-border/60 px-1.5 text-foreground/50")}
                  >
                    {service.wireFormat === "openai-completions" ? "completions" : "responses"}
                  </Badge>
                </div>
                <p
                  className={cn(typePackage, "mt-1 truncate text-foreground/40")}
                  title={service.baseUrl}
                >
                  {service.baseUrl}
                </p>
                <p className="mt-0.5 text-xs text-foreground/45">
                  {t("settings.models")} · {service.models.length}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={t("settings.editService")}
                  className={cn(ghostButton, "size-7")}
                  onClick={() => setDraft(toDraft(service))}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  className={cn(ghostButton, "size-7 hover:text-destructive")}
                  onClick={() => setConfirmRemove(service)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SettingsSection
        title={t("settings.defaultModel")}
        description={t("settings.defaultModelDesc")}
      >
        <SettingsField
          label={t("settings.defaultModel")}
          control={
            <SettingsSelect
              ariaLabel={t("settings.defaultModel")}
              value={defaultModelValue}
              items={defaultModelItems}
              onChange={handleDefaultModelChange}
              className="w-72"
            />
          }
        />
      </SettingsSection>

      {draft ? (
        <ServiceEditor
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={handleSave}
        />
      ) : null}

      {/* 删除服务二次确认（D1：危险操作一律确认） */}
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <DialogContent className="rounded-xl">
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>{confirmRemove?.name ?? ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => confirmRemove && handleRemove(confirmRemove)}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ServicesPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <ServicesPanelBody settings={settings} />;
}
