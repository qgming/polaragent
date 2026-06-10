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

// 各页面的标题/描述/图标（用于标题栏面包屑）
export const pages: Record<
  PageId,
  { title: string; description: string; icon: IconComponent }
> = {
  chat: {
    title: "新对话",
    description: "创建任务、提问或继续一次对话",
    icon: Plus,
  },
  skills: {
    title: "技能",
    description: "管理可被 Agent 调用的能力与工作流",
    icon: Zap,
  },
  tools: {
    title: "工具",
    description: "管理内置工具和 MCP 服务器",
    icon: Wrench,
  },
  agent: {
    title: "助手",
    description: "编排模型、工具、记忆和执行策略",
    icon: Bot,
  },
  team: {
    title: "团队",
    description: "编排多个助手协作完成复杂任务",
    icon: Users,
  },
  knowledge: {
    title: "知识库",
    description: "管理可被 AI 检索的文档与资料",
    icon: BookOpen,
  },
  settings: {
    title: "设置",
    description: "配置模型、窗口行为、外观和本地数据",
    icon: Settings,
  },
};

export type NavItem = {
  id: PageId;
  label: string;
  icon: IconComponent;
};

// 左侧栏顶层导航项（始终平级展示）
export const primaryNav: NavItem[] = [
  { id: "chat", label: "新对话", icon: Plus },
];

// 顶层导航项（排在「扩展」折叠组之后）
export const secondaryNav: NavItem[] = [
  { id: "knowledge", label: "知识库", icon: BookOpen },
];

// 「扩展」折叠分组：收纳技能 / 工具 / 助手 / 团队
export const extensionNav: {
  label: string;
  icon: IconComponent;
  items: NavItem[];
} = {
  label: "扩展",
  icon: Blocks,
  items: [
    { id: "skills", label: "技能", icon: Zap },
    { id: "tools", label: "工具", icon: Wrench },
    { id: "agent", label: "助手", icon: Bot },
    { id: "team", label: "团队", icon: Users },
  ],
};
