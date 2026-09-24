import { ChevronRight, MoreHorizontal, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { Switch } from "@/renderer/components/ui/switch";
import { cn } from "@/renderer/lib/utils";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import type { PluginPermissionView, PluginState, PluginView } from "@/shared/contracts/plugin";
import {
  contributionChips,
  permissionLabelKey,
  riskChipClass,
  sortPermissions,
} from "./plugin-permissions";

/**
 * 一个插件 = 一张 **4:3 卡片**。点它打开详情模态窗。
 *
 * ## 高度是硬约束，所以布局按「谁可以被裁」分三段
 *
 * 卡片 272×204（`minmax(240px,1fr)` 三列）。减掉内边距只剩 **180px** 要装下身份、
 * 描述、贡献物、权限与操作 —— 装不下。所以三段各有明确的压缩规则：
 *
 *  1. **头部 `shrink-0`**：名字 / 徽章 / 状态 / 开关。永远完整。
 *  2. **中部 `min-h-0 flex-1 overflow-hidden`**：描述与两组摘要。**可以被裁** ——
 *     描述截两行、贡献物折成一行文字、权限只留两枚 + `+N`。
 *  3. **底部 `shrink-0`**：操作。**永远完整**。
 *
 * 这个分工是踩过坑之后定下来的：早先三段都是自然高度 + 整卡 `overflow-hidden`，
 * 结果权限多的时候**底部操作栏被裁成一条边**（截图里就是那样）——
 * 一个点不到的按钮比没有按钮更糟。现在被牺牲的永远是中部，而不是操作。
 *
 * ## 为什么贡献物是文字、权限是 chip
 *
 * 贡献物（"技能 2 · 面板 1"）用文字：它是一句摘要，chip 的边框在这里只是噪音，
 * 而且 chip 会换行吃掉一整行。
 *
 * 权限用 chip：**颜色是它的全部意义** —— 高风险红、中黄、低灰，扫一眼就知道
 * 这个插件要得凶不凶。"启用前先看一眼它要什么"是这套设计反复强调的那件事，
 * 所以它拿到卡片上最"贵"的那块位置。
 *
 * ## 详情去哪了
 *
 * 描述全文、完整权限（带范围）、界面清单、全部操作 —— 都在详情模态窗里（点卡片打开）。
 * 卡片是**索引**，详情是**档案**：索引里塞进档案的内容，两者都会变得难用。
 */

/** 状态的展示元数据：文案键 + 颜色 */
const STATE_META: Record<PluginState, { labelKey: string; className: string }> = {
  disabled: { labelKey: "plugins.state.disabled", className: "text-ink-4" },
  loading: { labelKey: "plugins.state.loading", className: "text-ink-3" },
  running: {
    labelKey: "plugins.state.running",
    className: "text-emerald-600 dark:text-emerald-400",
  },
  load_error: { labelKey: "plugins.state.loadError", className: "text-red-600 dark:text-red-400" },
  invalid: { labelKey: "plugins.state.invalid", className: "text-red-600 dark:text-red-400" },
  crashed: { labelKey: "plugins.state.crashed", className: "text-red-600 dark:text-red-400" },
};

/** 卡片上最多摆几枚权限 chip。**两枚**是 272px 里一行放得下的数量，第三枚必然换行 */
const MAX_PERMISSION_CHIPS = 2;

/**
 * 来源徽标。**只在需要区分时出现** —— 用户页签里默认全是用户装的，
 * 给默认情况挂徽标只是噪音。
 *
 * `dev` 是例外且必须标：开发插件（目录引用）**卸载不删文件**，
 * 而用户面对"卸载"会以为自己的代码要没了。
 */
function SourceBadge({ source }: { source: PluginView["source"] }) {
  const { t } = useTranslation();
  if (source === "builtin") {
    return (
      <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9.5px] text-ink-4">
        {t("plugins.sourceBuiltin")}
      </span>
    );
  }
  if (source === "dev") {
    return (
      <span className="shrink-0 rounded-full border border-amber-600/30 px-1.5 py-px text-[9.5px] text-amber-600 dark:text-amber-400">
        {t("plugins.sourceDev")}
      </span>
    );
  }
  return null;
}

/** 权限 chip。**定宽 + truncate**，所以"两枚一定排得下"是可以推理的，而不是碰运气 */
function PermissionChip({
  id,
  risk,
  isNew,
}: {
  id: string;
  risk: PluginPermissionView["risk"];
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const labelKey = permissionLabelKey(id);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-[7.5rem] items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px]",
        riskChipClass(risk),
      )}
    >
      {/* 表外的权限显示 id 原文 —— 一个不认识的权限比一片空白有用得多 */}
      <span className="truncate">{labelKey === undefined ? id : t(labelKey)}</span>
      {isNew && (
        <span className="shrink-0 rounded-full bg-current/15 px-1 text-[9px] font-medium">
          {t("plugins.newPermission")}
        </span>
      )}
    </span>
  );
}

/** 一行「标签 + 内容」。卡片上两组摘要共用它，靠它把行高压到最小 */
function SummaryLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[9.5px] text-ink-4">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{children}</span>
    </div>
  );
}

