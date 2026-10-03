import type { Attachment } from "@assistant-ui/react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  FileText,
  Loader2,
  Plus,
  Square,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMeter } from "@/renderer/components/assistant-ui/elements/context-meter";
import {
  field,
  ghostButton,
  inkButton,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import { typeEyebrow, typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/renderer/components/ui/popover";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type {
  AgentMode,
  ChatMessage,
  ChatMessageUsage,
  ChatSendOptions,
  ModelEntry,
  ModelRef,
  PermissionMode,
  QueuedMessage,
  SessionModelFailure,
  SetSessionModelResult,
  SetSessionModeResult,
} from "@/shared/contracts";
import { resolveEffectiveModelRef } from "@/shared/model-ref";
import { ComposerDock, GoalDock, PlanDock, QueueDock, TodoDock } from "./ComposerDock";
import { commandSpec, unavailableReason } from "./commands";
import { chipTrigger, menuPanel, PickerItem } from "./composer-chrome";
import { ComposerContextRow } from "./composer-context";
import { SlashCommandMenu } from "./SlashCommandMenu";
import {
  dispatchSlashInput,
  filterSlashCommands,
  insertSlashCommand,
  optionKey,
  orderSlashCommands,
  type SlashCommand,
  slashQuery,
} from "./slash-commands";
import { type ResolvedThinking, resolveThinking, thinkingLabelKey } from "./thinking";
import { useActiveWorkingDir, useSlashCommands } from "./use-slash-commands";

/** 稳定空引用：避免 zustand selector 每次返回新数组导致多余渲染 */
const EMPTY_QUEUE: QueuedMessage[] = [];

/**
 * 提示侧压力：未缓存输入 + 缓存读取 + 缓存写入（不含输出）。
 *
 * 与 DSH token-meter 的 pressureFrom 同一口径：输出 token 不在「上下文占用」里，
 * 它是这一轮产生的量，不是下一次请求要带上的量。
 */
function pressureTokens(usage: ChatMessageUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * 模型未配上下文窗口时的缺省值，与主进程 providers.ts 的 DEFAULT_CONTEXT_WINDOW 对齐
 */
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

/** 权限三模式：真实生效 —— default 弹卡询问 / ai_review 交 AI 审批（模型＝默认路由模型）/ full 全部放行 */
const PERMISSION_MODES = [
  { value: "default", labelKey: "chat.permissionDefault" },
  { value: "ai_review", labelKey: "chat.permissionAiReview" },
  { value: "full", labelKey: "chat.permissionFull" },
] as const;

/**
 * 会话模式：默认、编排。
 *
 * 顺序上标准在前：它是默认值，也是「不知道该选哪个」时的正确选择。
 *
 * `descKey` 说明各模式的分工。
 */
const AGENT_MODE_OPTIONS = [
  {
    value: "standard",
    labelKey: "chat.agentModeStandard",
    descKey: "chat.agentModeStandardDesc",
  },
  {
    value: "orchestrate",
    labelKey: "chat.agentModeOrchestrate",
    descKey: "chat.agentModeOrchestrateDesc",
  },
] as const;

/**
 * 附件缩略图：图片用 object URL 预览，其余用文件图标；移除走 composer scope 的 remove。
 *
 * 三种状态都要画出来，因为**库把探测失败吞掉了**：`ComposerAddAttachment` 里是
 * `try { await addAttachment(file) } catch {}`，不自己读 `status` 的话，一个读不动的
 * 文件在界面上与正常附件长得一模一样 —— 用户只会觉得「选了没用」。
 * （适配器的探测过程本身也在这里体现：`running` 就是「正在抽帧 / 降采样」。）
 */
function AttachmentThumb({ attachment }: { attachment: Attachment }) {
  const { t } = useTranslation();
  const composer = useAui().composer;
  const [url, setUrl] = useState<string | null>(null);
  const failed = attachment.status.type === "incomplete" && attachment.status.reason === "error";
  const busy = attachment.status.type === "running";
  const message =
    attachment.status.type === "incomplete" && attachment.status.reason === "error"
      ? (attachment.status.message ?? "")
      : "";

  useEffect(() => {
    if (attachment.file) {
      const objectUrl = URL.createObjectURL(attachment.file);
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    setUrl(null);
  }, [attachment.file]);

  return (
    <div className="relative shrink-0" title={failed ? message : attachment.name}>
      <div
        className={cn(
          field,
          "flex size-14 items-center justify-center overflow-hidden rounded-[14px]",
          failed && "border-destructive/60",
        )}
      >
        {failed ? (
          <AlertTriangle className="text-destructive size-5" />
        ) : attachment.type === "image" && url !== null ? (
          <img src={url} alt={attachment.name} className="size-full object-cover" />
        ) : (
          <FileText className="size-5 text-ink-4" />
        )}
        {busy && (
          <div className="bg-background/60 absolute inset-0 grid place-items-center backdrop-blur-[2px]">
            <Loader2 className="text-ink-3 size-4 animate-spin" />
          </div>
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

/** 权限模式 chip：三模式单选，写回 settings.permissionMode（主进程权限门据此放行/审批） */
function PermissionChip({ mode }: { mode: PermissionMode }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = PERMISSION_MODES.find((item) => item.value === mode) ?? PERMISSION_MODES[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={chipTrigger}
          aria-expanded={open}
          aria-label={t("chat.permissionMode")}
        >
          <span>{t(current.labelKey)}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-56")}>
        <p className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>{t("chat.permissionMode")}</p>
        {PERMISSION_MODES.map((item) => (
          <PickerItem
            key={item.value}
            selected={item.value === mode}
            disabled={pending}
            onSelect={() => {
              setPending(true);
              setFailed(false);
              void update({ permissionMode: item.value })
                .then((ok) => {
                  if (ok) setOpen(false);
                  else setFailed(true);
                })
                .finally(() => setPending(false));
            }}
          >
            {t(item.labelKey)}
          </PickerItem>
        ))}
        {failed && (
          <p role="alert" className="px-2.5 text-xs text-destructive">
            {t("chat.settingsSaveFailed")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 会话模式 chip：按会话保存，运行结束后下一次发送生效。
 *
 * 与权限 chip 的**关键差别：这个写的是会话，不是设置**。
 * - 权限模式是「我多信任它」的全局信任级别 → `settings.permissionMode`；
 * - 智能体模式改的是「我在跟谁说话」→ 每个会话可以不同（`sessions:set-mode` 写会话索引），
 *   `settings.agentMode` 只作为**新会话的默认值**。
 *
 * `mode` 是**已经解析好的生效值**（会话绑定 ?? 设置默认），由调用方算出来 ——
 * chip 不自己回落，否则「会话没绑定」与「绑定了默认值」两种情况在界面上分不出来。
 *
 * 运行中可以保存下次使用的模式；当前运行仍保留原模式及权限边界。
 * 当前运行结束后，下一次发送使用新模式。
 * 运行中额外给一句说明（`running` 为 true 时显示），否则用户会疑惑「现在切了到底算不算」。
 */
function AgentModeChip({
  mode,
  bound,
  disabled,
  running,
  onSelect,
}: {
  mode: AgentMode;
  bound: AgentMode | null;
  disabled: boolean;
  /** 本会话正在运行：此时切换会在**下一轮**生效，菜单里说明这一点 */
  running: boolean;
  onSelect: (mode: AgentMode) => Promise<SetSessionModeResult>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const current = AGENT_MODE_OPTIONS.find((item) => item.value === mode) ?? AGENT_MODE_OPTIONS[0];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setFailed(false);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(chipTrigger, disabled && "cursor-not-allowed opacity-40")}
          aria-expanded={open}
          aria-label={t("chat.agentMode")}
          disabled={disabled}
        >
          <span>{t(current.labelKey)}</span>
          {running && (
            <span className="text-[10px] text-ink-4">{t("chat.agentModePendingTurn")}</span>
          )}
          {/*
            会话自己指定过（不跟随默认）时留一个记号，与思考 chip 的 clamped 记号同一手法：
            让「我改过这个会话」这件事在收起状态也看得见。
          */}
          {bound !== null && <span className="text-ink-4">·</span>}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-72")}>
        <p className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>{t("chat.agentMode")}</p>
        {AGENT_MODE_OPTIONS.map((item) => (
          <PickerItem
            key={item.value}
            selected={item.value === mode}
            disabled={pending}
            onSelect={() => {
              if (pendingRef.current) return;
              pendingRef.current = true;
              setPending(true);
              setFailed(false);
              void onSelect(item.value)
                .then((result) => {
                  if (result.ok) setOpen(false);
                  else setFailed(true);
                })
                .catch(() => setFailed(true))
                .finally(() => {
                  pendingRef.current = false;
                  setPending(false);
                });
            }}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{t(item.labelKey)}</span>
              {/* 名字说不清差别，所以每个选项都带一句它到底改了什么 */}
              <span className="text-ink-3 text-[11.5px] leading-snug">{t(item.descKey)}</span>
            </span>
          </PickerItem>
        ))}
        {failed ? (
          <p className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-destructive">
            {t("chat.agentModeRunning")}
          </p>
        ) : running ? (
          // 运行中切换是允许的，但要说清生效时机，否则用户会以为「现在就该换」
          <p className="text-ink-3 px-2.5 pt-1 pb-1.5 text-[11.5px]">
            {t("chat.agentModeNextTurn")}
          </p>
        ) : null}
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

/**
 * 模型 chip：**直接选一个模型，即切换当前会话使用的模型**（不再改全局默认）。
 *
 * 分工：设置 → 服务里的「默认模型」决定新会话用什么，这里决定**这个会话**用什么。
 * 菜单只列可选模型，没有「跟随默认」这类额外选项 —— 选中哪条就是哪条；模型的选择是
 * 会话级的，之后改设置里的默认模型不会影响已经选过的会话。
 *
 * 切换走主进程的 setModel：热改 lane 配置，上下文完整保留、下一条消息即生效。
 * 失败（正在运行 / 目标模型不存在）时**不关菜单**，把原因留在菜单里说明。
 */
function ModelChip({
  options,
  current,
  bound,
  onSelect,
}: {
  options: ModelOption[];
  /** 这个会话实际在用的模型（会话指定过就是它，否则是默认模型） */
  current: ModelOption | null;
  /** 会话自己指定过的模型；null = 还没指定，跟着设置里的默认模型走 */
  bound: ModelRef | null;
  onSelect: (model: ModelRef) => Promise<SetSessionModelResult>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<SessionModelFailure | "save-failed" | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const label = current !== null ? (current.model.name ?? current.model.id) : t("common.empty");

  const choose = async (model: ModelRef) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    let result: SetSessionModelResult;
    try {
      result = await onSelect(model);
    } catch {
      // IPC 本身失败（主进程异常 / 设置读不出来）时同样要给出说明：
      // 只 `void` 出去会变成 unhandled rejection，用户看到的是「点了没反应」
      setFailure("save-failed");
      return;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
    if (result.ok) {
      setFailure(null);
      setOpen(false);
      return;
    }
    // 失败时留着菜单：用户正看着它，关掉就看不到原因了
    setFailure(result.reason);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailure(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={chipTrigger}
          aria-expanded={open}
          aria-label={t("chat.model")}
        >
          <Bot className="size-3.5 opacity-70" />
          <span title={label} className={cn(typePackage, "max-w-32 truncate")}>
            {label}
          </span>
          {/* 本会话单独指定过模型时留个记号：此时它不再跟着设置里的默认模型走 */}
          {bound !== null && <span className="text-ink-4">·</span>}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-80")}>
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-[13.5px] text-ink-3">{t("settings.noServices")}</p>
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
                      disabled={pending}
                      onSelect={() =>
                        void choose({
                          serviceId: option.serviceId,
                          modelId: option.model.id,
                        })
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {option.model.name ?? option.model.id}
                      </span>
                      {/* 未填显示名时行内只剩同一个 id，重复一遍没有信息量 */}
                      {option.model.name ? (
                        <span className={cn(typePackage, "shrink-0 text-ink-4")}>
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
        {failure !== null && (
          <p className="text-destructive px-2.5 pt-2 pb-1 text-[11px] leading-relaxed">
            {t(
              failure === "save-failed"
                ? "chat.modelSaveFailed"
                : failure === "running"
                  ? "chat.modelSwitchRunning"
                  : "chat.modelUnavailable",
            )}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 思考等级 chip：**只列当前模型支持的档位**，写回 settings.thinkingLevel。
 *
 * 列表来自 resolveThinking（口径与主进程请求阶段的 clamp 一致）：模型不支持设置里的档位时
 * 就近取一档，并在菜单里说明一声 —— 否则用户会以为设置没生效。
 * 分段控件的形状取自 reasoning-effort。
 */
function ThinkingChip({ resolved }: { resolved: ResolvedThinking }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  const { levels, level, clamped } = resolved;

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
          <span>{t(thinkingLabelKey(level))}</span>
          {/* 被就近调整过时在 chip 上留个记号，点开有说明 */}
          {clamped && <span className="text-ink-4">·</span>}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(menuPanel, "w-72 p-3")}>
        <p className={cn(typeEyebrow, "pb-2")}>{t("chat.thinkingLevel")}</p>
        <div className={cn(field, "flex gap-0.5 rounded-full p-0.5")}>
          {levels.map((value) => {
            const active = value === level;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setOpen(false);
                  void update({ thinkingLevel: value });
                }}
                className={cn(
                  "flex-1 rounded-full py-1 text-center text-xs font-medium whitespace-nowrap outline-none",
                  "transition-[background-color,color,scale] duration-150 focus-visible:ring-1 focus-visible:ring-foreground/20 active:scale-[0.97] motion-reduce:transition-none",
                  active
                    ? "bg-background text-foreground"
                    : "text-foreground hover:bg-background/60",
                )}
              >
                {t(thinkingLabelKey(value))}
              </button>
            );
          })}
        </div>
        {clamped && (
          <p className="text-ink-3 pt-2 text-[11px] leading-relaxed">
            {t("chat.thinkingClamped", {
              wanted: t(thinkingLabelKey(resolved.wanted)),
              used: t(thinkingLabelKey(level)),
            })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 输入框最多长到几行，再往上就**内部滚动**。
 *
 * 上限是必须的：输入框浮在消息区之上（对话中它落在 sticky 底栏里），它长多高直接从
 * 可见的对话里扣 —— 没有上限时，一段长提示词能把上下文压到只剩一两行。
 * 10 行是「还看得见上面在说什么」与「不用为了一段话去开外部编辑器」之间的折中。
 *
 * 用**行数**而不是像素：这个上限交给库（react-textarea-autosize 的 maxRows），
 * 它按输入框真实的行高算出像素上限并写内联高度。写死像素会在字体或字号变化时对不上
 * （行高由 text-sm/leading-relaxed 决定，而这两者都可能被调）。
 */
const COMPOSER_MAX_ROWS = 10;

/**
 * 输入框的两种摆法。
 *
 * - `docked`（默认）：对话进行中的样子 —— 贴窗口底部、跟着消息走、上方挂停靠区；
 * - `hero`：**新会话页**的样子 —— 居中、卡片分内外两层（外层放上下文行，内层是输入面），
 *   不挂停靠区（那一刻既没有任务清单也没有待发送队列）。
 *
 * 两种摆法共用同一个组件而不是各写一份：附件、斜杠菜单、瞬时提示、发送与排队的
 * 那套行为（`handleInputKeyDown` 一整段）与摆法无关，复制一份必然分叉。
 */
export type ComposerVariant = "docked" | "hero";

/**
 * Composer：自绘外壳（--composer-bg 面 + 24px 圆角 + --composer-shadow 抬高）
 * + 附件（选择/拖拽/粘贴）+ 权限/模型/思考 chip + 发送/停止。
 * 发送走 ComposerPrimitive.Send（runtime 原生）；运行中 Enter 走 store.queue（见下）。
 * store 状态按会话分片：running / queue 均需以 activeSessionId 读取。
 *
 * 输入框**上方**是停靠区（ComposerDock）：任务清单与待发送队列贴在外壳之外，
 * 与它共用一个宽度、圆角只在顶部 —— 见该文件顶部对位置与形态的说明。
 * hero 摆法不挂停靠区，改挂上下文行（项目 chip，见 composer-context）。
 */
export function Composer({ variant = "docked" }: { variant?: ComposerVariant } = {}) {
  const hero = variant === "hero";
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
  /** 待发送的附件数：运行中的排队只带文本，有附件时不能排（见 handleInputKeyDown） */
  const attachmentCount = useAuiState((s) => s.composer.attachments.length);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  /**
   * 这个会话是否正在压缩上下文（手动或自动）。
   *
   * 与 `running` 分开读：压缩不是一轮 run，`runningBySession` 不包含它 ——
   * 而「压缩中不能发送」是必须的（压缩占着 lane，发出去的消息会把压缩顶掉，
   * 见主进程 abortStaleOperation 的说明）。
   */
  const compacting = useChatStore(
    (s) => s.activeSessionId !== null && s.compactions[s.activeSessionId]?.phase === "running",
  );
  /** 输入框上方那一行瞬时提示（指令被拒 / 执行结果）；由 ui-store 承载，见 notifyComposer */
  const composerNotice = useUiStore((s) => s.composerNotice);
  const dismissComposerNotice = useUiStore((s) => s.dismissComposerNotice);
  const sessionUsage = useChatStore(selectSessionUsage);
  /** 主进程推来的三段分解；没有（尚未跑过一轮）时环退化为单段总占用 */
  const sessionBreakdown = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.breakdownBySession[s.activeSessionId],
  );

  const permissionMode = settings?.permissionMode ?? "default";
  const thinkingLevel = settings?.thinkingLevel ?? "medium";
  const modelOptions: ModelOption[] = (settings?.services ?? []).flatMap((service) =>
    service.models.map((model) => ({
      serviceId: service.id,
      serviceName: service.name,
      model,
    })),
  );
  /**
   * 这个会话自己绑定的模型（null = 跟随默认），以及据此算出的**实际生效模型**。
   *
   * 必须用会话级绑定而不是 settings.defaultModel：主进程发请求用的就是这个判定
   * （shared/model-ref.ts 的 resolveEffectiveModelRef），chip 标签、用量环、思考档位
   * 三处都跟着它走，才不会出现「界面按 A 显示、请求发给 B」。
   */
  const activeSession = useChatStore((s) =>
    s.activeSessionId === null
      ? undefined
      : s.sessions.find((session) => session.id === s.activeSessionId),
  );
  const boundModel = activeSession?.model ?? null;
  const effectiveModel = settings === null ? null : resolveEffectiveModelRef(settings, boundModel);
  /**
   * 会话绑定的模式（null = 没绑定过）与**生效**模式。
   *
   * 与模型那一对同构，理由也一样：主进程装配系统提示时用的就是这个判定
   * （runtime 的 composeMainPrompt：`readAgentMode(id) ?? settings.agentMode`），
   * chip 跟着它走才不会出现「界面显示标准、请求按编排发」。
   *
   * 两件事都要算出来：`bound` 用来在 chip 上留「我改过这个会话」的记号，
   * `effective` 用来显示当前生效的是哪个。
   */
  const boundAgentMode = activeSession?.agentMode ?? null;
  const effectiveAgentMode: AgentMode = boundAgentMode ?? settings?.agentMode ?? "standard";
  const currentModel =
    modelOptions.find(
      (option) =>
        option.serviceId === effectiveModel?.serviceId &&
        option.model.id === effectiveModel.modelId,
    ) ?? null;
  /**
   * 思考档位的最终结果：设置里的档位按**当前会话实际使用的模型**就近降级。
   *
   * 提到组件层算而不是塞进 chip：chip 只负责画，而「实际生效哪一档」是与发送同源的事实
   * （主进程 applyThinkingLevel 用的也是同一个 clamp 规则）。
   */
  const thinking = resolveThinking(thinkingLevel, currentModel?.model);

  // 发送键左侧的上下文用量环：无 usage（新会话 / 供应商不上报）时组件自身返回 null
  const usageRing = (
    <ContextMeter
      usedTokens={sessionUsage === null ? 0 : pressureTokens(sessionUsage)}
      contextWindow={currentModel?.model.contextWindow ?? FALLBACK_CONTEXT_WINDOW}
      breakdown={sessionBreakdown}
      resetKey={activeSessionId ?? undefined}
    />
  );

  /**
   * 斜杠命令：清单来自技能与提示模板（跟着当前会话的工作目录），菜单贴在 composer 上沿。
   *
   * 文本从 aui 的 composer 状态读（ComposerPrimitive.Input 自己维护那份），不额外存一份
   * —— 两份状态在输入法合成、粘贴、撤销这些路径上迟早会错开。
   */
  const composerText = useAuiState((s) => s.composer.text);
  const workingDir = useActiveWorkingDir();
  const slashCommands = useSlashCommands(workingDir);
  /**
   * 菜单与输入框共用的 listbox id。必须在这里生成：输入框要用 aria-controls /
   * aria-activedescendant 指过去，而菜单只在斜杠模式下才挂载 —— 交给菜单自己 useId，
   * 菜单收起时那两个属性就指不到东西了。
   */
  const slashListId = useId();
  /**
   * 当前高亮的行。**可空**：Escape 收起后就是 null，而菜单本身还在（否则下一次输入会把
   * 菜单整块重新打开，看起来像没关掉）。标识是 kind + name —— 同名技能/模板是两条不同的
   * 行，只记 name 会让两条同时高亮、而且模板那条永远选不中。
   */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /**
   * 用户按 Escape 时那次查询词。菜单保持收起，直到查询词变了（又敲了字符）才重新打开 ——
   * 只记「关过」而不记「关的是哪个查询」，用户敲下一个字母时菜单就会自己跳回来。
   */
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const slash = useMemo(() => {
    const query = slashQuery(composerText);
    if (query === null) return null;
    if (query === dismissedQuery) return null;
    // 名称与某条命令全等 → 这条已经选定，不必再烦用户（再按一次 Enter 直接发送）。
    // 比的是 trim 后的：菜单补全留下的是 `/名称 `（尾随空格），不 trim 就永远匹配不上，
    // 菜单会在补全之后赖着不走。大小写不敏感，与菜单的过滤口径一致。
    const name = composerText.slice(1).trim().toLowerCase();
    if (slashCommands.some((command) => command.name.toLowerCase() === name)) return null;
    return { query, matches: orderSlashCommands(filterSlashCommands(slashCommands, query)) };
  }, [composerText, slashCommands, dismissedQuery]);

  /** 菜单的可见性：有斜杠状态就显示 —— 包括**没有匹配项**的那种（列表位置留给空态文案） */
  const slashOpen = slash !== null;
  /**
   * 当前行：高亮的那条，不在清单里（被收窄挤走 / 还没设过）就落回第一条。
   * 键盘动作与 aria-activedescendant 都读它，保证「显示什么就是选中什么」。
   */
  const activeCommand = useMemo(
    () =>
      slash === null
        ? null
        : (slash.matches.find((command) => optionKey(command) === activeKey) ??
          slash.matches[0] ??
          null),
    [slash, activeKey],
  );

  /**
   * Escape 的抑制只在「这一段斜杠查询」内有效：输入框不再是斜杠查询（发出去、清空、
   * 改成普通消息）就解除。不解除的话，以后敲出同一段文本再也弹不出菜单 ——
   * 用户看到的是「菜单坏了」。
   */
  useEffect(() => {
    if (slashQuery(composerText) === null) setDismissedQuery(null);
  }, [composerText]);

  // 高亮跟着清单走：当前行不在清单里就落回第一条
  useEffect(() => {
    setActiveKey(activeCommand === null ? null : optionKey(activeCommand));
  }, [activeCommand]);

  /** 选中一条：技能填 `/名称 `，模板直接展开成正文；菜单随之收起 */
  const selectSlashCommand = (command: SlashCommand) => {
    aui.composer.setText(insertSlashCommand(command));
    setActiveKey(null);
  };

  /** 菜单打开时的按键处理；返回 true 表示这次按键已被菜单消费 */
  const handleSlashKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (slash === null) return false;
    // Ctrl/⌘+Enter 是「插话」，优先于菜单：只有不带修饰键的 Enter 才是选中
    const plainEnter = event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const { matches } = slash;
      const at = activeCommand === null ? -1 : matches.indexOf(activeCommand);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = matches[(at + delta + matches.length) % matches.length];
      if (next !== undefined) setActiveKey(optionKey(next));
      return true;
    }
    if (plainEnter && activeCommand !== null) {
      event.preventDefault();
      selectSlashCommand(activeCommand);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // 只收起菜单，输入框里的文本原样留着；记下这次查询词，免得它立刻弹回来
      setActiveKey(null);
      setDismissedQuery(slash.query);
      return true;
    }
    return false;
  };

  /**
   * 一条指令此刻**为什么不能执行**（已翻译的文案）；null = 可用。
   *
   * 菜单置灰与回车拦截读的是同一个判定，所以不会出现「菜单里点得动、发送时却被拒」。
   * 发送收口（OintRuntimeProvider）用的是同一个命令模块 —— 三处一条口径。
   */
  const commandBlockedReason = (command: SlashCommand): string | null => {
    if (command.kind !== "command") return null;
    const spec = commandSpec(command.name);
    if (spec === undefined) return null;
    const reason = unavailableReason(spec, { running, compacting });
    return reason === null ? null : t(reason.messageKey);
  };

  /** 输入框当前文本是不是一条指令（且已写完整）；用于发送键与回车的拦截 */
  const commandDraft = useMemo(
    () => dispatchSlashInput(composerText, slashCommands),
    [composerText, slashCommands],
  );

  /** 当前草稿是一条**不可用**的指令：发送键也要禁掉（点击不经过 keydown 拦截） */
  const commandBlocked =
    commandDraft.kind === "command" && commandBlockedReason(commandDraft.command) !== null;

  /**
   * 输入框按键：先归斜杠菜单（上下 / Enter / Esc），再归指令与运行中的排队。
   *
   * 三条都不靠 preventDefault 之外的机制：库只在「Enter 且非合成中」时发送，
   * 这里接管的那几种键都 preventDefault 了，库的处理器据此跳过，不会双触发。
   *
   * 为什么指令的「不可用」必须拦在这里而不是发送收口：库在调用 onNew **之前**就把
   * 输入框清空了，等在收口里拒绝，用户敲的说明（`/compact 保留…`）已经没了。
   */
  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法合成期间按键属于候选词，任何一条都不该接管
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (handleSlashKey(event)) return;

    const plainEnter = event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey;

    // ---- 指令：不可用就拦下（草稿原样保留），可用则放行给库的发送路径 ----
    if (commandDraft.kind === "command") {
      const blocked = commandBlockedReason(commandDraft.command);
      if (blocked !== null) {
        if (plainEnter) {
          event.preventDefault();
          useUiStore.getState().notifyComposer({
            messageKey: "chat.commandBlocked",
            params: { reason: blocked },
            level: "error",
          });
        }
        return;
      }
    }

    // ---- 压缩中（且没有在跑）：不发消息 —— 压缩占着 lane，发出去会把压缩顶掉 ----
    if (compacting && !running) {
      if (plainEnter) {
        event.preventDefault();
        useUiStore
          .getState()
          .notifyComposer({ messageKey: "chat.compactWhileCompacting", level: "info" });
      }
      return;
    }

    // ---- 运行中：Enter 排队，Ctrl(⌘)+Enter 插话 ----
    if (!running) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    // 运行中到达这里的指令：目前没有「运行中也能执行」的指令（availability 只有 idle），
    // 所以这是给将来留的兜底 —— 队列里存的是**文本**，指令不能原样排队（发出去会变成消息）。
    if (commandDraft.kind === "command") {
      useUiStore
        .getState()
        .notifyComposer({ messageKey: "chat.commandUnavailableRunning", level: "error" });
      return;
    }
    /**
     * 带附件时**不排队**：主进程的队列项形状就是 `{ text, mode }`，附件排不进去。
     * 早先的写法是「排队只带文本，附件留在输入框里」—— 结果是附件跟着**下一条**消息
     * 发出去，而用户以为它已经跟这条一起送走了。宁可明确拒绝，也不要静默地错。
     */
    if (attachmentCount > 0) {
      useUiStore
        .getState()
        .notifyComposer({ messageKey: "chat.attachmentQueueBlocked", level: "error" });
      return;
    }
    const text = commandDraft.text.trim();
    if (text.length === 0) return;
    const mode = event.ctrlKey || event.metaKey ? "steer" : "followUp";
    void useChatStore.getState().queue(text, mode);
    aui.composer.setText("");
  };

  const [workMenuOpen, setWorkMenuOpen] = useState(false);
  const sendNewWork = (effects: "read-only" | "unrestricted", requiresReview: boolean) => {
    if (!canSend || running || compacting || commandDraft.kind === "command") return;
    setWorkMenuOpen(false);
    const previous = aui.composer.getState().runConfig;
    const workOptions: ChatSendOptions = { work: { kind: "new", effects, requiresReview } };
    // The composer captures runConfig synchronously, including when attachments need processing.
    aui.composer.setRunConfig({ ...previous, custom: { ...previous.custom, workOptions } });
    try {
      aui.composer.send();
    } finally {
      aui.composer.setRunConfig(previous);
    }
  };

  return (
    // 底部不留内边距：输入框以下的间距交给 Thread 的底栏（状态条上下各 3px，
    // 且那条底栏是不透明的，消息不再从输入框下方透出来）。
    // hero 摆法自带外层内边距（它落在新会话页的居中列里），不再叠加 px-4。
    <div className={hero ? "w-full" : "px-4"}>
      {/*
        停靠区（任务清单 + 待发送队列）挂在**输入框上方、外壳之外**：
        它俩与输入框共用同一个宽度与面，圆角只在顶部、下沿与输入框无缝相接 ——
        读起来是「输入框长出来的一截」。放进 Root 内部会与外层的 24px 圆角打架
        （内层的方角会在圆角里露出来）。
        外轮廓（边框 + 圆角 + 两块之间的分隔线）由 ComposerDock 一处画，
        里面两块只是它的段 —— 于是「有清单没队列」「两个都有」这些组合都不用传位置。
        hero 摆法不挂它：那一刻会话是空的，清单与队列都不可能非空。
      */}
      {!hero && (
        <ComposerDock>
          <GoalDock key={`goal-${activeSessionId}`} />
          <PlanDock key={`plan-${activeSessionId}`} />
          <TodoDock />
          <QueueDock items={queue} />
        </ComposerDock>
      )}
      <ComposerPrimitive.Root
        compact={false}
        // data-slot：探针与接线测试靠它定位（输入框是 form 元素，没有别的稳定标识）
        data-slot="composer-root"
        className={cn(
          // 面用 Thread 根上声明的 --composer-bg（= --card）：它比页面底色亮一档，
          // 配合 --composer-shadow 才立得起来；暗色沿用 paper 口径的 popover 面。
          // relative 是**斜杠菜单的锚点**：菜单自己是 absolute bottom-full，它要贴着
          // 这张卡的上沿往上弹。原先这里没有 relative，靠的是脚注容器是 sticky（sticky
          // 也算定位元素）—— 于是「对话中」能用、而新会话页（输入框不在脚注里）把菜单
          // 弹到了视口顶边之外。锚点写在这里，两种摆法就都不依赖外层恰好被定位。
          "relative w-full border border-border/60 transition-colors",
          "bg-[var(--composer-bg,var(--card))] shadow-[var(--composer-shadow)] dark:bg-popover",
          "focus-within:ring-1 focus-within:ring-foreground/20",
          // hero：外壳只留 6px 边距，圆角收一档 —— 它比对话里那只矮，24px 会显得发胖
          hero ? "rounded-[20px] p-1.5" : "rounded-[24px] p-2.5",
        )}
      >
        {/* 上下文行在**外壳上**、输入面之外：它说的是「这个会话在哪」，不是输入的一部分 */}
        {hero && <ComposerContextRow />}
        <ComposerPrimitive.AttachmentDropzone
          className={cn(
            "flex flex-col gap-2 transition-colors",
            hero
              ? // 内层输入面：比外壳暗一档，读成「外壳里嵌着的那块输入区」
                "rounded-[14px] bg-foreground/[0.035] p-2.5 dark:bg-foreground/[0.06]"
              : // 对话里是单层面：负边距抵消外壳内边距，让拖拽高亮铺满整张卡
                "-m-2.5 rounded-[24px] p-2.5",
            // 拖拽态：Elements 的蓝底 + 虚线边，用 outline 画以免多算一层盒模型
            "data-[dragging=true]:bg-blue-500/[0.04] dark:data-[dragging=true]:bg-blue-500/10",
            "data-[dragging=true]:outline-1 data-[dragging=true]:-outline-offset-1 data-[dragging=true]:outline-dashed data-[dragging=true]:outline-blue-500/40",
          )}
        >
          {/* 待办与待发送队列已移到输入框上方的停靠区（见文件头的容器说明） */}
          {/* Attachments 渲染的是片段，横向排布靠这层容器；空时不留出 gap */}
          <div className="flex flex-wrap gap-2 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <AttachmentThumb key={attachment.id} attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </div>
          {/*
            模型没开图片输入时的提前说明。
            不写这一句的话，用户会看到图片在界面上显示得好好的、模型却说「我看不到图」——
            真正的原因是 pi-ai 在请求装配阶段把 image 块换成了
            `(image omitted: model does not support images)`（见 transform-messages 的
            downgradeUnsupportedImages），而这条降级在任何界面上都没有痕迹。
          */}
          {attachmentCount > 0 &&
            currentModel !== null &&
            currentModel.model.acceptsImages !== true && (
              <p role="status" className="text-ink-3 px-2.5 text-[11.5px] leading-snug">
                {t("chat.attachmentVisionUnsupported")}
              </p>
            )}
          {/*
            斜杠菜单挂在 Input 之前：ComposerMenu 自己是 absolute bottom-full，
            这里靠它贴到 composer 上沿（Root 是 relative），不占输入框的排版位置。
          */}
          {slash !== null && (
            <SlashCommandMenu
              listId={slashListId}
              matches={slash.matches}
              activeKey={activeCommand === null ? null : optionKey(activeCommand)}
              onSelect={selectSlashCommand}
              blockedReason={commandBlockedReason}
            />
          )}
          {/*
            瞬时提示（指令被拒 / 压缩中不能发送）：贴在输入框上方一行，窄而克制。
            放这里而不是做成全局 toast：它解释的是**这次输入为什么没发出去**，
            就该出现在输入框边上。
          */}
          {composerNotice === null ? null : (
            <p
              role="status"
              className={cn(
                "px-2.5 pt-1 text-xs",
                composerNotice.level === "error" ? "text-destructive" : "text-ink-3",
              )}
            >
              {t(composerNotice.messageKey, composerNotice.params)}
            </p>
          )}
          <ComposerPrimitive.Input
            submitMode="enter"
            addAttachmentOnPaste
            // 长到 10 行就封顶，再往上由 textarea 自己滚（见 COMPOSER_MAX_ROWS）
            maxRows={COMPOSER_MAX_ROWS}
            placeholder={t("chat.inputPlaceholder")}
            onKeyDown={handleInputKeyDown}
            onChange={() => dismissComposerNotice()}
            role="combobox"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? slashListId : undefined}
            aria-activedescendant={
              // 只在那一行确实渲染出来时才指过去：空态 / Escape 之后没有高亮行
              activeCommand === null ? undefined : `${slashListId}-${optionKey(activeCommand)}`
            }
            className={cn(
              "min-h-9 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none",
              // 到顶之后这一层才真的有滚动条；细滚动条与消息区、侧栏同一套
              "app-scrollbar",
              "placeholder:text-ink-4",
            )}
          />
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ComposerPrimitive.AddAttachment
                multiple
                aria-label={t("chat.addAttachment")}
                className={cn(
                  ghostButton,
                  "size-8 shrink-0 disabled:pointer-events-none disabled:opacity-30",
                )}
              >
                <Plus className="size-4" />
              </ComposerPrimitive.AddAttachment>
              {/*
                顺序是刻意的：**智能体模式在权限的左侧**。
                左边管「用哪种方式干活」（模式），右边管「放行到什么程度」（权限、模型、思考档位）——
                模式是这一排里最靠前的选择，因为它决定整段系统提示怎么写。
              */}
              <AgentModeChip
                mode={effectiveAgentMode}
                bound={boundAgentMode}
                // 只在没有活动会话时禁用；运行中**可以**切（生效于下一轮）
                disabled={activeSessionId === null}
                running={running}
                onSelect={async (mode) => {
                  if (activeSessionId === null) return { ok: true as const };
                  return useChatStore.getState().setSessionMode(activeSessionId, mode);
                }}
              />
              <PermissionChip mode={permissionMode} />
              <ModelChip
                options={modelOptions}
                current={currentModel}
                bound={boundModel}
                onSelect={async (model) => {
                  if (activeSessionId === null) return { ok: false, reason: "no-model" };
                  return useChatStore.getState().setSessionModel(activeSessionId, model);
                }}
              />
              <ThinkingChip resolved={thinking} />
            </div>
            {/* 运行中文案一律不驻留：底部这行只放控件本身 */}
            <div className="flex shrink-0 items-center gap-1.5">
              {usageRing}
              {!running && (
                <Popover open={workMenuOpen} onOpenChange={setWorkMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(ghostButton, "px-2 py-1 text-xs")}
                      disabled={!canSend || compacting || commandDraft.kind === "command"}
                      aria-label={t("chat.newWork")}
                    >
                      {t("chat.newWork")}
                      <ChevronDown className="ml-1 size-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-1">
                    <button
                      type="button"
                      className="w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => sendNewWork("read-only", true)}
                    >
                      {t("chat.planOnly")}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => sendNewWork("unrestricted", false)}
                    >
                      {t("chat.newWorkExecute")}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted"
                      onClick={() => sendNewWork("read-only", false)}
                    >
                      {t("chat.newWorkReadOnly")}
                    </button>
                  </PopoverContent>
                </Popover>
              )}
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
                  {/*
                    空输入、不可用的指令、以及「压缩中且没在跑」都禁用：
                    后两种发出去也会被拒（或被压缩顶掉），禁用比错误提示更早一步。
                  */}
                  <button
                    type="button"
                    disabled={!canSend || commandBlocked || compacting}
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
