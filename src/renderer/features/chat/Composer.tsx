import type { Attachment } from "@assistant-ui/react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  FileText,
  ImagePlus,
  ListOrdered,
  Pencil,
  Square,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/renderer/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { ModelEntry, PermissionMode, QueuedMessage, ThinkingLevel } from "@/shared/contracts";

const chipClass =
  "flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** 队列面板默认展示的条数，超出以 +N 表示 */
const QUEUE_PREVIEW = 3;
/** 稳定空引用：避免 zustand selector 每次返回新数组导致多余渲染 */
const EMPTY_QUEUE: QueuedMessage[] = [];

const PERMISSION_MODES = [
  { value: "default", labelKey: "chat.permissionDefault" },
  { value: "ai_review", labelKey: "chat.permissionAiReview" },
  { value: "full", labelKey: "chat.permissionFull" },
] as const;

const THINKING_LEVELS = [
  { value: "off", labelKey: "chat.thinkingOff" },
  { value: "minimal", labelKey: "chat.thinkingMinimal" },
  { value: "low", labelKey: "chat.thinkingLow" },
  { value: "medium", labelKey: "chat.thinkingMedium" },
  { value: "high", labelKey: "chat.thinkingHigh" },
] as const;

/** 单选行：品牌点标记当前项（E2 落点严格克制，仅选中项着色） */
function PickerItem({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent",
        selected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", selected ? "bg-brand" : "bg-transparent")}
      />
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
    </button>
  );
}

/** 附件缩略图：document 圆角 + 右上角移除按钮（composer scope 的 remove 方法） */
function AttachmentThumb({ attachment }: { attachment: Attachment }) {
  const composer = useAui().composer;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.file) {
      const objectUrl = URL.createObjectURL(attachment.file);
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    setUrl(null);
  }, [attachment.file]);

  return (
    <div className="relative shrink-0">
      <div className="flex size-14 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted">
        {attachment.type === "image" && url !== null ? (
          <img src={url} alt={attachment.name} className="size-full object-cover" />
        ) : (
          <FileText className="size-5 text-muted-foreground" />
        )}
      </div>
      <button
        type="button"
        onClick={() => void composer.attachment({ id: attachment.id }).remove()}
        className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3" />
        <span className="sr-only">remove</span>
      </button>
    </div>
  );
}