export function PluginCard({ view, onOpenDetail }: { view: PluginView; onOpenDetail: () => void }) {
  const { t } = useTranslation();
  const busyId = usePluginsStore((s) => s.busyId);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const reload = usePluginsStore((s) => s.reload);
  const openSurface = usePluginsStore((s) => s.openSurface);

  const busy = busyId === view.id;
  const state = STATE_META[view.state];
  const chips = contributionChips(view.contributions);
  // 按风险从高到低：被裁掉的是低风险的，而不是随便哪几个
  const permissions = sortPermissions(view.permissions);
  const shownPermissions = permissions.slice(0, MAX_PERMISSION_CHIPS);
  const hidden = permissions.length - shownPermissions.length;
  const newSet = new Set(view.newlyRequested);
  const failed =
    view.state === "invalid" || view.state === "load_error" || view.state === "crashed";
  /** 首要操作：有界面就打开界面，没有就重载 —— 一张卡片总得有个能点的主按钮 */
  const primary = view.surfaces[0];

  return (
    <article
      className={cn(
        "flex aspect-[4/3] flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-colors",
        "hover:border-border",
        // 出错的那张整卡染一点红：一屏扫下来就知道该先处理哪几张
        failed && "border-red-600/25",
      )}
    >
      {/* ── ① 头部（固定）：名字 / 徽章 / 版本 / 状态 / 开关 ─────────────────── */}
      <div className="flex shrink-0 items-start gap-2 p-3 pb-2">
        <button
          type="button"
          onClick={onOpenDetail}
          className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
        >
          <h3 className="truncate text-[13px] leading-tight font-medium">{view.name}</h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
            <SourceBadge source={view.source} />
            <span className={cn(mono, "shrink-0 text-[9.5px] text-ink-4")}>{view.version}</span>
            <span className={cn("shrink-0 text-[10.5px]", state.className)}>
              {t(state.labelKey)}
            </span>
          </div>
        </button>
        {/* 开关**不在按钮内** —— button 里嵌 switch 是无效的交互结构 */}
        <Switch
          size="sm"
          className="mt-0.5 shrink-0"
          checked={view.enabled}
          disabled={busy}
          aria-label={view.enabled ? t("plugins.disable") : t("plugins.enable")}
          onCheckedChange={(next) => void setEnabled(view.id, next)}
        />
      </div>

      {/* ── ② 中部（可裁）：描述 / 错误 / 两组摘要。底部用 mt-auto 顶到贴近操作栏 ── */}
      <button
        type="button"
        onClick={onOpenDetail}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-3 pb-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
      >
        {view.description !== "" && (
          <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">{view.description}</p>
        )}

        {/*
          错误就地显示（**截两行**）：一张卡片的高度是硬约束，一段长堆栈会把下面
          整个挤出可视区。留两行够看出是哪一类问题，细节点开详情看。
        */}
        {view.error !== undefined && view.error !== "" && (
          <p className="line-clamp-2 rounded-md border border-red-600/25 bg-red-600/[0.06] px-1.5 py-1 text-[10.5px] break-words whitespace-pre-wrap text-red-600 dark:text-red-400">
            {view.error}
          </p>
        )}

        <div className="mt-auto space-y-1">
          {/* id 只在没有摘要时露出来：它是排障用的，不该与权限抢位置 */}
          {chips.length === 0 && permissions.length === 0 && (
            <p className={cn(mono, "truncate text-[9.5px] text-ink-4")}>{view.id}</p>
          )}

          {chips.length > 0 && (
            <SummaryLine label={t("plugins.contributions")}>
              <span className="truncate text-[10.5px] text-ink-3">
                {chips.map((chip) => `${t(chip.key)} ${chip.count}`).join(" · ")}
              </span>
            </SummaryLine>
          )}

          <SummaryLine label={t("plugins.permissions")}>
            {permissions.length === 0 ? (
              <span className="truncate text-[10.5px] text-ink-4">
                {t("plugins.noPermissions")}
              </span>
            ) : (
              <>
                {shownPermissions.map((perm) => (
                  <PermissionChip
                    key={perm.id}
                    id={perm.id}
                    risk={perm.risk}
                    isNew={newSet.has(perm.id)}
                  />
                ))}
                {hidden > 0 && <span className="shrink-0 text-[10.5px] text-ink-4">+{hidden}</span>}
              </>
            )}
          </SummaryLine>
        </div>
      </button>

      {/* ── ③ 底部（固定）：一个主按钮 + 「更多」菜单 + 进详情的箭头 ───────────── */}
      <div className="flex shrink-0 items-center gap-1 border-border/60 border-t px-3 py-2">
        {primary !== undefined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 min-w-0 flex-1 gap-1 px-2 text-[11px]"
            onClick={() => void openSurface(view.id, primary.id)}
          >
            <Play className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{primary.title}</span>
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 min-w-0 flex-1 gap-1 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void reload(view.id)}
          >
            <RefreshCw
              className={cn("size-3 shrink-0", busy && "animate-spin")}
              aria-hidden="true"
            />
            <span className="truncate">{t("plugins.reload")}</span>
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-6 shrink-0 p-0"
              aria-label={t("plugins.moreActions")}
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onOpenDetail}>
              <ChevronRight className="size-3.5" aria-hidden="true" />
              {t("plugins.detail")}
            </DropdownMenuItem>
            {view.surfaces.slice(1).map((surface) => (
              <DropdownMenuItem
                key={surface.id}
                onSelect={() => void openSurface(view.id, surface.id)}
              >
                <Play className="size-3.5" aria-hidden="true" />
                {surface.title}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem disabled={busy} onSelect={() => void reload(view.id)}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t("plugins.reload")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
