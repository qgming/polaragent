import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { field } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/components/ui/select";
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
      {description ? <p className="mt-1 text-xs text-foreground/45">{description}</p> : null}
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
        <label htmlFor={htmlFor} className="text-[13.5px] leading-5">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-foreground/45">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
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
              selected
                ? "bg-background text-foreground/90"
                : "text-foreground/45 hover:text-foreground/70",
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
  "data-[placeholder]:text-foreground/40",
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
  return <p className="text-[13px] text-foreground/45">{t("common.loading")}</p>;
}
