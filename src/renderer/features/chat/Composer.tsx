import type { Attachment } from "@assistant-ui/react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  FileText,
  ListOrdered,
  Pencil,
  Plus,
  Square,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextDisplayRing } from "@/renderer/components/assistant-ui/elements/context-display";
import {
  collapsePanel,
  field,
  fieldInteractive,
  floating,
  ghostButton,
  inkButton,
  mono,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import { typeEyebrow, typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
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
import type {
  ChatMessage,
  ChatMessageUsage,
  ModelEntry,
  PermissionMode,
  QueuedMessage,
  ThinkingLevel,
} from "@/shared/contracts";

/** 队列面板默认展示的条数，超出以 +N 表示 */
const QUEUE_PREVIEW = 3;
/** 稳定空引用：避免 zustand selector 每次返回新数组导致多余渲染 */
const EMPTY_QUEUE: QueuedMessage[] = [];

/** 模型未配上下文窗口时的缺省值，与主进程 providers.ts 的 DEFAULT_CONTEXT_WINDOW 对齐 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 本次会话的上下文用量：取最后一条带 usage 的助手消息。
 * 返回的是消息里那个 usage 对象自身——流式期间文本增量只会替换 parts，
 * usage 的引用不变，zustand 的 Object.is 比较因此不会让 Composer 跟着每个 token 重渲染。
 */
function selectSessionUsage(state: {
  activeSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
}): ChatMessageUsage | null {
  const { activeSessionId } = state;
  if (activeSessionId === null) return null;
  const messages = state.messagesBySession[activeSessionId];
  if (messages === undefined) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.usage !== undefined) return message.usage;
  }
  return null;
}

/** chip 触发键：形状抄自 elements/composer.tsx 的 ComposerModelTrigger，三个 chip 共用 */
const chipTrigger = cn(
  "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-foreground outline-none",
  "transition-colors hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]",
  "focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none",
);

/** 浮层菜单面板：Elements 的 floating 面（16 圆角 + 1.5 内边距） */
const menuPanel = cn(floating, "rounded-2xl p-1.5");

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

/** 单选行：形状取自 ComposerMenuItem，选中态用 fieldInteractive 底 + 墨色勾（取自 model-picker） */
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
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-start text-[13.5px] outline-none transition-colors",
        "focus-visible:ring-1 focus-visible:ring-foreground/20",
        selected ? fieldInteractive : "hover:bg-foreground/[0.04]",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      <span className="flex w-4 shrink-0 justify-end">
        {selected && (
          <Check className="fade-in zoom-in-90 animate-in size-3.5 text-foreground/70 duration-200" />
        )}
      </span>
    </button>
  );
}

