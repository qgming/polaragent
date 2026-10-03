import { Check, Code, Eye, RefreshCw } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatFileSize } from "@/renderer/components/assistant-ui/elements/file";
import { MarkdownBlock } from "@/renderer/components/assistant-ui/elements/markdown-text";
import { SyntaxHighlighter } from "@/renderer/components/assistant-ui/elements/shiki-highlighter";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { baseNameOf } from "@/renderer/features/chat/turn-files";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { FileContent } from "@/shared/contracts/files";
import { languageOf, renderedKindOf } from "./file-language";
import { PanelError, PanelSection } from "./panel-view";
import {
  beginFileSave,
  endFileSave,
  forgetUnsaved,
  publishFileSaved,
  rememberUnsaved,
  subscribeFileSaves,
  unsavedBaseOf,
  unsavedOf,
  useDraftPersistenceFailed,
} from "./unsaved-edits";

/**
 * 「读一个文件」的那一屏：右栏里两处看文件的地方共用它。
 *
 * 两处是：对话里点文件卡片（FileViewPanel）与文件面板里从目录树点开（FilesPanel）。
 * 它们的**导航模型**不同（一个是从卡片直达一个文件、没有来路可退；另一个是「从根目录
 * 逐层点进去」、标题左边有返回），所以导航留在各自的面板里；而「这个文件怎么读」——
 * 渲染 / 原始两档、markdown 排版、代码高亮、原文编辑与保存 —— 只有这一份实现。
 * 早先两边各写一份，能力很快就漂移成了「一边能渲染、一边只能看纯文本」。
 *
 * ## 正文的两档
 *
 *  - **渲染档**：markdown 按文档排版，代码按语法高亮（都只读）；
 *  - **原始档**：纯文本。文件读全了且不是二进制时**可编辑**（主进程会拒掉二进制与
 *    超上限的写回，所以编辑态提前在这些情况下关掉，别让用户打完字才被拒）；
 *  - 没有渲染档的文件（.txt / .log / 未知扩展名）只有原始档 —— 给一个点了没变化的
 *    切换按钮比不给更糟。
 *
 * ## 编辑
 *
 * 正文改动先落在 `draft` 里（`null` = 与磁盘一致），保存时整份提交（全量替换）。
 * 有改动时脚注行显示「未保存」与保存按钮，光标在正文里时 `Ctrl/Cmd + S` 同效。
 * **离开这个文件不会丢掉改动**：草稿按路径留在 unsaved-edits.ts 里，再打开时接回来
 *（理由见那个文件）。
 *
 * 渲染档显示的是**编辑中的正文**，不是磁盘上那一份 —— 所以「切到渲染档看一眼」不会
 * 丢掉刚敲的东西，也不需要为它弹一个确认框。
 */

/** 预览最多渲染的行数：几万行的文件全塞进 DOM（或交给 shiki 分词）会直接卡死窗口 */
const MAX_PREVIEW_LINES = 4000;

/** 渲染档 / 原始档 */
type ViewMode = "rendered" | "source";

/**
 * 高亮器的容器样式。
 *
 * `SyntaxHighlighter` 自带的是**markdown 代码块**的形状（上圆角去掉、下圆角保留、
 * 自带边框、muted 底色），因为它是给 `CodeHeader + 高亮本体` 那套用的。查看器里
 * 代码占满整个面板，所以把圆角、边框、底色都收掉，内边距对齐原始档的 `px-3 py-2`
 * —— 两档切换时正文不跳位。
 */
const highlighterClassName =
  "[&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-transparent! [&_pre]:p-2 [&_pre]:px-3";

export interface FileViewerProps {
  /** 要看的文件（绝对路径） */
  path: string;
  /**
   * 标题左侧的插槽：从列表点进来时放「返回」。
   *
   * 由调用方给而不是组件自己画：返回**去哪里**是各自导航模型的事（回列表 / 回根目录），
   * 查看器不该知道。
   */
  leading?: ReactNode;
}

