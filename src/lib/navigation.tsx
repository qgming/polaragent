// 导航相关的共享类型与常量
// src/lib/navigation.tsx

import { Blocks, BookOpen, Bot, Plus, Settings, Users, Wrench, Zap } from "lucide-react";
import type { ComponentType } from "react";

export type IconComponent = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

export type PageId =
  | "chat"
  | "skills"
  | "tools"
  | "agent"
  | "team"
  | "knowledge"
  | "settings";

// 各页面的图标（标题与描述已迁移到 nav.json 翻译文件，按 pageId 查 t("nav:pages.<id>.title")）
export const pages: Record<
  PageId,
  { icon: IconComponent }
> = {
  chat: { icon: Plus },
  skills: { icon: Zap },
  tools: { icon: Wrench },
  agent: { icon: Bot },
  team: { icon: Users },
  knowledge: { icon: BookOpen },
  settings: { icon: Settings },
};

export type NavItem = {
  id: PageId;
  icon: IconComponent;
};

// 左侧栏顶层导航项（始终平级展示）
export const primaryNav: NavItem[] = [
  { id: "chat", icon: Plus },
];

// 顶层导航项（排在「扩展」折叠组之后）
export const secondaryNav: NavItem[] = [
  { id: "knowledge", icon: BookOpen },
];

// 「扩展」折叠分组：收纳技能 / 工具 / 助手 / 团队
export const extensionNav: {
  icon: IconComponent;
  items: NavItem[];
} = {
  icon: Blocks,
  items: [
    { id: "skills", icon: Zap },
    { id: "tools", icon: Wrench },
    { id: "agent", icon: Bot },
    { id: "team", icon: Users },
  ],
};
