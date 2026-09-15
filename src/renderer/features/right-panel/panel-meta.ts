import { Bot, Braces, FileText, Globe, type LucideIcon, SquareTerminal } from "lucide-react";
import type { RightPanelView } from "@/renderer/stores/ui-store";

/**
 * 五个视图的展示元数据：图标与文案键。
 *
 * 单独一份而不是写在菜单组件里，是因为它有三处消费者：
 * 顶栏的菜单、右侧栏的标题栏（当前视图名）、以及快捷键处理（按视图算提示标签）。
 * 三处各写一遍图标数组，加一个视图就会漏改（菜单里多一点、标题栏少一点）。
 *
 * 顺序由 RIGHT_PANEL_VIEWS 定（ui-store），这里只提供「某个视图长什么样」。
 */
export const RIGHT_PANEL_VIEW_META: Record<
  RightPanelView,
  { icon: LucideIcon; labelKey: string; shortcut?: string }
> = {
  // 审查：diff 语义。用 Braces 而不是 FileDiff —— lucide 没有 FileDiff，
  // 而 Braces 与「代码改动」的关联比一个通用文件图标更直接
  review: { icon: Braces, labelKey: "rightPanel.review" },
  // 文件：Ctrl+P，与主流编辑器/IDE 的「快速打开文件」同键，肌肉记忆直接可用
  files: { icon: FileText, labelKey: "rightPanel.files", shortcut: "P" },
  // 子智能体：Bot 而不是 Network —— 一次委派的详情是「某个代理在干活」，
  // 而 Network 在浏览器工具卡里已经表示「网络请求」，同屏可能出现两处，图标要能分得开
  subagent: { icon: Bot, labelKey: "rightPanel.subagent" },
  // 浏览器：Ctrl+T，与「新建标签页」同键
  browser: { icon: Globe, labelKey: "rightPanel.browser", shortcut: "T" },
  terminal: { icon: SquareTerminal, labelKey: "rightPanel.terminal" },
};
