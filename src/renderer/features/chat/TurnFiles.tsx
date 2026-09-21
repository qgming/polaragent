"use client";

import { Code2, ExternalLink, FileText } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { cn } from "@/renderer/lib/utils";
import { useUiStore } from "@/renderer/stores/ui-store";
import { fileOpenTarget, type TurnFileChange, type TurnFileSummary, toFileUrl } from "./turn-files";

/**
 * 「本轮文件改动」：一次用户提问引发的全部文件改动，挂在那一回合的最后一条消息下面。
 *
 * 形态（用户明确要求）：
 *   · 标题行「本轮文件改动」+ 一排 chip —— 每个改动过的文件一枚，代码文件也在这里出现；
 *   · 卡片区 —— **只有文档类**（md / txt / html）出卡片，与 chip 那一行是两个层次：
 *     chip 回答「这轮动了哪些文件」，卡片回答「其中这几份值得读，点开就能看」；
 *   · 卡片等宽、最多 3 列，超过 3 个换行（grid 的 auto-fit 做不到「最多 3 列」，
 *     所以列数由断点显式给到 3）。
 *
 * **整块默认展开，没有折叠**：它是这一轮的结果摘要，不是可以收起来的证据链。
 * 工具行那种折叠是「过程」，点开才看；这里是「结论」，一眼扫过才对。
 * 这也符合用户那句「展开收起只有对话里的工具等相关的」。
 *
 * 点卡片的两种去向（见 turn-files 的 fileOpenTarget）：
 *   · HTML → 内置浏览器（右栏已经有它，本地 HTML 在那里是真正渲染出来的页面）；
 *   · 其余 → 右栏的文件查看器（markdown 默认按渲染显示，可切源码）。
 *
 * 同一个文件被改多次时 chip 上带 ×N：一次重构里同一个文件改五遍是常态，
 * 不标出来会让人以为卡片重复渲染了。
 */

/** chip 上最多显示多少个文件，其余收成「+N」 */
const MAX_CHIPS = 8;

