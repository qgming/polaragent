import type { ComponentType, ReactNode } from "react";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";

/**
 * 右侧面板的公共外壳件。
 *
 * 单独一个文件，是因为五个面板（审查 / 文件 / 侧边聊天 / 浏览器 / 终端）都要用到它们，
 * 而它们又必须长得完全一样：右栏里每一屏的第一行共用同一条 44px 横线与同一个左对齐基线，
 * 每个面板各写一份时，「哪一行比别的矮 2px」是最常见的结果。
 *
 * 只放真正共享的两个：标题行与空态。面板内部的列表行、徽标各有各的语义，
 * 硬抽成一套「通用行」只会得到一个什么都能塞、什么都说不清的组件。
 */

/**
 * 面板标题行。
 *
 * 高度 h-11（44px）与左侧栏顶行、内容区顶栏（TitleBar）严格等高 ——
 * 三条横线共用同一条视觉基线，窗口顶部才是一条干净的连续线。
 */
export function PanelSection({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <h3 className={cn(typeEyebrow, "min-w-0 flex-1 truncate")}>{title}</h3>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/**
 * 面板内部的空态。
 *
 * 与整屏空态（elements/empty-state.tsx，那是 hero 级排版）刻意不同：
 * 这里是**一个面板**没内容，属于局部状态 —— 居中的小图标 + 一行说明 + 可选一行提示，
 * 字号压到 13px 级。它挂着 `flex-1` 以便在剩余空间里居中，所以父容器要给它高度。
 */
export function PanelEmpty({
  icon: Icon,
  title,
  hint,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {Icon !== undefined && <Icon className="text-ink-4 size-5" aria-hidden="true" />}
      <p className="text-ink-2 text-[13px]">{title}</p>
      {hint !== undefined && <p className="text-ink-4 text-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

/**
 * 面板内部的错误行。
 *
 * 用 destructive 色而不是红字正文：失败是这一屏的结果，不是内容的一部分。
 * 带 `role="alert"` 让读屏器在它出现时播报（空态/错误都在同一位置替换内容，
 * 不做播报的话用户只会发现「面板变空了」）。
 */
export function PanelError({ message }: { message: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      className="shrink-0 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-destructive"
    >
      {message}
    </p>
  );
}
