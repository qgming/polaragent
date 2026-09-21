import { Code, Eye, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFileSize } from "@/renderer/components/assistant-ui/elements/file";
import { MarkdownBlock } from "@/renderer/components/assistant-ui/elements/markdown-text";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { baseNameOf, hasRenderedMode } from "@/renderer/features/chat/turn-files";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { FileContent } from "@/shared/contracts/files";
import { PanelEmpty, PanelSection } from "./panel-view";

/**
 * 单个文件的查看器：右侧栏里「读一个文件」的那一屏。
 *
 * 为什么与「文件」面板（FilesPanel）分开而不是给它加一个参数：
 * 两者的导航模型不同 —— FilesPanel 是「从根目录逐层点进去」的浏览，顶部有返回上级、
 * 有一整条路径痕；而这里是从对话里点一张卡片直达一个文件，没有来路可退
 *（用户要的是「看这个文件」，不是「顺便逛一下它所在的目录」）。硬合成一个组件，
 * 两种模式下要显示的按钮、标题、返回目标全都要按模式分支，反而更难读。
 *
 * **markdown 默认渲染**（用户明确要求）：按源码读出来是 `## 标题` / `| 表 |`，
 * 按渲染读才是文档。顶部可切到源码，两个模式共用同一份已读到的文本，切换不再取一次。
 *
 * 文件内容走 `files.readFile`：**根由主进程按 sessionId 解析**，渲染层只给绝对路径，
 * 越界路径会被主进程拒掉（见 main/ipc/files.ts）。
 */

/** 预览最多渲染的行数：几万行的文件全塞进 DOM 会直接卡死窗口（与 FilesPanel 同口径） */
const MAX_PREVIEW_LINES = 4000;

type ViewMode = "rendered" | "source";

export function FileViewPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const target = useUiStore((s) => s.filePanelTarget);

  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("rendered");

  const path = target;
  const renderable = path !== null && hasRenderedMode(path);

  const load = useCallback(async () => {
    if (activeSessionId === null || path === null) {
      setContent(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setContent(await window.oint.files.readFile({ sessionId: activeSessionId, path }));
    } catch (failure) {
      setContent(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 换文件时回到默认模式（渲染档）。
   *
   * 用 React 官方的「渲染期调整状态」而不是 useEffect：effect 会在**提交之后**才跑，
   * 那时用户已经看到一帧「新文件 + 上一个文件的模式」；而这里 setState 发生在渲染期，
   * React 会立刻用新状态重渲染，中间那一帧不会上屏（见 react.dev 的
   * "Adjusting some state when a prop changes"）。
   *
   * 判据用**上一个 path**而不是「mode 是不是 rendered」：用户手动切到源码后，
   * 点刷新（同一个文件）不该清掉他的选择 —— 只有真的换了文件才重置。
   */
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setMode("rendered");
  }

  if (path === null) {
    return <PanelEmpty icon={FileText} title={t("rightPanel.fileEmpty")} />;
  }

  const name = baseNameOf(path);
  // 不能渲染的文件（.ts / .txt）永远走源码：给一个点了没变化的切换按钮比不给更糟
  const effectiveMode: ViewMode = renderable ? mode : "source";
  const lines = content === null ? [] : content.text.split("\n");
  const truncatedLines = lines.length > MAX_PREVIEW_LINES;
  const shown = truncatedLines ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelSection
        title={name}
        actions={
          <>
            {/* 模式切换只给能渲染的文件；图标取「切过去会看到什么」，
                当前档位高亮 —— 比一个写着渲染/源码的文字按钮省一半宽度 */}
            {renderable && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("rightPanel.fileRendered")}
                  aria-pressed={effectiveMode === "rendered"}
                  title={t("rightPanel.fileRendered")}
                  onClick={() => setMode("rendered")}
                  className={cn(effectiveMode === "rendered" && "bg-accent text-foreground")}
                >
                  <Eye className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("rightPanel.fileSource")}
                  aria-pressed={effectiveMode === "source"}
                  title={t("rightPanel.fileSource")}
                  onClick={() => setMode("source")}
                  className={cn(effectiveMode === "source" && "bg-accent text-foreground")}
                >
                  <Code className="size-4" />
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.filesRefresh")}
              title={t("rightPanel.filesRefresh")}
              onClick={() => void load()}
            >
              <RefreshCw
                className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
          </>
        }
      />

      {/* 路径痕：文件名已在标题上，这里给出完整路径（相对路径看不出是哪个目录下的同名文件） */}
      <p className={cn(mono, "shrink-0 truncate border-b border-border/60 px-3 py-1")} title={path}>
        <span className="text-ink-4">{path}</span>
      </p>

      {/* 提示带：只在需要说明时出现（二进制 / 被截断），正常文件不占这一行 */}
      {content !== null && (content.binary || content.truncated || truncatedLines) && (
        <p className={cn(mono, "shrink-0 border-b border-border/60 px-3 py-1 text-ink-4")}>
          {content.binary
            ? t("rightPanel.filesBinary")
            : truncatedLines
              ? t("rightPanel.filesTooLarge", { size: `${MAX_PREVIEW_LINES} / ${lines.length}` })
              : t("rightPanel.filesTooLarge", { size: formatFileSize(content.size) })}
        </p>
      )}

      {error !== null && (
        <p role="alert" className={cn(mono, "shrink-0 px-3 py-2 text-destructive")}>
          {t("rightPanel.filesLoadFailed")}：{error}
        </p>
      )}

      {content === null ? (
        <div className={cn(mono, "p-4 text-ink-4")}>
          {loading ? t("common.loading") : t("rightPanel.fileEmpty")}
        </div>
      ) : content.binary ? (
        // 二进制没有可读正文：只留上面那条提示，不把乱码铺满屏幕
        <div className={cn(mono, "p-4 text-ink-4")}>{t("rightPanel.filesBinary")}</div>
      ) : effectiveMode === "rendered" ? (
        /*
          渲染档：正文按 markdown 渲染，与对话、子智能体报告共用同一个 MarkdownBlock
          （同一件事在三处长得不一样，是这个仓库最早那版实现留下的坑）。
          可滚动、不可横向溢出：markdown 的表格与代码块自己带横向滚动。
        */
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <MarkdownBlock text={content.text} className="text-[13px]" />
        </div>
      ) : (
        /* 源码档：等宽、不换行、可横向滚动（口径与 FilesPanel 的预览一致） */
        <div className="app-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <pre className={cn(mono, "w-max min-w-full px-3 py-2 leading-relaxed")} dir="ltr">
            {shown.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