export function FileViewer({ path, leading }: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation();
  const sessionId = useChatStore((s) => s.activeSessionId);

  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("rendered");
  /**
   * 编辑中的正文；null = 与磁盘上的内容一致（正文以 content.text 为准）。
   *
   * 初值从待保存表里取：从列表重新点开一个改过没保存的文件时，组件是**新挂载**的
   *（那一屏与列表是互斥的），只有这里能把上次的正文接回来。
   */
  const [draft, setDraft] = useState<string | null>(() => unsavedOf(path));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const persistenceFailed = useDraftPersistenceFailed();
  const currentPath = useRef(path);
  currentPath.current = path;
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestRef.current += 1;
    };
  }, []);

  /**
   * 读取序号：只认最后一次请求的结果。
   *
   * 连点两个文件时两次读取会并发，先发的后回就会把**上一个文件**的正文贴到当前标题下。
   * 序号一挡，晚到的旧结果直接丢掉。
   */
  const requestRef = useRef(0);
  useEffect(
    () =>
      subscribeFileSaves(path, (text, bytes) => {
        // Another viewer may own the write after this one was remounted. Its completion
        // must update this viewer too, while retaining any intervening edit or revert.
        requestRef.current += 1;
        setLoading(false);
        setContent({ path, text, size: bytes, binary: false, truncated: false });
        setDraft(unsavedOf(path));
        setError(null);
        setSaveError(null);
        setSaved(unsavedOf(path) === null);
      }),
    [path],
  );

  const load = useCallback(
    async (reviewDisk = false) => {
      if (sessionId === null) return;
      requestRef.current += 1;
      const token = requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const next = await window.oint.files.readFile({ sessionId, path });
        if (token !== requestRef.current) return;
        setContent(next);
        const recovered = unsavedOf(path);
        const base = unsavedBaseOf(path);
        if (recovered !== null && base !== null && base !== next.text) {
          if (reviewDisk) {
            rememberUnsaved(path, recovered, next.text);
            setSaveError(null);
          } else setSaveError(t("rightPanel.fileChangedOnDisk"));
        }
      } catch (failure) {
        if (token !== requestRef.current) return;
        setContent(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (token === requestRef.current) setLoading(false);
      }
    },
    [sessionId, path, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 换文件时回到默认档位、清掉上一个文件的保存反馈，并把它的未保存草稿接回来。
   *
   * 用 React 官方的「渲染期调整状态」而不是 useEffect：effect 在**提交之后**才跑，
   * 那时用户已经看到一帧「新文件 + 上一个文件的档位」；这里 setState 发生在渲染期，
   * React 立刻用新状态重渲染，中间那一帧不上屏（见 react.dev 的 "Adjusting some state
   * when a prop changes"）。
   *
   * 同时把正文清空：否则新文件的标题下会先显示**上一个文件**的正文，直到读取回来。
   */
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setMode("rendered");
    setContent(null);
    setError(null);
    setDraft(unsavedOf(path));
    setSaveError(null);
    setSaved(false);
  }

  /** 保存成功提示 1.5s 后自动消失（与设置面板里 AGENTS.md 的保存反馈同口径） */
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1500);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const kind = renderedKindOf(path);
  const language = languageOf(path);
  const name = baseNameOf(path);
  // 没有渲染档的文件永远走原始档
  const effectiveMode: ViewMode = kind === null ? "source" : mode;

  const full = content?.readonly ? content.text : (draft ?? content?.text ?? "");
  const lines = full.split("\n");
  const truncatedLines = lines.length > MAX_PREVIEW_LINES;
  const previewText = truncatedLines ? lines.slice(0, MAX_PREVIEW_LINES).join("\n") : full;

  // 二进制与「没读全」的文件不给编辑：主进程这两种情况都会拒写（见 main/files/service.ts）
  const editable = content !== null && !content.readonly && !content.binary && !content.truncated;
  const dirty = draft !== null && content !== null && draft !== content.text;
  const canSave = editable && dirty && !saving;

  const save = useCallback(async () => {
    if (
      sessionId === null ||
      draft === null ||
      content === null ||
      content.readonly ||
      savingRef.current
    )
      return;
    const pending = beginFileSave(path, draft);
    if (pending === null) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const stillCurrent = () => mounted.current && currentPath.current === path;
    try {
      const disk = await window.oint.files.readFile({ sessionId, path });
      if (
        disk.readonly ||
        disk.binary ||
        disk.truncated ||
        disk.text !== (unsavedBaseOf(path) ?? content.text)
      ) {
        throw new Error(t("rightPanel.fileChangedOnDisk"));
      }
      const result = await window.oint.files.writeFile({ sessionId, path, text: draft });
      // Typing may continue during the write. Only clear the submitted revision.
      const latest = pending.revision === 0 ? draft : pending.text;
      if (latest === draft) forgetUnsaved(path);
      else rememberUnsaved(path, latest, draft);
      publishFileSaved(path, draft, result.bytes);
    } catch (failure) {
      if (stillCurrent())
        setSaveError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      endFileSave(path);
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [content, draft, path, sessionId, t]);

  /** 编辑：草稿同时写进待保存表（离开这个文件时它还在，回来时接上） */
  const edit = (text: string) => {
    setDraft(text);
    setSaved(false);
    if (content !== null) rememberUnsaved(path, text, unsavedBaseOf(path) ?? content.text);
  };

  const revert = () => {
    setDraft(null);
    setSaveError(null);
    setSaved(false);
    if (content !== null) rememberUnsaved(path, content.text, content.text);
    else forgetUnsaved(path);
  };

  /**
   * Ctrl/Cmd + S 保存。
   *
   * 挂在编辑区上：焦点在正文里时才算数（编辑器的惯例，也是这里能挂的唯一位置 ——
   * 外层容器不是可交互元素，在它上面监听键盘会变成「没有可访问性语义的快捷键」）。
   * 不写正文时用脚注行里那颗「保存」。
   */
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    if (event.key.toLowerCase() !== "s" || !canSave) return;
    event.preventDefault();
    void save();
  };

  /*
    脚注行（状态 + 保存）只在两种时候出现：
      · 原始档 —— 它是编辑面，保存动作必须看得见；
      · 有未保存的改动 / 保存中 / 刚保存完 —— 切到渲染档看排版时，「还没存」这件事
        不能跟着消失。
    干净的文件按渲染档读时不留这一行：文档不需要状态栏。
  */
  const showFooter =
    editable && (dirty || saving || saved || saveError !== null || effectiveMode === "source");

  const status =
    saveError !== null
      ? `${t("rightPanel.fileSaveFailed")}：${saveError}`
      : saving
        ? t("rightPanel.fileSaving")
        : saved
          ? t("common.saved")
          : dirty
            ? t("rightPanel.fileUnsaved")
            : formatFileSize(content?.size ?? 0);

  // 提示里的修饰键按平台给：macOS 用 ⌘，其余用 Ctrl（判定本来就同时认两者，
  // 见 useGlobalShortcuts；RightPanelChooser 的 ShortcutHint 是同一口径）
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelSection
        title={name}
        leading={leading}
        actions={
          <>
            {/* 模式切换只给有渲染档的文件；图标取「切过去会看到什么」，
                当前档位高亮 —— 比一个写着渲染/源码的文字按钮省一半宽度 */}
            {kind !== null && (
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
              disabled={loading}
              onClick={() => void load(true)}
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

      {persistenceFailed && <PanelError message={t("rightPanel.fileDraftStorageFailed")} />}
      {error !== null && <PanelError message={`${t("rightPanel.filesLoadFailed")}：${error}`} />}

      {content === null ? (
        // 没有正文又没有错误，只可能是还在读（错误上面那一行已经说了）
        error === null && <div className={cn(mono, "p-4 text-ink-4")}>{t("common.loading")}</div>
      ) : content.binary ? (
        // 二进制没有可读正文：只留上面那条提示，不把乱码铺满屏幕
        <div className={cn(mono, "p-4 text-ink-4")}>{t("rightPanel.filesBinary")}</div>
      ) : effectiveMode === "rendered" && kind === "markdown" ? (
        /*
          渲染档（markdown）：正文按文档排版，与对话、子智能体报告共用同一个 MarkdownBlock
          （同一件事在三处长得不一样，是这个仓库最早那版实现留下的坑）。
          可滚动、不可横向溢出：markdown 的表格与代码块自己带横向滚动。
        */
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <MarkdownBlock text={previewText} className="text-[13px]" />
        </div>
      ) : effectiveMode === "rendered" ? (
        /* 渲染档（代码）：语法高亮，只读 */
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          <SyntaxHighlighter
            language={language ?? undefined}
            code={previewText}
            className={highlighterClassName}
          />
        </div>
      ) : editable ? (
        /*
          原始档（可编辑）：等宽、不换行、可横向滚动 —— 与只读的源码档同一套口径，
          切档位时正文不跳位。`wrap="off"` 是这里的关键：换行会让「第几行」这件事
          在两档之间对不上。
        */
        <textarea
          value={full}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onEditorKeyDown}
          aria-label={t("rightPanel.fileEditLabel")}
          spellCheck={false}
          wrap="off"
          dir="ltr"
          className={cn(
            mono,
            "app-scrollbar min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-2 leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:ring-inset",
          )}
        />
      ) : (
        /* 原始档（只读）：二进制 / 没读全的文件不给编辑，等宽、不换行、可横向滚动 */
        <div className="app-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <pre className={cn(mono, "w-max min-w-full px-3 py-2 leading-relaxed")} dir="ltr">
            {previewText}
          </pre>
        </div>
      )}

      {showFooter && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3">
          <span
            // 保存中 / 已保存 / 未保存都是状态变化，用 status 让读屏器播报；
            // 失败是错误，换成 alert（本仓的 error-state / panel-view 同一口径）
            role={saveError === null ? "status" : "alert"}
            className={cn(
              typePackage,
              "flex min-w-0 items-center gap-1.5",
              saveError === null ? "text-ink-3" : "text-destructive",
            )}
          >
            {saved && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            <span className="truncate" title={status}>
              {status}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {dirty && (
              <Button type="button" variant="ghost" size="xs" onClick={revert}>
                {t("rightPanel.fileRevert")}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              disabled={!canSave}
              title={isMac ? "⌘S" : "Ctrl+S"}
              onClick={() => void save()}
            >
              {saving ? t("rightPanel.fileSaving") : t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
