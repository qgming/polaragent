// 设置页面共享的小组件
// src/components/settings/shared.tsx

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
      <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{description}</p>
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
      <span className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      {children}
    </label>
  );
}

// 偏好设置中的单行：左侧标题+描述，右侧控件
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
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

// 通用下拉选择器：触发器显示当前值，点击弹出单选列表
export function SettingDropdown({
  value,
  onChange,
  options,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 min-w-[96px] items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring",
            className,
          )}
        >
          <span className={cn("truncate", !current && "text-muted-foreground")}>
            {current?.label ?? placeholder ?? value}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
