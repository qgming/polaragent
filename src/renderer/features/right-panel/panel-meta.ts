import { Bot, Braces, FileText, Globe, type LucideIcon, SquareTerminal } from "lucide-react";
import type { RightPanelView } from "@/renderer/stores/ui-store";

/**
 * 五个视图的展示元数据：图标与文案键。
 *
 * 单独一份而不是写在组件里，是因为它有两处消费者：
 * 右侧栏的标签条（每个标签的图标与名字）与选择列表（入口、图标、快捷键提示）。
 * 两处各写一遍图标数组，加一个视图就会漏改（列表里多一点、标签条上少一点）。
 *
 * 顺序由 RIGHT_PANEL_VIEWS 定（ui-store），这里只提供「某个视图长什么样」。
 *
 * `file`（单个文件的查看器）**在表里但不在 RIGHT_PANEL_VIEWS 里**：
 * 它需要图标与名字画在标签上，却不该出现在选择列表 —— 详见 ui-store 的说明。
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
  // 单个文件的查看器：标签上的名字会被文件名覆盖（见 openFilePanel），
  // 这个 labelKey 只在还没打开任何文件时兜底
  file: { icon: FileText, labelKey: "rightPanel.file" },
  // 子智能体：Bot 而不是 Network —— 一次委派的详情是「某个代理在干活」，
  // 而 Network 在浏览器工具卡里已经表示「网络请求」，同屏可能出现两处，图标要能分得开
  subagent: { icon: Bot, labelKey: "rightPanel.subagent" },
  // 浏览器：Ctrl+T，与「新建标签页」同键
  browser: { icon: Globe, labelKey: "rightPanel.browser", shortcut: "T" },
  terminal: { icon: SquareTerminal, labelKey: "rightPanel.terminal" },
};
