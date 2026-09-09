// 设置页面共享的小组件
// src/components/settings/settings-shared.tsx

import { ChevronDown } from "lucide-react";
import type { Bot } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// 页面标题区
export function PageTitle({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

// 带图标标签的表单字段
export function Field({
  children,
  icon: Icon,
  label,
}: {
  children: React.ReactNode;
  icon: typeof Bot;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      {children}
    </label>
  );
}

// 设置单行：左侧标题+描述，右侧控件
export function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-6 py-4">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

// 通用下拉选择器
export function SettingDropdown({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: React.ReactNode }>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 min-w-[100px] items-center justify-between gap-2 rounded-xl border border-border/60 bg-background px-3.5 text-[13px] outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("flex min-w-0 items-center gap-2 truncate", !current && "text-muted-foreground")}>
            {current?.label ?? placeholder ?? value}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-xl"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="rounded-lg text-[13px]">
              <span className="flex items-center gap-2">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
