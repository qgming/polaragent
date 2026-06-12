// 右侧任务监控面板
// src/components/TaskMonitorPanel.tsx

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleDashed,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/utils";
import { fileIconFor } from "@/lib/file-icons";
import { isPreviewable, openPreviewWindow } from "@/lib/preview";
import { AudioPlayerDialog } from "@/components/audio/AudioPlayerDialog";
import { WorkspaceTree } from "@/components/WorkspaceTree";
import { useResponsivePanelWidth } from "@/hooks/useResponsiveWidth";
import {
  useTaskMonitorStore,
  type ArtifactItem,
  type TodoItem,
} from "@/stores/task-monitor-store";

export function TaskMonitorPanel({
  threadId,
  sessionFilesDir,
}: {
  threadId: string;
  sessionFilesDir?: string;
}) {
  const monitor = useTaskMonitorStore((state) =>
    state.byThread[threadId],
  );
  const todos = monitor?.todos ?? [];
  const artifacts = monitor?.artifacts ?? [];

  const finalFiles = artifacts.filter((item) => item.kind === "final");
  const workingFiles = artifacts.filter((item) => item.kind === "working");

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const panelWidth = useResponsivePanelWidth();

  return (
    // 宽度开合动画与左侧侧边栏一致；内层同步宽度避免内容被挤压。
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: panelWidth, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="flex shrink-0 flex-col overflow-hidden border-l border-border bg-background"
    >
      <div className="flex h-full flex-col pt-2" style={{ width: panelWidth }}>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
        {/* 待办 */}
        <Section
          title="待办"
          count={todos.length > 0 ? `${completed}/${todos.length}` : undefined}
        >
          {todos.length > 0 ? (
            <ul className="space-y-0.5">
              {todos.map((todo) => (
                <TodoRow key={todo.id} todo={todo} />
              ))}
            </ul>
          ) : (
            <EmptyHint text="任务执行时，待办清单会显示在这里" />
          )}
        </Section>

        {/* 产物：左「最终文件」/ 中「工作区」/ 右「会话文件」三 tab */}
        <Section title="产物">
          <ArtifactsTabs
            finalFiles={finalFiles}
            workingFiles={workingFiles}
            workingDir={monitor?.workingDir}
            sessionFilesDir={sessionFilesDir}
          />
        </Section>
        </div>
      </div>
    </motion.aside>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="border-b border-dashed border-border/70 py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-1 text-left"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          {title}
          {count ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {count}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? <div className="mt-0.5">{children}</div> : null}
    </section>
  );
}

// 产物 tab：左「生成文件」（已产出 artifacts）/ 中「工作目录」或「临时目录」。
// 规则：有工作目录时显示「生成文件 + 工作目录」，无工作目录时显示「生成文件 + 临时目录」。
// tab 切换样式与动画复刻左侧侧边栏：选中态用 layoutId 滑块平滑移动，内容按方向横滑。

