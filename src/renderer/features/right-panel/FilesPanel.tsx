import { ArrowLeft, FileText, Folder, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFileSize } from "@/renderer/components/assistant-ui/elements/file";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { findProjectForCwd } from "@/renderer/lib/projects";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import type { DirectoryListing } from "@/shared/contracts/files";
import { FileViewer } from "./file-viewer";
import { PanelEmpty, PanelError, PanelSection } from "./panel-view";
import { useUnsavedPaths } from "./unsaved-edits";

/**
 * 文件面板：按需展开的目录浏览 + 文件预览。
 *
 * 每次只列一层（主进程也照这个口径实现）：工作目录里常有 node_modules / .git 这种
 * 几万条目的子树，一次拉全树既慢又占内存，而人的操作本来就是「点开看一层」。
 *
 * 根固定为会话绑定的工作目录（主进程的路径守卫会拒掉根之外的路径）——
 * 这既让面板看得见项目，也保证它不会变成一个任意路径浏览器。
 * **没绑过工作目录的会话也有根**：主进程会现给它补一个本会话的临时目录
 *（见 main/ipc/files.ts），所以这里不再把「没有 cwd」当空态。
 *
 * 两种模式共用一个组件而不是两个：它们是同一条导航流的前后两屏
 *（列表 → 文件），拆开就要把「怎么回来的」这条状态提到父层，反而更绕。
 *
 * **文件那两屏的正文不在这里**：交给 FileViewer（与对话里的文件卡片同一份实现），
 * 这里只决定「看哪个文件」与「怎么回去」。
 */

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
  const projects = useProjectsStore((s) => s.projects);

  /**
   * 这个会话的根是不是「本会话的临时目录」：不在任何项目里就是。
   *
   * 判断放在渲染层，而不是让主进程在 listing 上多回一个标志：项目列表本来就在这儿
   *（侧栏分组用的同一份），而界面上的一句提示不值得占一个契约字段。
   */
  const temporaryRoot =
    sessionCwd !== undefined && findProjectForCwd(sessionCwd, projects) === null;

  const [listing, setListing] = useState<DirectoryListing | null>(null);
  /** 正在看的文件（绝对路径）；null = 在列表那一屏 */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 当前列出的目录；null = 用会话工作目录 */
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  /** 有未保存编辑的文件：列表里给它们打一个标记，避免「以为改动丢了」*/
  const unsaved = useUnsavedPaths();

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
    setPreviewPath(null);
    void load(null);
  }, [load]);

  if (activeSessionId === null) {
    // 空态直接铺满：面板头部已经写着「文件」，这里不再重复一行标题
    return <PanelEmpty icon={FileText} title={t("rightPanel.noSession")} />;
  }

  // —— 看文件那一屏 ——
  if (previewPath !== null) {
    return (
      <FileViewer
        path={previewPath}
        leading={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("rightPanel.filesBack")}
            title={t("rightPanel.filesBack")}
            onClick={() => setPreviewPath(null)}
          >
            <ArrowLeft className="size-4" />
          </Button>
        }
      />
    );
  }

  // —— 列表模式 ——
  // 标题显示相对路径（root 内），比绝对路径短得多；已经在根时显示 root 的最后一段。
  // root 取自主进程回的 listing（渲染层不再自己算根），首帧还没拿到时退回会话 cwd
  //（历史会话的 cwd 可能还是空的，那就退回面板名，总比一条空白横线好）
  const displayPath =
    listing === null
      ? (sessionCwd ?? t("rightPanel.files"))
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
        leading={
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
            <ArrowLeft className="size-4" />
          </Button>
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("rightPanel.filesRefresh")}
            title={t("rightPanel.filesRefresh")}
            disabled={loading}
            onClick={() => void load(currentPath)}
          >
            <RefreshCw
              className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
            />
          </Button>
        }
      />

      {error !== null && <PanelError message={`${t("rightPanel.filesLoadFailed")}：${error}`} />}

      {listing === null ? (
        loading && <div className={cn(mono, "p-4 text-ink-4")}>{t("common.loading")}</div>
      ) : listing.entries.length === 0 ? (
        /* 临时目录的空态多说一句（只在根上）：用户看不到「工作目录」这个概念，
           而「会话删掉时这里的文件会一起清掉」是他该知道的事（保存到别处则不会） */
        <PanelEmpty
          icon={Folder}
          title={t("rightPanel.filesEmpty")}
          hint={
            temporaryRoot && listing.path === listing.root
              ? t("rightPanel.filesEmptyHint")
              : undefined
          }
        />
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
                      setPreviewPath(entry.path);
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
                  {/* 有未保存的编辑：这个文件重新打开时正文会接回来（见 unsaved-edits.ts），
                      先说一声，否则用户会以为改动丢了 */}
                  {unsaved.has(entry.path) && (
                    <span className={cn(mono, "text-ink-3 shrink-0")}>
                      {t("rightPanel.fileUnsaved")}
                    </span>
                  )}
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
