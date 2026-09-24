import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { ScrollArea } from "@/renderer/components/ui/scroll-area";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { AddButton, Segmented } from "@/renderer/features/settings/settings-shared";
import { cn } from "@/renderer/lib/utils";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import { type PluginSourceTab, useUiStore } from "@/renderer/stores/ui-store";
import type { PluginDiagnostic, PluginSource, PluginView } from "@/shared/contracts/plugin";
import { PluginCard } from "../PluginCard";
import { PluginDetailDialog } from "../PluginDetailDialog";

/**
 * 插件管理面板：**系统 / 用户两页签 + 一份诊断**。
 *
 * ## 布局：固定的工具条 + 自己滚动的列表
 *
 * 面板占满模态窗内容区（`flex-1 min-h-0`），工具条 `shrink-0` 钉在顶部，只有列表滚。
 * 两件事因此成立：
 *  - 切来源不用先滚回顶部（工具条不会跟着滚走）；
 *  - 错误提示与空态在**同一块固定区域**里，不会被长列表推到看不见的地方。
 *
 * ## 为什么来源是页签而不是左导航
 *
 * 原先左导航是 已安装 / 开发 / 来源 / 诊断 四项，而「开发」与「已安装」内容高度重叠
 * —— 同一个开发插件在两栏里都会出现（旧 DevPanel 的注释自己写了这一点）。
 * 一个东西出现在两个地方，用户就要先想"我该去哪一栏找它"。
 *
 * 现在来源只有**系统**（随包分发，可停用不可删除）与**用户**（装的 + 挂的），
 * 与技能 / 子智能体 / 魔法提示 / MCP 四个面板的既有口径一致 —— 不发明第三套分组语言。
 *
 * 「看哪一类」是**筛选**，「进哪一栏」是**导航**，两者不是一回事。只剩两个来源时，
 * 用页签表达前者、去掉后者，面板就少掉一层没有信息量的层级。
 *
 * ## 开发插件的差别落在**行上**，不落在导航上
 *
 * 开发插件（目录引用）与装进来的包在三件事上行为不同：不进 `plugins/installed/`、
 * **卸载不删文件**、带文件监视。这三条影响的是"卸载会不会删掉我的代码"，
 * 那是**某一行的属性**，所以用行上的徽章表达（见 PluginRow 的 dev 徽章）。
 */

function ListSkeleton() {
  return (
    <div className="space-y-2 px-5 pb-5">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-16 rounded-xl" />
      ))}
    </div>
  );
}

/**
 * 一条诊断。
 *
 * 与行内错误的分工：行内只显示**当前**这一行的状态（「它现在为什么没跑起来」），
 * 这里显示**历史**（「它以前出过什么事」）。一个插件反复崩溃时，行内只能看到最后一次，
 * 而诊断里能看到「崩了 5 次」这个模式。
 */
