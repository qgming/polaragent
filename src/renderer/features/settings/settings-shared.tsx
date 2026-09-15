import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { field } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow, typeSection } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";

/**
 * Radix Select 禁止空串作为项的值（空串被它保留给「清空」），
 * 因此「未选择 / 跟随默认」这类空值一律用这个哨兵顶上，落盘时再换回 null。
 */
export const SELECT_NONE = "__none__";

/** 次要按钮的补丁：outline 变体自带阴影与实边，按「只有浮层可以有 lift」去掉 */
export const secondaryButton = "border-border/60 shadow-none";

/** 设置分区：眉题用 typeEyebrow（mono 11px）——design.md 规定 section 由 mono 命名；
 *  首个分区不画顶线，避免面板顶部出现多余线条 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border/60 border-t pt-5 first:border-t-0 first:pt-0">
      {title ? <h3 className={typeEyebrow}>{title}</h3> : null}
      {description ? <p className="mt-1 text-xs text-ink-3">{description}</p> : null}
      <div className="mt-3 space-y-3.5">{children}</div>
    </section>
  );
}

/** 一行设置：左侧标签与说明，右侧控件（控件不参与换行，保持单行对齐） */
export function SettingsField({
  label,
  description,
  control,
  htmlFor,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {/* 标签不折行：中文可以逐字断行，窄窗口下「内核」会被拆成两行（说明文字仍可折行） */}
        <label htmlFor={htmlFor} className="text-[13.5px] leading-5 whitespace-nowrap">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/**
 * 面板大标题：右侧每个分类左上角都有一行，与左栏的「设置」标题同档（display 衬线 text-xl）。
 *
 * 由 SettingsModal 统一渲染，面板自己不必各写一个 —— 分类名就是标题，词条取
 * settings.general / services / skills / personalization / about。
 * 面板内部的分组标题仍是 SettingsSection 的 mono 眉题（h3），层级为 大标题 h2 → 分组 h3。
 */
export function SettingsPanelTitle({ children }: { children: ReactNode }) {
  return <h2 className={cn(typeSection, "mb-5 text-foreground")}>{children}</h2>;
}

/**
 * 分段控件：轨道与选中胶囊的形状取自 Elements 的 settings-panel（field 轨道 + 选中项浮起为底色胶囊）。
 * 这里不用 Tabs：Tabs 的语义是切换视图，而这个控件的每一项都是同一个字段的一个取值，
 * 用 aria-pressed 的按钮组才是对的语义。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(field, "m-0 flex flex-wrap justify-end gap-0.5 rounded-full border-0 p-0.5")}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap outline-none",
              "transition-[background-color,color,scale] duration-150 focus-visible:ring-1 focus-visible:ring-foreground/20 active:scale-[0.97] motion-reduce:transition-none",
              selected ? "bg-background text-foreground" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 文本输入：Elements 的 field 面（无边框、10px 圆角、1px 墨色焦点环），与官方 settings-panel 的输入同一口径 */
export const settingsInput = cn(
  field,
  "h-8 rounded-[10px] border-transparent px-2.5 text-sm shadow-none",
  "focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-foreground/20",
);

/** 多行输入：同上，圆角按面板档位取 12，行距放松以便阅读长文本 */
export const settingsTextarea = cn(
  field,
  "rounded-xl border-transparent px-3 py-2 leading-relaxed shadow-none",
  "focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-foreground/20",
);

/** 触发器：field 底 + 10px 圆角；hover 用 fieldInteractive 的加深量，避免回落到组件的 bg-muted */
const selectTrigger = cn(
  field,
  "h-8 w-fit rounded-[10px] border-0 px-2.5 py-0 text-[13px]",
  "hover:bg-foreground/[0.07] dark:hover:bg-foreground/[0.09]",
  "data-[placeholder]:text-ink-4",
  "focus-visible:ring-1 focus-visible:ring-foreground/20",
);

/** 选项行：Elements 菜单行的形状（10px 圆角、13px、hover 用墨色淡底） */
const selectItem =
  "rounded-[10px] py-1.5 ps-2.5 pe-8 text-[13px] focus:bg-foreground/[0.06] focus:text-foreground";

/** 设置项下拉：用官方 Select 替掉原生 select；项的值不得为空串，未选用 SELECT_NONE */
export function SettingsSelect({
  value,
  onChange,
  items,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  items: readonly { value: string; label: string }[];
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} size="sm" className={cn(selectTrigger, className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-2xl">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className={selectItem}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 面板加载态：设置尚未读取完成时的占位 */
export function PanelLoading() {
  const { t } = useTranslation();
  return <p className="text-[13px] text-ink-3">{t("common.loading")}</p>;
}

/**
 * IPC 拒绝时的 message 会带 `Error invoking remote method 'xxx': Error: ` 前缀，
 * 直接显示给用户是一串噪音 —— 这里剥掉前缀，只留主进程写的中文说明。
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}

/**
 * 资源面板的工具栏：左边放筛选 / 说明，右边固定是动作位。
 * 技能 / 魔法提示 / 子智能体 / MCP / 模型服务五个面板共用，保证「添加」按钮永远在同一个位置。
 */
export function PanelToolbar({ children, action }: { children?: ReactNode; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  );
}

/** 统一的「添加」按钮：主按钮 + Plus 图标；位置由 PanelToolbar 固定，样式不再各面板各写一份 */
export function AddButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button type="button" size="sm" disabled={disabled} onClick={onClick}>
      <Plus className="size-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * 统一的表单弹窗：五个面板的新增 / 查看 / 编辑都走它 —— 宽度、头部眉题、正文滚动区、
 * 底部动作区只此一份，面板不再各自拼 DialogContent（过去尺寸与间距各不相同）。
 *
 * 传入的 children 是正文（可滚动），footer 是底部动作区（左侧放次要动作，右侧放取消/保存）。
 * header 区域右侧留给 DialogContent 自带的关闭按钮（pr-12 是给它留位）。
 */
export function SettingsDialog({
  title,
  description,
  children,
  footer,
  onClose,
  bodyClassName,
}: {
  title: string;
  /** 显示给用户的说明；只作为副标题展示，不参与 aria 描述（描述用 sr-only 兜底） */
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  bodyClassName?: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[86vh] w-[560px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        <DialogHeader className="shrink-0 border-border/60 border-b p-4 pr-12">
          <DialogTitle className={cn(typeEyebrow, "font-normal")}>{title}</DialogTitle>
          <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
        </DialogHeader>
        <div className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto p-4", bodyClassName)}>
          {children}
        </div>
        <DialogFooter className="shrink-0 flex-row items-center justify-between border-border/60 border-t p-4 sm:justify-between">
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 「打开文件夹」按钮：走主进程的 app.openPath（那里会校验绝对路径再交给系统）。
 * 失败原因挂在该按钮的 tooltip 上，不静默吞掉 —— 打开失败通常意味着目录被删或被占用。
 */
export function OpenDirButton({ target, label }: { target: string | null; label: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string | null>(null);

  const handleClick = async () => {
    if (target === null || target === "") return;
    const result = await window.oint.app.openPath(target).catch(() => null);
    setReason(result === null || !result.ok ? (result?.reason ?? t("errors.generic")) : null);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={target === null || target === ""}
            onClick={() => void handleClick()}
          >
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      {reason !== null ? (
        <TooltipContent>{`${t("settings.openFailed")}：${reason}`}</TooltipContent>
      ) : null}
    </Tooltip>
  );
}
