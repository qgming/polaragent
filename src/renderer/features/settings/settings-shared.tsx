import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";

/** 设置分区：首个分区不显示顶部分隔线，避免面板顶部出现多余线条 */
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
    <section className="border-border border-t pt-5 first:border-t-0 first:pt-0">
      {title ? <h3 className="text-sm font-medium">{title}</h3> : null}
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      <div className="mt-3 space-y-4">{children}</div>
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
        <label htmlFor={htmlFor} className="text-sm">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** 分段选择：选中项品牌浅底 + 品牌描边（E2 落点⑥的克制用法） */
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
    <fieldset aria-label={ariaLabel} className="m-0 flex flex-wrap justify-end gap-1 border-0 p-0">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 rounded-md border px-2.5 text-xs transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              selected
                ? "border-brand bg-brand-muted text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 原生下拉：选项少、层级浅的场景比 shadcn Select 更轻 */
export function NativeSelect({
  value,
  onChange,
  children,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-8 max-w-[260px] min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
    >
      {children}
    </select>
  );
}

/** 面板加载态：设置尚未读取完成时的占位 */
export function PanelLoading() {
  const { t } = useTranslation();
  return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
}
