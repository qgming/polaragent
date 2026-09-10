// 导航相关的共享类型与常量
// src/lib/navigation.tsx

import { Plus } from "lucide-react";
import type { ComponentType } from "react";

export type IconComponent = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

export type PageId = "chat";

export type NavItem = {
  id: PageId;
  icon: IconComponent;
};

// 左侧栏顶层导航项（工具面收窄后只剩对话）
export const primaryNav: NavItem[] = [{ id: "chat", icon: Plus }];
