import { Eye, EyeOff, Plus, RefreshCw, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { field, ghostButton, mono } from "@/renderer/components/assistant-ui/elements/surfaces";
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
import { supportedLevels, thinkingLabelKey } from "@/renderer/features/chat/thinking";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { ALL_THINKING_LEVELS, type WireFormat } from "@/shared/contracts/common";
import type { ModelCatalogEntry } from "@/shared/contracts/models";
import type { ModelEntry, ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import { catalogPatch, hasManualCapability } from "../model-entry";
import {
  AddButton,
  PanelLoading,
  PanelToolbar,
  SELECT_NONE,
  SettingsDialog,
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
      {hint ? <p className="text-[11px] text-ink-4">{hint}</p> : null}
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

  /** 用目录条目覆盖模型元数据与能力（补丁规则见 model-entry.ts，带单测） */
  const applyCatalogEntry = (key: string, entry: ModelCatalogEntry) => {
    patchModelByKey(key, catalogPatch(entry));
  };

  /**
   * 模型 ID 失焦：只在「用户什么都还没填」时自动匹配，失败静默。
   *
   * 判定含能力项（hasManualCapability）：用户手动开过图片开关或改过档位之后再失焦，
   * 不能被目录结果覆盖掉。
   */
  const handleIdBlur = async (key: string) => {
    const model = draftRef.current.models.find((item) => item.key === key);
    if (!model) return;
    const id = model.id.trim();
    if (id === "") return;
    const untouched = (candidate: DraftModel): boolean =>
      !candidate.name?.trim() &&
      candidate.contextWindow == null &&
      candidate.maxTokens == null &&
      !hasManualCapability(candidate);
    if (!untouched(model)) return;
    try {
      const result = await window.oint.models.lookup(id);
      if (!result.ok || result.match === null) return;
      // 等待期间用户可能已开始填写，确认仍然干净再回填
      const latest = draftRef.current.models.find((item) => item.key === key);
      if (!latest || latest.id.trim() !== id) return;
      if (!untouched(latest)) return;
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
      const result = await window.oint.models.lookup(id);
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
      const result = await window.oint.services.fetchModels({
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
    <SettingsDialog
      title={isNew ? t("settings.addService") : t("settings.editService")}
      description={t("settings.modelServicesDesc")}
      onClose={onClose}
      footer={
        <>
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
        </>
      }
    >
      <div className="space-y-4">
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
            // 与主进程装配保持一致：达到/超过上下文窗口视为误填，不会传递给服务端
            const exceedsContext =
              model.maxTokens !== undefined &&
              model.contextWindow !== undefined &&
              model.maxTokens >= model.contextWindow;
            const note = matchNotes[model.key];
            /**
             * 图片支持：没配过（undefined）时按「不支持」显示 —— 这与 pi-ai 的缺省
             * （只列 text）以及真实请求行为一致，不假装支持。
             */
            const imageEnabled = model.acceptsImages ?? false;
            /**
             * 思考档位：列出的与勾选的都必须与「内核真的会发什么」一致。
             *
             * supportedLevels 里 `reasoning !== true → 只有关闭`，所以即便配置里残留
             * ["off","high"] 也只会显示「关闭」—— 与输入框 chip 的列表严格同源。
             */
            const levelOptions = supportedLevels(model);
            const levelValue = (model.thinkingLevels ?? levelOptions).filter((level) =>
              levelOptions.includes(level),
            );
            const canRestore =
              model.acceptsImages !== undefined || model.thinkingLevels !== undefined;
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
                  <p className="text-[11px] text-ink-4">{t("settings.maxTokensHint")}</p>
                )}
                <div className="flex flex-wrap items-center gap-4">
                  <span className="flex items-center gap-1.5 text-xs text-ink-3">
                    <Switch
                      size="sm"
                      aria-label={t("settings.reasoning")}
                      checked={model.reasoning ?? false}
                      onCheckedChange={(checked) => patchModel(index, { reasoning: checked })}
                    />
                    {t("settings.reasoning")}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-3">
                    <Switch
                      size="sm"
                      aria-label={t("settings.inputImage")}
                      checked={imageEnabled}
                      onCheckedChange={(checked) => patchModel(index, { acceptsImages: checked })}
                    />
                    {t("settings.inputImage")}
                  </span>
                </div>
                {/*
                    思考档位多选：默认勾选「这个模型支持哪些」，用户可改。
                    形状取自 elements/reasoning-effort 的分段控件（那里是单选，这里是多选）。
                  */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-3">{t("settings.thinkingLevels")}</span>
                    {canRestore ? (
                      <button
                        type="button"
                        className="text-[11px] text-ink-4 underline underline-offset-2 hover:text-ink-2"
                        onClick={() =>
                          patchModel(index, {
                            acceptsImages: undefined,
                            thinkingLevels: undefined,
                          })
                        }
                      >
                        {t("settings.restoreCatalogValues")}
                      </button>
                    ) : null}
                  </div>
                  <div className={cn(field, "flex gap-0.5 rounded-full p-0.5")}>
                    {ALL_THINKING_LEVELS.map((value) => {
                      const active = levelValue.includes(value);
                      // 模型实际用不上的档位（例如非推理模型的全部非 off 档）不给点：
                      // 点了会被 chip 与主进程双双忽略，看起来像「点了没反应」
                      const selectable = levelOptions.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active}
                          disabled={!selectable}
                          className={cn(
                            "flex-1 rounded-full py-1 text-center text-xs font-medium whitespace-nowrap outline-none",
                            "transition-[background-color,color,scale] duration-150 focus-visible:ring-1 focus-visible:ring-foreground/20 active:scale-[0.97] motion-reduce:transition-none",
                            !selectable && "cursor-not-allowed opacity-30",
                            selectable && active
                              ? "bg-background text-foreground"
                              : selectable
                                ? "text-ink-4 hover:bg-background/60"
                                : "text-ink-4",
                          )}
                          onClick={() => {
                            // 至少留一档：全不勾等于「没有可选档位」，chip 会空成一片
                            const next = active
                              ? levelValue.filter((item) => item !== value)
                              : ALL_THINKING_LEVELS.filter(
                                  (item) => item === value || levelValue.includes(item),
                                );
                            if (next.length === 0) return;
                            patchModel(index, { thinkingLevels: [...next] });
                          }}
                        >
                          {t(thinkingLabelKey(value))}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {note ? (
                  <p
                    className={cn(
                      "text-[11px]",
                      note.tone === "error" ? "text-destructive" : "text-ink-4",
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
                fetch.status === "error" ? "text-destructive" : "text-ink-3",
              )}
            >
              {fetch.status === "loading" ? t("common.loading") : fetch.message}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsDialog>
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
    // 被删服务若被默认模型引用，一并清空避免悬空引用
    if (settings.defaultModel?.serviceId === service.id) patch.defaultModel = null;
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
      {/* 分类名已由模态的大标题给出（「模型服务」），工具栏只放范围说明与添加入口 */}
      <PanelToolbar
        action={<AddButton label={t("settings.addService")} onClick={() => setDraft(toDraft())} />}
      >
        <p className="min-w-0 flex-1 text-xs text-ink-3">{t("settings.modelServicesDesc")}</p>
      </PanelToolbar>

      {settings.services.length === 0 ? (
        <div className="rounded-xl border border-border/60 p-6 text-center">
          <p className="text-[13.5px] font-medium">{t("settings.noServices")}</p>
          <p className="mt-1 text-xs text-ink-3">{t("settings.noServicesHint")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {settings.services.map((service) => (
            <div
              key={service.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3 transition-colors hover:bg-foreground/[0.03]"
            >
              {/* 整块信息区就是查看/编辑入口：点击打开与新增同一个弹窗组件 */}
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => setDraft(toDraft(service))}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{service.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(mono, "border-border/60 px-1.5 text-ink-3")}
                  >
                    {service.wireFormat === "openai-completions" ? "completions" : "responses"}
                  </Badge>
                </div>
                <p className={cn(typePackage, "mt-1 truncate text-ink-4")} title={service.baseUrl}>
                  {service.baseUrl}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {t("settings.models")} · {service.models.length}
                </p>
              </button>
              <div className="flex shrink-0 items-center gap-1">
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