function ArtifactsTabs({
  finalFiles,
  workingFiles,
  workingDir,
  sessionFilesDir,
}: {
  finalFiles: ArtifactItem[];
  workingFiles: ArtifactItem[];
  workingDir?: string;
  sessionFilesDir?: string;
}) {
  // 判断是否选择了工作目录（非临时目录）
  const hasWorkingDir = workingDir && workingDir !== sessionFilesDir;
  // 动态 tab 列表：有工作目录时显示「final + workspace」，无则显示「final + session」
  const availableTabs: Array<"final" | "workspace" | "session"> = hasWorkingDir
    ? ["final", "workspace"]
    : ["final", "session"];

  const [tab, setTab] = useState<"final" | "workspace" | "session">("final");
  // 记录上一个 tab，推导内容横滑方向（切到右侧 +1，左侧 -1）
  const prevTabRef = useRef(tab);
  const direction =
    availableTabs.indexOf(tab) >= availableTabs.indexOf(prevTabRef.current)
      ? 1
      : -1;
  useEffect(() => {
    prevTabRef.current = tab;
  }, [tab]);

  // 当 tab 列表变化时（工作目录切换），确保当前 tab 在可用列表中
  useEffect(() => {
    if (!availableTabs.includes(tab)) {
      setTab("final");
    }
  }, [availableTabs, tab]);

  return (
    <div className="px-3">
      {/* 分段控件（与左侧侧边栏一致：layoutId 滑块） */}
      <div className={cn(
        "grid gap-0.5 rounded-md bg-muted p-0.5",
        availableTabs.length === 2 ? "grid-cols-2" : "grid-cols-3"
      )}>
        {availableTabs.map((value) => {
          const active = tab === value;
          const label = value === "final" ? "生成文件" : value === "workspace" ? "工作目录" : "临时目录";
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "relative flex h-6 items-center justify-center rounded-[5px] px-2 text-xs font-medium whitespace-nowrap transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="artifact-tab-indicator"
                  transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  className="absolute inset-0 rounded-[5px] bg-card shadow-sm"
                />
              ) : null}
              <span className="relative z-10">{label}</span>
            </button>
          );
        })}
      </div>

      {/* 内容横滑（方向跟随 tab 切换） */}
      <div className="relative mt-2 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={tab}
            custom={direction}
            variants={{
              enter: (dir: number) => ({ x: dir * 40, opacity: 0 }),
              center: { x: 0, opacity: 1 },
              exit: (dir: number) => ({ x: dir * -40, opacity: 0 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
            // 抵消外层 px-3，使内部内容（label/文件行）回到面板基准线
            className="-mx-3"
          >
            {tab === "final" ? (
              finalFiles.length > 0 || workingFiles.length > 0 ? (
                <div className="space-y-1.5">
                  {finalFiles.length > 0 ? (
                    <ArtifactGroup
                      label="最终文件"
                      files={finalFiles}
                      workingDir={workingDir}
                    />
                  ) : null}
                  {workingFiles.length > 0 ? (
                    <ArtifactGroup
                      label="工作文件"
                      files={workingFiles}
                      workingDir={workingDir}
                    />
                  ) : null}
                </div>
              ) : (
                <EmptyHint text="生成的文件会出现在这里" />
              )
            ) : tab === "workspace" ? (
              workingDir ? (
                <WorkspaceTree rootDir={workingDir} />
              ) : (
                <EmptyHint text="未选择工作目录" />
              )
            ) : sessionFilesDir ? (
              <WorkspaceTree rootDir={sessionFilesDir} />
            ) : (
              <EmptyHint text="会话文件目录不存在" />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-3 py-1 text-sm">
      <span className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="size-4 text-[#9b6fe0]" />
        ) : todo.status === "in_progress" ? (
          <Loader2 className="size-4 animate-spin text-[#9b6fe0]" />
        ) : (
          <CircleDashed className="size-4 text-muted-foreground" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 leading-5",
          todo.status === "completed"
            ? "text-muted-foreground line-through"
            : todo.status === "in_progress"
              ? "font-medium text-foreground"
              : "text-sidebar-foreground",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}

function ArtifactGroup({
  label,
  files,
  workingDir,
}: {
  label: string;
  files: ArtifactItem[];
  workingDir?: string;
}) {
  const [playingAudio, setPlayingAudio] = useState<{ path: string; name: string } | null>(null);

  return (
    <div>
      <p className="mb-0.5 px-3 text-xs text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {files.map((file) => {
          // 按扩展名取图标（中性灰，不彩色）
          const Icon = fileIconFor(file.name);
          // 可预览类型（md/html/文本/图片）点击打开预览窗口
          const previewable = isPreviewable(file.name);
          // 音频文件判断
          const isAudio = /\.(mp3|wav|ogg|webm|m4a|aac|flac|opus)$/i.test(file.name);

          // 解析相对路径为绝对路径（file.path 可能是相对的）
          const absolutePath = resolvePath(file.path, workingDir);

          const handleClick = () => {
            if (isAudio) {
              setPlayingAudio({ path: absolutePath, name: file.name });
            } else if (previewable) {
              void openPreviewWindow(absolutePath);
            }
          };

          const clickable = previewable || isAudio;

          return (
            <li key={file.path} className="px-2">
              <button
                type="button"
                onClick={handleClick}
                disabled={!clickable}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-sm text-sidebar-foreground transition-colors",
                  clickable
                    ? "cursor-pointer hover:bg-muted hover:text-foreground"
                    : "cursor-default",
                )}
                title={
                  isAudio
                    ? `播放 ${file.name}`
                    : previewable
                      ? `预览 ${absolutePath}`
                      : absolutePath
                }
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
              </button>
            </li>
          );
        })}
      </ul>

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

// 把相对路径解析到工作目录下；绝对路径原样返回（与 ai/tools/context.ts 逻辑一致）
function resolvePath(path: string, workingDir?: string): string {
  if (!workingDir) return path;
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbsolute) return path;
  const base = workingDir.replace(/[\\/]+$/, "");
  return `${base}/${path}`;
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">{text}</p>
  );
}