export function TurnFiles({ summary }: { summary: TurnFileSummary }): React.JSX.Element | null {
  const { t } = useTranslation();
  const openFilePanel = useUiStore((s) => s.openFilePanel);
  const openInBrowser = useUiStore((s) => s.openInBrowser);

  if (summary.fileCount === 0) return null;

  const open = (file: TurnFileChange) => {
    if (fileOpenTarget(file.path) === "browser") {
      openInBrowser({ url: toFileUrl(file.absolutePath), title: file.name });
      return;
    }
    openFilePanel(file.absolutePath);
  };

  const chips = summary.files.slice(0, MAX_CHIPS);
  const hidden = summary.fileCount - chips.length;

  return (
    <div className="flex flex-col gap-2 px-2" data-slot="turn-files">
      {/* 标题行：眉题 + 文件数 + 增删合计。与右栏面板标题同一套字号口径（typeEyebrow 的 mono 11px） */}
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(mono, "text-ink-3 shrink-0")}>{t("chat.turnFiles")}</span>
        {summary.additions > 0 && (
          <span className={cn(mono, "shrink-0 text-emerald-600 dark:text-emerald-400")}>
            +{summary.additions}
          </span>
        )}
        {summary.deletions > 0 && (
          <span className={cn(mono, "shrink-0 text-red-600 dark:text-red-400")}>
            −{summary.deletions}
          </span>
        )}
      </div>

      {/*
        chip 行：每个文件一枚，超出 MAX_CHIPS 收成「+N」。
        chip 本身**可点**（与卡片同一个去向）—— 一个 .ts 文件不出卡片，
        但用户仍应该能从这里点开看它，否则「改了哪些代码」就成了一句无法追下去的话。
      */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {chips.map((file) => (
          <FileChip key={file.path} file={file} onClick={() => open(file)} />
        ))}
        {hidden > 0 && (
          <span className={cn(mono, "text-ink-4 shrink-0 px-1")}>
            {t("chat.turnFilesMore", { count: hidden })}
          </span>
        )}
      </div>

      {/*
        卡片区：只有文档类出卡。

        **宽度自适应**：卡片数决定列数（1 张占满、2 张各半、3 张各三分之一），
        而不是固定 3 列 —— 固定列数会让「只有 1 张卡」时右边空出三分之二，
        看起来像没渲染完。超过 3 张才换行（用户明确要求「最多 3 列」）。
        实现用显式列数而不是 auto-fit：auto-fit 在宽屏上会一路铺到五六列，
        卡片里的文件名就窄到读不出来了。
      */}
      {summary.documents.length > 0 && (
        <div
          className={cn(
            "grid gap-2",
            summary.documents.length === 1 && "grid-cols-1",
            summary.documents.length === 2 && "grid-cols-1 sm:grid-cols-2",
            summary.documents.length >= 3 && "grid-cols-1 sm:grid-cols-2 md:grid-cols-3",
          )}
        >
          {summary.documents.map((file) => (
            <FileCard key={file.path} file={file} onOpen={() => open(file)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一行里的文件 chip：图标 + 文件名 + 可选 ×N。
 *
 * 用 `<button>` 而不是 `<span>`：它可点（点开这个文件），而可点的东西必须是按钮 ——
 * 否则键盘与读屏用户根本够不到它。
 */
function FileChip({ file, onClick }: { file: TurnFileChange; onClick: () => void }) {
  const isDocument = file.isDocument;
  const Icon = isDocument ? FileText : Code2;

  return (
    <button
      type="button"
      onClick={onClick}
      title={file.path}
      className={cn(
        mono,
        "flex max-w-64 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5",
        "bg-foreground/[0.06] text-ink-2 transition-colors hover:text-foreground hover:bg-foreground/[0.1]",
        "outline-none focus-visible:ring-1 focus-visible:ring-foreground/20",
      )}
    >
      <Icon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="min-w-0 truncate" dir="ltr">
        {file.name}
      </span>
      {/* 同一文件改多次：不标出来会让人以为这一行重复渲染了 */}
      {file.edits > 1 && <span className="text-ink-4 shrink-0">×{file.edits}</span>}
    </button>
  );
}

/**
 * 一张文档卡片：图标 + 文件名 + 说明行 + 右侧的「打开」按钮。
 *
 * **整张卡是一个 `<button>`**，「打开」是它内部的一个视觉胶囊而**不是**第二个按钮：
 * 按钮里嵌按钮是非法 HTML（React 会警告，浏览器行为也不确定），而做成两个并列按钮
 * 又会多出一个 Tab 停靠点、让读屏用户听到两遍同一件事。整卡可点 + 明确的视觉提示，
 * 既对得上参考图的样子，也只有一个清晰的键盘入口。
 *
 * 说明行是「目录 · +N」：目录先给上下文（同名文件在不同目录下很常见），
 * 增删行数来自补丁（没有补丁的工具就是空串，那一行不占位）。
 */
function FileCard({ file, onOpen }: { file: TurnFileChange; onOpen: () => void }) {
  const { t } = useTranslation();
  const external = fileOpenTarget(file.path) === "browser";

  /** 说明行：目录 + 增删 */
  const detail: string[] = [];
  if (file.directory !== "") detail.push(file.directory);
  if (file.additions > 0) detail.push(`+${file.additions}`);
  if (file.deletions > 0) detail.push(`−${file.deletions}`);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onOpen();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={file.path}
      aria-label={t("chat.turnFileOpen", { name: file.name })}
      className={cn(
        "group/card flex min-w-0 cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left",
        "bg-background border border-border/60 dark:bg-popover",
        "transition-colors hover:bg-accent outline-none focus-visible:ring-1 focus-visible:ring-foreground/20",
      )}
    >
      <span className="bg-foreground/[0.05] text-ink-3 flex size-8 shrink-0 items-center justify-center rounded-lg">
        <FileText className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground min-w-0 truncate text-[13px]" dir="ltr">
          {file.name}
        </span>
        <span className={cn(mono, "text-ink-4 min-w-0 truncate")} dir="ltr">
          {detail.join(" · ")}
        </span>
      </span>
      {/*
        「打开」：整卡可点的视觉提示。hover 时加深一档，让「这里能点」这件事在鼠标
        移到卡片上时更明确。HTML 多一枚外链图标 —— 它去的是浏览器而不是查看器，
        先说出来免得点完才发现「怎么跳去浏览器了」。
      */}
      <span
        aria-hidden="true"
        className={cn(
          "text-ink-2 flex shrink-0 items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1 text-[12.5px]",
          "transition-colors group-hover/card:border-border group-hover/card:bg-background",
        )}
      >
        {t("chat.turnFileOpenAction")}
        {external && <ExternalLink className="size-3" />}
      </span>
    </button>
  );
}
