import type { Attachment } from "@assistant-ui/react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, Bot, Brain, Check, ChevronDown, FileText, Plus, Square, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMeter } from "@/renderer/components/assistant-ui/elements/context-meter";
import {
  field,
  fieldInteractive,
  floating,
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
import type {
  AgentMode,
  ChatMessage,
  ChatMessageUsage,
  ModelEntry,
  ModelRef,
  PermissionMode,
  QueuedMessage,
  SessionModelFailure,
  SetSessionModelResult,
  SetSessionModeResult,
} from "@/shared/contracts";
import { resolveEffectiveModelRef } from "@/shared/model-ref";
import { ComposerDock, QueueDock, TodoDock } from "./ComposerDock";
import { SlashCommandMenu } from "./SlashCommandMenu";
import {
  expandSlashInput,
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

/** chip 触发键：形状抄自 elements/composer.tsx 的 ComposerModelTrigger，三个 chip 共用 */
const chipTrigger = cn(
  "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-foreground outline-none",
  "transition-colors hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]",
  "focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none",
);

/** 浮层菜单面板：Elements 的 floating 面（16 圆角 + 1.5 内边距） */
const menuPanel = cn(floating, "rounded-2xl p-1.5");

/** 权限三模式：真实生效 —— default 弹卡询问 / ai_review 交 AI 审批（模型＝默认路由模型）/ full 全部放行 */
const PERMISSION_MODES = [
  { value: "default", labelKey: "chat.permissionDefault" },
  { value: "ai_review", labelKey: "chat.permissionAiReview" },
  { value: "full", labelKey: "chat.permissionFull" },
] as const;

/**
 * 智能体两模式。
 *
 * 顺序上标准在前：它是默认值，也是「不知道该选哪个」时的正确选择。
 *
 * `descKey` 只在这一个 chip 的菜单里用 —— 两个模式的名字（标准/编排）自己说明不了差别，
 * 而它们**能力完全相同**，差别只在系统提示怎么写。不写清楚，用户只会看到两个
 * 点起来没反应的选项。
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
          <Check className="fade-in zoom-in-90 animate-in size-3.5 text-ink-2 duration-200" />
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
          <FileText className="size-5 text-ink-4" />
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

/**
 * 智能体模式 chip：两模式单选。
 *
 * 与权限 chip 的**关键差别：这个写的是会话，不是设置**。
 * - 权限模式是「我多信任它」的全局信任级别 → `settings.permissionMode`；
 * - 智能体模式改的是「我在跟谁说话」→ 每个会话可以不同（`sessions:set-mode` 写会话索引），
 *   `settings.agentMode` 只作为**新会话的默认值**。
 *
 * `mode` 是**已经解析好的生效值**（会话绑定 ?? 设置默认），由调用方算出来 ——
 * chip 不自己回落，否则「会话没绑定」与「绑定了默认值」两种情况在界面上分不出来。
 *
 * **运行中也能切**（原先置灰并靠主进程拒绝）。模式只影响系统提示的组装，而那是每轮现算的，
 * 所以写入之后下一轮自然生效：正在生成的这一轮不受影响，用户的下一条消息用新模式。
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
            onSelect={() => {
              /**
               * **成功才关菜单**：失败时保持打开并把原因显示在菜单里。
               * 先关再报错的写法会让原因连同弹层一起消失 —— 用户只看到「点了没反应」。
               * （模式切换目前不会失败，但这条纪律对将来的失败分支仍然成立。）
               */
              void onSelect(item.value).then((result) => {
                if (result.ok) {
                  setOpen(false);
                  return;
                }
                setFailed(true);
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
  const [failure, setFailure] = useState<SessionModelFailure | null>(null);
  const label = current !== null ? (current.model.name ?? current.model.id) : t("common.empty");

  const choose = async (model: ModelRef) => {
    let result: SetSessionModelResult;
    try {
      result = await onSelect(model);
    } catch {
      // IPC 本身失败（主进程异常 / 设置读不出来）时同样要给出说明：
      // 只 `void` 出去会变成 unhandled rejection，用户看到的是「点了没反应」
      setFailure("no-model");
      return;
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
          <span className={cn(typePackage, "max-w-32 truncate")}>{label}</span>
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
            {t(failure === "running" ? "chat.modelSwitchRunning" : "chat.modelUnavailable")}
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
 * Composer：自绘外壳（--composer-bg 面 + 24px 圆角 + --composer-shadow 抬高）
 * + 附件（选择/拖拽/粘贴）+ 权限/模型/思考 chip + 发送/停止。
 * 发送走 ComposerPrimitive.Send（runtime 原生）；运行中 Enter 走 store.queue（见下）。
 * store 状态按会话分片：running / queue 均需以 activeSessionId 读取。
 *
 * 输入框**上方**是停靠区（ComposerDock）：任务清单与待发送队列贴在外壳之外，
 * 与它共用一个宽度、圆角只在顶部 —— 见该文件顶部对位置与形态的说明。
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
   * 输入框按键：先归斜杠菜单（上下 / Enter / Esc），再归运行中的排队。
   *
   * 两条都不靠 preventDefault 之外的机制：库只在「Enter 且非合成中」时发送，
   * 这里接管的那几种键都 preventDefault 了，库的处理器据此跳过，不会双触发。
   */
  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法合成期间按键属于候选词，任何一条都不该接管
    if (event.nativeEvent.isComposing) return;
    if (handleSlashKey(event)) return;

    // ---- 运行中：Enter 排队，Ctrl(⌘)+Enter 插话 ----
    if (!running) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const text = expandSlashInput(composerText, slashCommands).trim();
    if (text.length === 0) return;
    const mode = event.ctrlKey || event.metaKey ? "steer" : "followUp";
    void useChatStore.getState().queue(text, mode);
    // 排队内容只带文本；附件保留在 Composer 中
    aui.composer.setText("");
  };

  return (
    // 底部不留内边距：输入框以下的间距交给 Thread 的底栏（状态条上下各 3px，
    // 且那条底栏是不透明的，消息不再从输入框下方透出来）
    <div className="px-4">
      {/*
        停靠区（任务清单 + 待发送队列）挂在**输入框上方、外壳之外**：
        它俩与输入框共用同一个宽度与面，圆角只在顶部、下沿与输入框无缝相接 ——
        读起来是「输入框长出来的一截」。放进 Root 内部会与外层的 24px 圆角打架
        （内层的方角会在圆角里露出来）。
        外轮廓（边框 + 圆角 + 两块之间的分隔线）由 ComposerDock 一处画，
        里面两块只是它的段 —— 于是「有清单没队列」「两个都有」这些组合都不用传位置。
      */}
      <ComposerDock>
        <TodoDock />
        <QueueDock items={queue} />
      </ComposerDock>
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
          {/* 待办与待发送队列已移到输入框上方的停靠区（见文件头的容器说明） */}
          {/* Attachments 渲染的是片段，横向排布靠这层容器；空时不留出 gap */}
          <div className="flex flex-wrap gap-2 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <AttachmentThumb key={attachment.id} attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </div>
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
            />
          )}
          <ComposerPrimitive.Input
            submitMode="enter"
            addAttachmentOnPaste
            placeholder={t("chat.inputPlaceholder")}
            onKeyDown={handleInputKeyDown}
            role="combobox"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? slashListId : undefined}
            aria-activedescendant={
              // 只在那一行确实渲染出来时才指过去：空态 / Escape 之后没有高亮行
              activeCommand === null ? undefined : `${slashListId}-${optionKey(activeCommand)}`
            }
            className={cn(
              "min-h-9 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none",
              "placeholder:text-ink-4",
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
                  {/* 空输入时禁用（前景 40% 不透明） */}
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
