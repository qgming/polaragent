// 工作区文件树（懒加载）—— 右侧任务监控面板「工作区」tab 使用
// src/components/WorkspaceTree.tsx
//
// 给定工作目录根路径，懒加载渲染其子文件夹与文件：
//   - 进入时只读根层；点开某个文件夹才读取其子层（按需加载）
//   - 目录可展开/收起；文件仅展示（本期不打开）
//   - 目录在前、文件在后，由后端排序

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { fileIconFor } from "@/lib/file-icons";
import { isPreviewable, openPreviewWindow } from "@/lib/preview";
import { AudioPlayerDialog } from "@/components/audio/AudioPlayerDialog";
import {
  listDirectoryEntries,
  openPath,
  type DirEntry,
} from "@/lib/electron/electron-api";

// 拼接子路径（统一用 /，后端兼容）
function joinPath(base: string, name: string): string {
  const trimmed = base.replace(/[\\/]+$/, "");
  return `${trimmed}/${name}`;
}

export function WorkspaceTree({ rootDir }: { rootDir: string }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 用于强制刷新（点刷新按钮时 +1，触发根层重新读取）
  const [reloadKey, setReloadKey] = useState(0);
  // 音频播放状态
  const [playingAudio, setPlayingAudio] = useState<{
    path: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries(null);
    listDirectoryEntries(rootDir)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootDir, reloadKey]);

  return (
    <div>
      {/* 根路径 + 在资源管理器打开工作区目录 + 刷新 */}
      <div className="flex items-center gap-1 px-3">
        <p
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={rootDir}
        >
          {rootDir}
        </p>
        <button
          type="button"
          onClick={() => void openPath(rootDir)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="在文件资源管理器中打开"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="刷新"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      <div className="mt-1">
        {error ? (
          <p className="px-3 py-2 text-xs leading-5 text-destructive">
            读取目录失败：{error}
          </p>
        ) : loading && !entries ? (
          <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取…
          </p>
        ) : entries && entries.length > 0 ? (
          <ul className="space-y-0.5">
            {entries.map((entry) => (
              <TreeNode
                key={entry.name}
                entry={entry}
                parentPath={rootDir}
                depth={0}
                onPlayAudio={setPlayingAudio}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">
            该目录为空
          </p>
        )}
      </div>

      {/* 音频播放器弹窗 */}
      {playingAudio && (
        <AudioPlayerDialog
          audioPath={playingAudio.path}
          fileName={playingAudio.name}
          onClose={() => setPlayingAudio(null)}
        />
      )}
    </div>
  );
}

// 单个树节点：目录可展开（懒加载子层），文件仅展示
function TreeNode({
  entry,
  parentPath,
  depth,
  onPlayAudio,
}: {
  entry: DirEntry;
  parentPath: string;
  depth: number;
  onPlayAudio: (audio: { path: string; name: string }) => void;
}) {
  const fullPath = joinPath(parentPath, entry.name);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 文件是否可在预览窗口打开（md/html/文本/图片）
  const previewable = !entry.isDir && isPreviewable(entry.name);
  // 文件是否为音频
  const isAudio =
    !entry.isDir && /\.(mp3|wav|ogg|webm|m4a|aac|flac|opus)$/i.test(entry.name);

  const toggle = useCallback(() => {
    // 文件：音频打开播放器，可预览打开预览窗口，其他无操作
    if (!entry.isDir) {
      if (isAudio) {
        onPlayAudio({ path: fullPath, name: entry.name });
      } else if (previewable) {
        void openPreviewWindow(fullPath);
      }
      return;
    }
    setOpen((prev) => {
      const next = !prev;
      // 首次展开才读取子层（懒加载）
      if (next && children === null && !loading) {
        setLoading(true);
        setError(null);
        listDirectoryEntries(fullPath)
          .then((list) => setChildren(list))
          .catch((err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
          )
          .finally(() => setLoading(false));
      }
      return next;
    });
  }, [
    entry.isDir,
    entry.name,
    previewable,
    isAudio,
    children,
    loading,
    fullPath,
    onPlayAudio,
  ]);

  const clickable = entry.isDir || previewable || isAudio;

  return (
    <li className="px-2">
      <button
        type="button"
        onClick={toggle}
        disabled={!clickable}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-sm text-sidebar-foreground transition-colors",
          clickable
            ? "cursor-pointer hover:bg-muted hover:text-foreground"
            : "cursor-default",
        )}
        title={
          isAudio
            ? `播放 ${entry.name}`
            : previewable
              ? `预览 ${fullPath}`
              : fullPath
        }
      >
        {entry.isDir ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : null}
        {entry.isDir ? (
          open ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          (() => {
            // 文件：按扩展名取图标（中性灰，不彩色）
            const Icon = fileIconFor(entry.name);
            return <Icon className="size-4 shrink-0 text-muted-foreground" />;
          })()
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </button>

      {open ? (
        error ? (
          <p className="px-2 py-0.5 text-xs text-destructive">
            {error}
          </p>
        ) : children && children.length > 0 ? (
          <ul className="space-y-0.5">
            {children.map((child) => (
              <TreeNode
                key={child.name}
                entry={child}
                parentPath={fullPath}
                depth={depth + 1}
                onPlayAudio={onPlayAudio}
              />
            ))}
          </ul>
        ) : children && children.length === 0 ? (
          <p className="px-2 py-0.5 text-xs text-muted-foreground">
            空文件夹
          </p>
        ) : null
      ) : null}
    </li>
  );
}