/** 附件缩略图：图片用 object URL 预览，其余用文件图标；移除走 composer scope 的 remove */
function AttachmentThumb({ attachment }: { attachment: Attachment }) {
  const { t } = useTranslation();
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
      <div
        className={cn(
          field,
          "flex size-14 items-center justify-center overflow-hidden rounded-[14px]",
        )}
      >
        {attachment.type === "image" && url !== null ? (
          <img src={url} alt={attachment.name} className="size-full object-cover" />
        ) : (
          <FileText className="size-5 text-foreground/40" />
        )}
      </div>
      <TooltipIconButton
        tooltip={t("chat.removeAttachment")}
        type="button"
        onClick={() => void composer.attachment({ id: attachment.id }).remove()}
        className="absolute -end-1.5 -top-1.5 size-4 rounded-full border border-border bg-background p-0 [&_svg]:size-3"
      >
        <X />
      </TooltipIconButton>
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
        <button
          type="button"
          className={chipTrigger}
          aria-expanded={open}
          aria-label={t("settings.permissionMode")}
        >
          <span>{t(current.labelKey)}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-56")}>
        <p className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>{t("settings.permissionMode")}</p>
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

interface ModelGroup {
  serviceId: string;
  serviceName: string;
  items: ModelOption[];
}

/** 按服务分组：服务名做菜单眉题，模型 id 留在行内（services 顺序即分组顺序） */
function groupModels(options: ModelOption[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last !== undefined && last.serviceId === option.serviceId) {
      last.items.push(option);
    } else {
      groups.push({
        serviceId: option.serviceId,
        serviceName: option.serviceName,
        items: [option],
      });
    }
  }
  return groups;
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
        <button
          type="button"
          className={chipTrigger}
          aria-expanded={open}
          aria-label={t("chat.model")}
        >
          <Bot className="size-3.5 opacity-70" />
          <span className={cn(typePackage, "max-w-32 truncate")}>{label}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-80")}>
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-[13.5px] text-foreground/45">{t("settings.noServices")}</p>
        ) : (
          <div className="app-scrollbar max-h-64 overflow-y-auto">
            {groupModels(options).map((group) => (
              <div key={group.serviceId} className="flex flex-col">
                <p className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>{group.serviceName}</p>
                {group.items.map((option) => {
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
                      <span className="min-w-0 flex-1 truncate">
                        {option.model.name ?? option.model.id}
                      </span>
                      {/* 未填显示名时行内只剩同一个 id，重复一遍没有信息量 */}
                      {option.model.name ? (
                        <span className={cn(typePackage, "shrink-0 text-foreground/40")}>
                          {option.model.id}
                        </span>
                      ) : null}
                    </PickerItem>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 思考等级 chip：五档单选，写回 settings.thinkingLevel；分段控件的形状取自 reasoning-effort */
function ThinkingChip({ level }: { level: ThinkingLevel }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const current = THINKING_LEVELS.find((item) => item.value === level) ?? THINKING_LEVELS[3];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={chipTrigger}
          aria-expanded={open}
          aria-label={t("chat.thinkingLevel")}
        >
          <Brain className="size-3.5 opacity-70" />
          <span>{t(current.labelKey)}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-72 p-3")}>
        <p className={cn(typeEyebrow, "pb-2")}>{t("chat.thinkingLevel")}</p>
        <div className={cn(field, "flex gap-0.5 rounded-full p-0.5")}>
          {THINKING_LEVELS.map((item) => {
            const active = item.value === level;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setOpen(false);
                  void update({ thinkingLevel: item.value });
                }}
                className={cn(
                  "flex-1 rounded-full py-1 text-center text-xs font-medium whitespace-nowrap outline-none",
                  "transition-[background-color,color,scale] duration-150 focus-visible:ring-1 focus-visible:ring-foreground/20 active:scale-[0.97] motion-reduce:transition-none",
                  active
                    ? "bg-background text-foreground"
                    : "text-foreground hover:bg-background/60",
                )}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 队列面板（B4 ⑤）：可折叠只读列表；编辑/移除 API 缺失，编辑以禁用态 + 说明呈现 */
function QueuePanel({ items }: { items: QueuedMessage[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border/60">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-start outline-none transition-colors",
          "hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/20",
          typeEyebrow,
        )}
      >
        <ListOrdered className="size-3.5 shrink-0" />
        <span>{t("chat.queueCount", { count: items.length })}</span>
        <ChevronDown
          className={cn(
            "ms-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <ol className="flex flex-col gap-0.5 px-2.5 pb-2">
          {items.slice(0, QUEUE_PREVIEW).map((item, index) => (
            <li key={item.id} className="flex items-center gap-2">
              <span className={cn(typeEyebrow, "w-3 shrink-0 text-end tabular-nums")}>
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground/60">
                {item.text}
              </span>
              {item.mode === "steer" && (
                <span
                  className={cn(field, mono, "shrink-0 rounded px-1.5 py-px text-foreground/70")}
                >
                  {t("chat.steer")}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* 禁用按钮不触发指针事件，说明挂在包裹的 span 上才不会丢 */}
                  <span className="inline-flex shrink-0">
                    <button
                      type="button"
                      disabled
                      className={cn(ghostButton, "size-5 opacity-40")}
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
            <li className={cn(typeEyebrow, "ps-5")}>+{items.length - QUEUE_PREVIEW}</li>
          )}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Composer（B4）：自绘外壳（--composer-bg 面 + 24px 圆角 + --composer-shadow 抬高）
 * + 附件（选择/拖拽/粘贴）+ 权限/模型/思考 chip + 发送/停止 + 队列面板与队列提示。
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
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessionUsage = useChatStore(selectSessionUsage);

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

  // 发送键左侧的用量环：无 usage（新会话 / 供应商不上报）时组件自身返回 null
  const usageRing = (
    <ContextDisplayRing
      modelContextWindow={currentModel?.model.contextWindow ?? FALLBACK_CONTEXT_WINDOW}
      usage={sessionUsage ?? undefined}
      resetKey={activeSessionId ?? undefined}
      className="h-8"
    />
  );

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
      <ComposerPrimitive.Root
        compact={false}
        className={cn(
          // 面用 Thread 根上声明的 --composer-bg（= --card）：它比页面底色亮一档，
          // 配合 --composer-shadow 才立得起来；暗色沿用 paper 口径的 popover 面。
          "w-full rounded-[24px] border border-border/60 p-2.5 transition-colors",
          "bg-[var(--composer-bg,var(--card))] shadow-[var(--composer-shadow)] dark:bg-popover",
          "focus-within:ring-1 focus-within:ring-foreground/20",
        )}
      >
        <ComposerPrimitive.AttachmentDropzone
          className={cn(
            "-m-2.5 flex flex-col gap-2 rounded-[24px] p-2.5 transition-colors",
            // 拖拽态：Elements 的蓝底 + 虚线边，用 outline 画以免多算一层盒模型
            "data-[dragging=true]:bg-blue-500/[0.04] dark:data-[dragging=true]:bg-blue-500/10",
            "data-[dragging=true]:outline-1 data-[dragging=true]:-outline-offset-1 data-[dragging=true]:outline-dashed data-[dragging=true]:outline-blue-500/40",
          )}
        >
          {queue.length > 0 && <QueuePanel items={queue} />}
          {/* Attachments 渲染的是片段，横向排布靠这层容器；空时不留出 gap */}
          <div className="flex flex-wrap gap-2 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <AttachmentThumb key={attachment.id} attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </div>
          <ComposerPrimitive.Input
            submitMode="enter"
            addAttachmentOnPaste
            placeholder={t("chat.inputPlaceholder")}
            onKeyDown={handleInputKeyDown}
            className={cn(
              "min-h-9 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none",
              "placeholder:text-foreground/35",
            )}
          />
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ComposerPrimitive.AddAttachment
                multiple
                aria-label={t("chat.attachImage")}
                className={cn(
                  ghostButton,
                  "size-8 shrink-0 disabled:pointer-events-none disabled:opacity-30",
                )}
              >
                <Plus className="size-4" />
              </ComposerPrimitive.AddAttachment>
              <PermissionChip mode={permissionMode} />
              <ModelChip options={modelOptions} current={currentModel} />
              <ThinkingChip level={thinkingLevel} />
            </div>
            {/* 运行中文案一律不驻留：底部这行只放控件本身 */}
            <div className="flex shrink-0 items-center gap-1.5">
              {usageRing}
              {running ? (
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  className="size-8 shrink-0 rounded-full"
                  aria-label={t("chat.stop")}
                  onClick={() => void useChatStore.getState().stop()}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <ComposerPrimitive.Send asChild>
                  {/* 空输入时禁用（前景 40% 不透明，B1 ③） */}
                  <button
                    type="button"
                    disabled={!canSend}
                    aria-label={t("chat.send")}
                    className={cn(
                      inkButton,
                      "grid size-8 shrink-0 place-items-center rounded-full disabled:opacity-40",
                    )}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </ComposerPrimitive.Send>
              )}
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </div>
  );
}