function DiagnosticLine({ item }: { item: PluginDiagnostic }) {
  const { t, i18n } = useTranslation();
  const at = new Date(item.at);
  // 只到分钟：秒级精度对排障没有帮助，反而让每一行更长
  const stamp = `${at.toLocaleDateString(i18n.language)} ${at.toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 p-2">
      <span
        className={cn(
          "mt-0.5 size-1.5 shrink-0 rounded-full",
          item.level === "error" ? "bg-red-500/70" : "bg-amber-500/70",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(mono, "shrink-0 text-[10.5px] text-ink-4")}>{stamp}</span>
          <span className={cn(mono, "shrink-0 text-[10.5px] text-ink-3")}>{item.event}</span>
          <span className={cn(mono, "truncate text-[10.5px] text-ink-4")}>{item.pluginId}</span>
        </div>
        <p className="mt-0.5 break-words text-[11.5px] text-ink-3">{item.message}</p>
      </div>
      <span className="sr-only">
        {item.level === "error" ? t("plugins.levelError") : t("plugins.levelWarn")}
      </span>
    </div>
  );
}

/** 列表为空时的说明块 */
function EmptyBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 p-6 text-center">
      <p className="text-[13px] text-ink-3">{title}</p>
      <p className="mt-1 text-xs text-ink-4">{hint}</p>
      {children}
    </div>
  );
}

export function PluginsPanel() {
  const { t } = useTranslation();
  const tab = useUiStore((s) => s.pluginsSource);
  const openPlugins = useUiStore((s) => s.openPlugins);
  const views = usePluginsStore((s) => s.views);
  const unavailable = usePluginsStore((s) => s.unavailable);
  const error = usePluginsStore((s) => s.error);
  const notice = usePluginsStore((s) => s.notice);
  const diagnostics = usePluginsStore((s) => s.diagnostics);
  const load = usePluginsStore((s) => s.load);
  const loadDiagnostics = usePluginsStore((s) => s.loadDiagnostics);
  const clearError = usePluginsStore((s) => s.clearError);
  /*
    详情打开的是**哪一个插件**。
    存 id 而不是存 PluginView：列表刷新后对象会换一个新的，存对象就会显示旧快照
    （启停之后详情里的状态不变 —— 那种"详情和卡片说的不一样"最难查）。
  */
  const [detailId, setDetailId] = useState<string | null>(null);

  /*
    面板挂载时拉一次。**每次打开都会重扫磁盘**（见 ipc/plugins.ts 的 list）——
    这正是"把插件放进目录、打开插件管理就能看见"的实现处。

    刻意不订阅推送：列表的变化都由本面板自己的操作触发，而每次操作已经返回了完整列表 ——
    再挂一条推送通道只是多一条会不同步的路。
  */
  useEffect(() => {
    void load();
    void loadDiagnostics();
  }, [load, loadDiagnostics]);

  // builtin 进系统页签；user 与 dev 一起进用户页签（都是用户自己挂的）
  const filter: PluginSource[] = tab === "system" ? ["builtin"] : ["user", "dev"];
  const shown = views === null ? [] : views.filter((view) => filter.includes(view.source));
  const user = tab === "user";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 固定区：工具条 + 提示条。不随列表滚动 ───────────────────────────── */}
      <div className="shrink-0 space-y-2 px-5 py-3">
        <div className="flex min-h-8 items-center gap-3">
          <Segmented<PluginSourceTab>
            ariaLabel={t("plugins.title")}
            value={tab}
            onChange={openPlugins}
            options={[
              { value: "system", label: t("plugins.tabSystem") },
              { value: "user", label: t("plugins.tabUser") },
            ]}
          />
          <span className="text-xs text-ink-4 tabular-nums">
            {t("plugins.countLabel", { n: shown.length })}
          </span>
          {/* 装东西的两个入口只在用户页签出现：系统页签是随包分发的 */}
          <div className="ms-auto flex items-center gap-2">
            {user && (
              <>
                <AddButton
                  label={t("plugins.installPackage")}
                  onClick={() => usePluginsStore.getState().install()}
                />
                <AddButton
                  label={t("plugins.loadDev")}
                  onClick={() => usePluginsStore.getState().loadDev()}
                />
              </>
            )}
          </div>
        </div>

        {/* 上一次操作的失败：就地一条，点掉即收（与压缩失败提示同款） */}
        {error !== null && (
          <button
            type="button"
            onClick={clearError}
            className="w-full rounded-lg border border-red-600/25 bg-red-600/[0.06] p-2 text-left text-[11.5px] text-red-600 dark:text-red-400"
          >
            {error}
          </button>
        )}

        {/*
          导出等操作的**中性提示**（"排除了 node_modules"之类）。
          与上面那条分开：它不是失败，用红字显示会让用户以为自己搞坏了什么。
        */}
        {notice !== null && (
          <button
            type="button"
            onClick={clearError}
            className="w-full rounded-lg border border-border/60 bg-foreground/[0.03] p-2 text-left text-[11.5px] text-ink-3"
          >
            {notice}
          </button>
        )}
      </div>

      {/* ── 滚动区：列表 + 诊断 ─────────────────────────────────────────────── */}
      {views === null ? (
        <ListSkeleton />
      ) : (
        /* 与设置模态同款：外层 flex-1 定高，ScrollArea 自己 h-full（滚动条样式统一） */
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="px-5 pb-5">
              {shown.length === 0 ? (
                user ? (
                  <EmptyBlock title={t("plugins.empty")} hint={t("plugins.emptyHint")}>
                    {/* 读不到时**不隐藏入口**：按钮点了会给出主进程写的可读原因 */}
                    {unavailable !== null && (
                      <p className="mt-3 text-[11px] text-ink-4">
                        {t("plugins.unavailable")}：{unavailable}
                      </p>
                    )}
                    {/* 市场尚未实现：**明说**，而不是放一个点了没反应的入口 */}
                    <p className="mt-3 text-[11px] text-ink-4">{t("plugins.sourcesPendingHint")}</p>
                  </EmptyBlock>
                ) : (
                  <EmptyBlock
                    title={t("plugins.systemEmpty")}
                    hint={t("plugins.systemEmptyHint")}
                  />
                )
              ) : (
                /*
                  自适应网格：`auto-fill` + `minmax(240px,1fr)` 在 840px 内容宽下落在 3 列，
                  窗口变窄时自动降到 2 列 / 1 列 —— **不写断点**。
                  卡片自己是 `aspect-[4/3]`，所以每张一样大，网格才"能比"。
                */
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                  {shown.map((view: PluginView) => (
                    <PluginCard
                      key={view.id}
                      view={view}
                      onOpenDetail={() => setDetailId(view.id)}
                    />
                  ))}
                </div>
              )}

              {/*
            诊断：**有内容才显示**（见文件头）。空的时候整块不出现，
            而不是画一个"暂无诊断"的框 —— 那对一个一切正常的用户是纯噪声。
          */}
              {diagnostics !== null && diagnostics.length > 0 && (
                <div className="mt-4 space-y-1.5">
                  <div className="flex items-center justify-between px-0.5">
                    <span className={cn(mono, "text-[10.5px] tracking-wide text-ink-4 uppercase")}>
                      {t("plugins.sectionDiagnostics")}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadDiagnostics()}
                      className="rounded-full px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:text-ink-2"
                    >
                      {t("plugins.refresh")}
                    </button>
                  </div>
                  {diagnostics.map((item) => (
                    <DiagnosticLine key={item.seq} item={item} />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* 详情弹窗：**从列表里按 id 现取**（见上面 detailId 的说明） */}
      <PluginDetailDialog
        view={shown.find((item) => item.id === detailId)}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}