/** 权限模式 chip（B5 〇）：三模式单选，写回 settings.permissionMode */
function PermissionChip({ mode }: { mode: PermissionMode }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const current = PERMISSION_MODES.find((item) => item.value === mode) ?? PERMISSION_MODES[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={chipClass} aria-label={t("settings.permissionMode")}>
          <span>{t(current.labelKey)}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {PERMISSION_MODES.map((item) => (
          <PickerItem
            key={item.value}
            selected={item.value === mode}
            onSelect={() => {
              setOpen(false);
              void update({ permissionMode: item.value });
            }}
          >
            {t(item.labelKey)}
          </PickerItem>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface ModelOption {
  serviceId: string;
  serviceName: string;
  model: ModelEntry;
}

/** 模型 chip：列出所有服务下的全部模型，写回 settings.defaultModel */
function ModelChip({ options, current }: { options: ModelOption[]; current: ModelOption | null }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const label = current !== null ? (current.model.name ?? current.model.id) : t("common.empty");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={chipClass} aria-label={t("chat.model")}>
          <Bot className="size-3.5" />
          <span className="max-w-32 truncate font-mono text-[11px]">{label}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <div className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {t("chat.model")}
        </div>
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("settings.noServices")}
          </div>
        ) : (
          <div className="app-scrollbar max-h-64 overflow-y-auto">
            {options.map((option) => {
              const selected =
                current !== null &&
                option.serviceId === current.serviceId &&
                option.model.id === current.model.id;
              return (
                <PickerItem
                  key={`${option.serviceId}/${option.model.id}`}
                  selected={selected}
                  onSelect={() => {
                    setOpen(false);
                    void update({
                      defaultModel: { serviceId: option.serviceId, modelId: option.model.id },
                    });
                  }}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="truncate">{option.model.name ?? option.model.id}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {option.serviceName}
                    </span>
                  </span>
                </PickerItem>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 思考等级 chip：五档单选，写回 settings.thinkingLevel */
function ThinkingChip({ level }: { level: ThinkingLevel }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const current = THINKING_LEVELS.find((item) => item.value === level) ?? THINKING_LEVELS[3];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={chipClass} aria-label={t("chat.thinkingLevel")}>
          <Brain className="size-3.5" />
          <span>{t(current.labelKey)}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-40 p-1.5">
        {THINKING_LEVELS.map((item) => (
          <PickerItem
            key={item.value}
            selected={item.value === level}
            onSelect={() => {
              setOpen(false);
              void update({ thinkingLevel: item.value });
            }}
          >
            {t(item.labelKey)}
          </PickerItem>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** 队列面板（B4 ⑤）：可折叠只读列表；编辑/移除 API 缺失，编辑以禁用态 + 说明呈现 */
function QueuePanel({ items }: { items: QueuedMessage[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <ListOrdered className="size-3.5 shrink-0" />
        <span>{t("chat.queueCount", { count: items.length })}</span>
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="px-3 pb-1.5">
          {items.slice(0, QUEUE_PREVIEW).map((item, index) => (
            <li key={item.id} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="w-3 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              {item.mode === "steer" && (
                <span className="shrink-0 rounded-sm bg-brand-muted px-1 py-0.5 font-mono text-[10px] text-brand-text">
                  {t("chat.steer")}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0">
                    <button
                      type="button"
                      disabled
                      className="p-0.5 text-muted-foreground opacity-40"
                      aria-label={t("chat.queueEdit")}
                    >
                      <Pencil className="size-3" />
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t("chat.queueEdit")} · {t("common.disabled")}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
          {items.length > QUEUE_PREVIEW && (
            <li className="pl-5 font-mono text-[11px] text-muted-foreground">
              +{items.length - QUEUE_PREVIEW}
            </li>
          )}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Composer（B4）：thread 圆角外壳 + 附件（选择/拖拽/粘贴）+ 权限/模型/思考 chip
 * + 发送/停止 + 队列面板与队列提示。
 * 发送走 ComposerPrimitive.Send（runtime 原生）；运行中 Enter 走 store.queue（见下）。
 * store 状态按会话分片：running / queue 均需以 activeSessionId 读取。
 */
export function Composer() {
  const { t } = useTranslation();
  const aui = useAui();
  const { settings } = useSettingsStore();
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );
  const queue = useChatStore((s) =>
    s.activeSessionId === null ? EMPTY_QUEUE : (s.queueBySession[s.activeSessionId] ?? EMPTY_QUEUE),
  );
  const canSend = useAuiState((s) => s.composer.canSend);

  const permissionMode = settings?.permissionMode ?? "default";
  const thinkingLevel = settings?.thinkingLevel ?? "medium";
  const defaultModel = settings?.defaultModel ?? null;
  const modelOptions: ModelOption[] = (settings?.services ?? []).flatMap((service) =>
    service.models.map((model) => ({
      serviceId: service.id,
      serviceName: service.name,
      model,
    })),
  );
  const currentModel =
    modelOptions.find(
      (option) =>
        option.serviceId === defaultModel?.serviceId && option.model.id === defaultModel.modelId,
    ) ?? null;

  /**
   * 运行中 Enter 排队 / Ctrl(⌘)+Enter 插话（B4 ④）。
   * PolarRuntimeProvider 未声明 capabilities.queue，库内队列路径不可用，
   * 且库在 isRunning && !hasQueue 时会忽略 Enter；这里显式接管：
   * preventDefault 会让库的按键处理器跳过，避免与发送双触发。
   */
  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!running) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const text = aui.composer.getState().text.trim();
    if (text.length === 0) return;
    const mode = event.ctrlKey || event.metaKey ? "steer" : "followUp";
    void useChatStore.getState().queue(text, mode);
    // 排队内容只带文本；附件保留在 Composer 中
    aui.composer.setText("");
  };

  return (
    <div className="px-4 pb-4">
      <div className="rounded-thread border border-border bg-card">
        <ComposerPrimitive.Root
          compact={false}
          className="rounded-thread transition-shadow focus-within:ring-1 focus-within:ring-brand-border"
        >
          <ComposerPrimitive.AttachmentDropzone className="rounded-thread transition-colors data-[dragging=true]:bg-accent">
            {queue.length > 0 && <QueuePanel items={queue} />}
            <div className="px-3 pt-3">
              <div className="flex flex-wrap gap-2 pb-1">
                <ComposerPrimitive.Attachments>
                  {({ attachment }) => (
                    <AttachmentThumb key={attachment.id} attachment={attachment} />
                  )}
                </ComposerPrimitive.Attachments>
              </div>
              <ComposerPrimitive.Input
                submitMode="enter"
                addAttachmentOnPaste
                placeholder={t("chat.inputPlaceholder")}
                onKeyDown={handleInputKeyDown}
                className="min-h-9 w-full resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
              />
              {running && (
                <p className="pb-0.5 text-[11px] text-muted-foreground">{t("chat.queueHint")}</p>
              )}
            </div>
            <div className="flex items-center gap-1 px-2 pt-1 pb-2">
              <ComposerPrimitive.AddAttachment multiple>
                <span className="flex items-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <ImagePlus className="size-4" />
                  <span className="sr-only">{t("chat.attachImage")}</span>
                </span>
              </ComposerPrimitive.AddAttachment>
              <PermissionChip mode={permissionMode} />
              <ModelChip options={modelOptions} current={currentModel} />
              <ThinkingChip level={thinkingLevel} />
              <div className="flex-1" />
              {running ? (
                <>
                  <span className="hidden max-w-56 truncate text-[11px] text-muted-foreground md:inline">
                    {t("approval.stopAfterStep")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void useChatStore.getState().stop()}
                    className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
                  >
                    <Square className="size-3.5" />
                    {t("chat.stop")}
                  </button>
                </>
              ) : (
                <ComposerPrimitive.Send asChild>
                  {/* 空输入时禁用（前景 40% 不透明，B1 ③） */}
                  <button
                    type="button"
                    disabled={!canSend}
                    className="rounded-md bg-brand p-2 text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">{t("chat.send")}</span>
                  </button>
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.AttachmentDropzone>
        </ComposerPrimitive.Root>
      </div>
    </div>
  );
}
