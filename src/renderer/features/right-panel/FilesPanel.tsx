import { ArrowUp, FileText, Folder, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFileSize } from "@/renderer/components/assistant-ui/elements/file";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { DirectoryListing, FileContent, FileTreeEntry } from "@/shared/contracts/files";
import { PanelEmpty, PanelError, PanelSection } from "./panel-view";

/**
 * 文件面板：按需展开的目录浏览 + 文件预览。
 *
 * 每次只列一层（主进程也照这个口径实现）：工作目录里常有 node_modules / .git 这种
 * 几万条目的子树，一次拉全树既慢又占内存，而人的操作本来就是「点开看一层」。
 *
 * 根固定为会话绑定的工作目录（主进程的路径守卫会拒掉根之外的路径）——
 * 这既让面板看得见项目，也保证它不会变成一个任意路径浏览器。
 *
 * 两种模式共用一个组件而不是两个：它们是同一条导航流的前后两屏
 *（列表 → 文件），拆开就要把「怎么回来的」这条状态提到父层，反而更绕。
 */

/** 预览最多渲染的行数：超出部分不渲染（几万行的文件全塞进 DOM 会直接卡死窗口） */
const MAX_PREVIEW_LINES = 4000;

export function FilesPanel(): React.JSX.Element {
  const { t } = useTranslation();

  /**
   * 当前会话 id：面板只把它交给主进程，根目录由主进程从会话索引解析。
   * 这里同时用它判断「有没有会话」来决定空态 —— cwd 只用于展示，不再作为请求参数。
   */
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessionCwd = useChatStore((s) =>
    s.activeSessionId !== null
      ? s.sessions.find((item) => item.id === s.activeSessionId)?.cwd
      : undefined,
  );

  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 当前列出的目录；null = 用会话工作目录 */
  const [currentPath, setCurrentPath] = useState<string | null>(null);

  /**
   * 拉一层目录。
   *
   * 依赖里带 currentPath 与 sessionId：切换目录、切换会话都要重取。
   * 用 useCallback 包一层是为了让「刷新」按钮能复用同一段逻辑，而不是把
   * 上面的状态更新抄第二遍。
   */
  const load = useCallback(
    async (path: string | null) => {
      if (activeSessionId === null) return;
      setLoading(true);
      setError(null);
      try {
        const result = await window.oint.files.listDirectory(
          path === null ? { sessionId: activeSessionId } : { sessionId: activeSessionId, path },
        );
        setListing(result);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setLoading(false);
      }
    },
    [activeSessionId],
  );

  // 会话变化时回到根并重取
  useEffect(() => {
    setCurrentPath(null);
    setPreview(null);
    void load(null);
  }, [load]);

  const openFile = async (entry: FileTreeEntry) => {
    if (activeSessionId === null) return;
    setLoading(true);
    setError(null);
    try {
      setPreview(
        await window.oint.files.readFile({ sessionId: activeSessionId, path: entry.path }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  if (activeSessionId === null || sessionCwd === undefined) {
    // 空态直接铺满：面板头部已经写着「文件」，这里不再重复一行标题
    return <PanelEmpty icon={FileText} title={t("rightPanel.filesPickRoot")} />;
  }

  // —— 预览模式 ——
  if (preview !== null) {
    const lines = preview.text.split("\n");
    const truncatedLines = lines.length > MAX_PREVIEW_LINES;
    const shown = truncatedLines ? lines.slice(0, MAX_PREVIEW_LINES) : lines;
    const name = preview.path.split(/[/\\]/).pop() ?? preview.path;

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelSection
          title={name}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.filesBack")}
              title={t("rightPanel.filesBack")}
              onClick={() => setPreview(null)}
            >
              <X className="size-4" />
            </Button>
          }
        />

        {/* 提示带：只有需要说明时才出现（二进制 / 被截断），正常文件不占这一行 */}
        {(preview.binary || preview.truncated || truncatedLines) && (
          <p className={cn(mono, "shrink-0 border-b border-border/60 px-3 py-1 text-ink-4")}>
            {preview.binary
              ? t("rightPanel.filesBinary")
              : truncatedLines
                ? t("rightPanel.filesTooLarge", { size: `${MAX_PREVIEW_LINES} / ${lines.length}` })
                : t("rightPanel.filesTooLarge", { size: formatFileSize(preview.size) })}
          </p>
        )}

        {/* 预览正文：等宽、不换行、可横向滚动。
            codeScroll + codeSurface 是仓库既有的口径（见 surfaces.tsx 的说明）：
            pre 在定宽容器里会把长行裁掉，所以由外层滚动、内层 w-max min-w-full。 */}
        <div className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-auto")}>
          <pre className={cn(mono, "w-max min-w-full px-3 py-2 leading-relaxed")} dir="ltr">
            {shown.join("\n")}
          </pre>
        </div>
      </div>
    );
  }

  // —— 列表模式 ——
  // 标题显示相对路径（root 内），比绝对路径短得多；已经在根时显示 root 的最后一段。
  // root 取自主进程回的 listing（渲染层不再自己算根），首帧还没拿到时退回会话 cwd。
  const displayPath =
    listing === null
      ? sessionCwd
      : listing.path === listing.root
        ? (listing.root.split(/[/\\]/).filter(Boolean).pop() ?? listing.root)
        : listing.path
            .slice(listing.root.length + 1)
            .split(/[/\\]/)
            .join("/");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelSection
        title={displayPath}
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.filesParent")}
              title={t("rightPanel.filesParent")}
              disabled={listing?.parent === null || listing === null}
              onClick={() => {
                if (listing?.parent == null) return;
                setCurrentPath(listing.parent);
                void load(listing.parent);
              }}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.filesRefresh")}
              title={t("rightPanel.filesRefresh")}
              onClick={() => void load(currentPath)}
            >
              <RefreshCw
                className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
          </>
        }
      />

      {error !== null && <PanelError message={`${t("rightPanel.filesLoadFailed")}：${error}`} />}

      {listing === null ? (
        <div className={cn(mono, "p-4 text-ink-4")}>{t("common.loading")}</div>
      ) : listing.entries.length === 0 ? (
        <PanelEmpty icon={Folder} title={t("rightPanel.filesEmpty")} />
      ) : (
        <>
          {listing.truncated && (
            <p className={cn(mono, "shrink-0 border-b border-border/60 px-3 py-1 text-ink-4")}>
              {t("rightPanel.filesTruncated", { count: listing.entries.length })}
            </p>
          )}
          <ul className="app-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  title={entry.name}
                  onClick={() => {
                    if (entry.kind === "directory") {
                      setCurrentPath(entry.path);
                      void load(entry.path);
                    } else {
                      void openFile(entry);
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-accent"
                >
                  {entry.kind === "directory" ? (
                    <Folder className="text-ink-3 size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <FileText className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[12.5px]",
                      entry.kind === "directory" ? "text-foreground" : "text-ink-2",
                    )}
                    dir="ltr"
                  >
                    {entry.name}
                  </span>
                  {/* 符号链接给一个小标记：点进去可能跳到别处，先说清楚 */}
                  {entry.symlink === true && (
                    <span className={cn(mono, "text-ink-4 shrink-0")} title="symlink">
                      @
                    </span>
                  )}
                  {entry.size !== undefined && entry.kind === "file" && (
                    <span className={cn(typePackage, "text-ink-4 shrink-0")}>
                      {formatFileSize(entry.size)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
