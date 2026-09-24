import { FolderOpen, Play, RefreshCw, Share2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { ScrollArea } from "@/renderer/components/ui/scroll-area";
import { Switch } from "@/renderer/components/ui/switch";
import { cn } from "@/renderer/lib/utils";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import {
  hookFailsClosed,
  type PluginPermissionView,
  type PluginState,
  type PluginSurfaceInfo,
  type PluginView,
} from "@/shared/contracts/plugin";
import {
  CONTRIBUTION_NAME_ROWS,
  contributionChips,
  isPermissionEnforced,
  permissionLabelKey,
  riskChipClass,
  sortPermissions,
} from "./plugin-permissions";

/**
 * 界面形态 → 文案键。
 *
 * 一张**字面量表**而不是三元链：加第三种形态时，三元链不会报错 —— 它会把模态窗
 * 静默显示成"窗口"；而表驱动 + `Record<PluginSurfaceInfo["kind"], …>` 会在漏项时
 * 直接编译失败。（与 plugin-permissions.ts 里那两张表同一条纪律。）
 */
const SURFACE_KIND_LABEL: Readonly<Record<PluginSurfaceInfo["kind"], string>> = {
  panel: "plugins.surfacePanel",
  modal: "plugins.surfaceModal",
  window: "plugins.surfaceWindow",
};

/**
 * 插件详情模态窗：**卡片是索引，这里是档案**。
 *
 * ## 为什么把详情单独拿出来
 *
 * 卡片只有 272×204，装不下描述全文、完整权限（带范围）、界面清单与全部操作。
 * 硬塞的后果是**每一样都只剩半截** —— 描述截两行、权限裁到两枚、操作挤进菜单，
 * 而用户最想知道的那件事（"它到底要什么权限"）恰好被裁得最狠。
 *
 * 分层的收益是两边都变清楚了：卡片只负责"扫一眼、认出它、开关它"，
 * 详情负责"读清楚、做决定"。**索引里塞进档案的内容，两者都会变得难用。**
 *
 * ## 与卡片的分工（刻意重叠的部分）
 *
 * 开关与「打开界面」两处都有 —— 那是**用户最高频的两个动作**，
 * 让它们逼着用户"为了关掉一个插件而点开详情"是不合理的。其余动作只在详情里。
 *
 * ## 尺寸
 *
 * 比主模态窗小一圈（560×auto，最高 80vh）：它是**从**插件管理进去的，
 * 同尺寸会让人分不清自己在哪一层。小一圈 + 无左导航，层级一眼可见。
 */

/** 状态的展示元数据（与卡片同款 —— 两处显示同一个状态，颜色不能不一样） */
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

/** 一段小标题 + 内容。详情里空间够，所以用完整的眉题（与卡片上的紧凑排法不同） */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[10.5px] tracking-wide text-ink-4 uppercase">{label}</h4>
      {children}
    </section>
  );
}

/** 一条权限：**完整形态**。范围在这里必须显示 —— 卡片上放不下才塞进 title 的 */
function PermissionRow({
  permission,
  isNew,
}: {
  permission: PluginPermissionView;
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const labelKey = permissionLabelKey(permission.id);
  const enforced = isPermissionEnforced(permission.id);

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-1.5",
        riskChipClass(permission.risk),
      )}
    >
      <div className="min-w-0 flex-1">
        {/* 表外的权限显示 id 原文 + 一个明确的「未知」标记 */}
        <p className="text-[12px]">
          {labelKey === undefined ? (
            <>
              <span className={mono}>{permission.id}</span>
              <span className="ml-1.5 text-[10.5px] opacity-70">
                {t("plugins.unknownPermission")}
              </span>
            </>
          ) : (
            t(labelKey)
          )}
          {isNew && (
            <span className="ml-1.5 rounded-full bg-current/15 px-1.5 text-[9.5px] font-medium">
              {t("plugins.newPermission")}
            </span>
          )}
          {/*
            「未生效」标记与「新」徽标并列：两者都在限定同一个权限名，但说的是两件事
            （一个说"这次是新加的"，一个说"它今天不管用"），所以各自独立成标。

            没有这枚标记的话，下发权限里那批没有执行点的项（fs.* / hostHooks.register …）
            看起来就是已经在管着的规则 —— 用户据此做"我可以放心装"的判断。
          */}
          {enforced ? null : (
            <span className="ml-1.5 rounded-full bg-current/15 px-1.5 text-[9.5px] font-medium">
              {t("plugins.notEnforced")}
            </span>
          )}
        </p>
        {/* 范围：**挨着权限显示，不单独成行**（与卡片上的口径一致） */}
        {permission.scope !== undefined && permission.scope !== "" && (
          <p className={cn(mono, "mt-0.5 truncate text-[10.5px] opacity-70")}>{permission.scope}</p>
        )}
      </div>
      <span className="shrink-0 text-[10px] opacity-70">
        {t(
          permission.risk === "high"
            ? "plugins.riskHigh"
            : permission.risk === "medium"
              ? "plugins.riskMedium"
              : "plugins.riskLow",
        )}
      </span>
    </div>
  );
}

export function PluginDetailDialog({
  view,
  onClose,
}: {
  view: PluginView | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const busyId = usePluginsStore((s) => s.busyId);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const reload = usePluginsStore((s) => s.reload);
  const uninstall = usePluginsStore((s) => s.uninstall);
  const exportPlugin = usePluginsStore((s) => s.exportPlugin);
  const openSurface = usePluginsStore((s) => s.openSurface);
  const revealData = usePluginsStore((s) => s.revealData);

  // 列表刷新后这个插件可能已经没了（被卸载）：直接不渲染，而不是画一个空壳
  if (view === undefined) return null;

  const busy = busyId === view.id;
  const state = STATE_META[view.state];
  const permissions = sortPermissions(view.permissions);
  const chips = contributionChips(view.contributions);
  const newSet = new Set(view.newlyRequested);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0">
        {/* 头部：名字 + 状态 + 开关（与卡片同款，位置也一样 —— 换一层不该换位置） */}
        <header className="shrink-0 border-border/60 border-b p-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-medium">{view.name}</DialogTitle>
              <DialogDescription className={cn(mono, "mt-1 truncate text-[10.5px] text-ink-4")}>
                {view.id}
              </DialogDescription>
            </div>
            <Switch
              size="sm"
              className="mt-0.5 shrink-0"
              checked={view.enabled}
              disabled={busy}
              aria-label={view.enabled ? t("plugins.disable") : t("plugins.enable")}
              onCheckedChange={(next) => void setEnabled(view.id, next)}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn(mono, "text-[10.5px] text-ink-4")}>{view.version}</span>
            <span className={cn("text-[11px]", state.className)}>{t(state.labelKey)}</span>
            <span className="text-[10.5px] text-ink-4">
              {t(
                view.source === "builtin"
                  ? "plugins.sourceBuiltin"
                  : view.source === "dev"
                    ? "plugins.sourceDev"
                    : "plugins.sourceUser",
              )}
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              {/* 描述全文：卡片上截两行，这里**不截** —— 这正是点进来的理由之一 */}
              {view.description !== "" && (
                <p className="text-[12.5px] leading-relaxed text-ink-2">{view.description}</p>
              )}

              {/* 加载失败 / 崩溃：详情里给全文（卡片上截两行） */}
              {view.error !== undefined && view.error !== "" && (
                <p className="rounded-lg border border-red-600/25 bg-red-600/[0.06] p-2.5 text-[11.5px] break-words whitespace-pre-wrap text-red-600 dark:text-red-400">
                  {view.error}
                </p>
              )}

              <Section label={t("plugins.permissions")}>
                {permissions.length === 0 ? (
                  <p className="text-[12px] text-ink-4">{t("plugins.noPermissions")}</p>
                ) : (
                  <div className="space-y-1.5">
                    {permissions.map((permission) => (
                      <PermissionRow
                        key={permission.id}
                        permission={permission}
                        isNew={newSet.has(permission.id)}
                      />
                    ))}
                  </div>
                )}
                {/* 「未生效」标记的说明：只在真出现这种权限时给，否则是纯噪音 */}
                {permissions.some((permission) => !isPermissionEnforced(permission.id)) && (
                  <p className="text-[11px] leading-relaxed text-ink-4">
                    {t("plugins.notEnforcedHint")}
                  </p>
                )}
                {/*
                  **信任边界：只对带代码的插件说，且必须说。**

                  方案 §4.11 抄的是 PI-Desktop 作者指南最显眼处那句：
                  "It is not yet an operating-system sandbox for raw Node APIs"。
                  不写这句比有这个边界本身更糟 —— 用户会以为"我拒绝了 fs.write，
                  它就写不了文件"，而 T1 插件仍然可以 require("node:fs")。

                  对声明式插件（没有 main）不显示：它们不跑代码，说这一句只会
                  让人以为所有插件都危险。
                */}
                {view.hasMain && (
                  <p className="rounded-lg border border-amber-600/25 bg-amber-600/[0.06] p-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                    {t("plugins.trustBoundary")}
                  </p>
                )}
              </Section>

              {/*
                **钩子逐条列出来。**

                与"贡献物要列名字"同源但更硬：`PreToolUse` 能**拦住工具调用**，
                而用户做"装不装 / 留不留"的判断时必须看见它会介入哪些调用。
                ZCode 的插件详情页也是逐条列钩子的 —— 那是对比里唯一值得照抄的界面细节。

                有效性不由界面判断：钩子会不会真的被调取决于插件进程起没起来，
                那是 state 的事（行上已经显示），与这份声明是两件事。
              */}
              {view.hooks.length > 0 && (
                <Section label={t("plugins.hooks")}>
                  <div className="space-y-1.5">
                    {view.hooks.map((hook) => (
                      <div
                        key={hook.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[11.5px]"
                      >
                        <span className={cn(mono, "text-ink-2")}>{hook.event}</span>
                        <span className={cn(mono, "text-ink-4")}>
                          {hook.matcher ?? t("plugins.hookAllTools")}
                        </span>
                        {hookFailsClosed(hook) && hook.event === "PreToolUse" && (
                          <span className="rounded-full bg-current/15 px-1.5 text-[9.5px] text-ink-3">
                            {t("plugins.hookFailsClosed")}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-4">{t("plugins.hooksDesc")}</p>
                </Section>
              )}

              {chips.length > 0 && (
                <Section label={t("plugins.contributions")}>
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((chip) => (
                      <span
                        key={chip.key}
                        className="rounded-full border border-border/60 px-2 py-0.5 text-[11.5px] text-ink-3"
                      >
                        {t(chip.key)} {chip.count}
                      </span>
                    ))}
                  </div>
                  {/*
                    **名字，不只是个数。**

                    按方案 §4.8 的边界，插件贡献的技能 / 提示 / 子智能体**不进**设置里
                    那三张列表（它们归插件管，用户在那边改不了也删不掉）。于是这里成了
                    唯一能看到它们的地方 —— 只给"技能 2"的话，"这个插件给我带来了什么"
                    在整个产品里就没有答案（而"装了没效果"正是这套界面最该避免的形态）。

                    空的那几类不渲染：一个只贡献技能的插件不该在下面多两行空标题。
                  */}
                  <div className="mt-2 space-y-1">
                    {CONTRIBUTION_NAME_ROWS.map(({ field, labelKey }) => {
                      const names = view.contributionNames[field];
                      if (names.length === 0) return null;
                      return (
                        <p key={field} className="text-[11.5px] leading-relaxed text-ink-3">
                          {t("plugins.contributionNames", {
                            label: t(labelKey),
                            names: names.join(t("plugins.contributionNameSeparator")),
                          })}
                        </p>
                      );
                    })}
                  </div>
                </Section>
              )}

              {/* 界面：这里可以每一个都给一个按钮（卡片上只放得下第一个） */}
              {view.surfaces.length > 0 && (
                <Section label={t("plugins.surfaces")}>
                  <div className="flex flex-wrap gap-1.5">
                    {view.surfaces.map((surface) => (
                      <Button
                        key={surface.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-[11.5px]"
                        onClick={() => {
                          void openSurface(view.id, surface.id);
                          onClose();
                        }}
                      >
                        <Play className="size-3" aria-hidden="true" />
                        {surface.title}
                        <span className="text-[10px] text-ink-4">
                          {t(SURFACE_KIND_LABEL[surface.kind])}
                        </span>
                      </Button>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* 操作栏：卡片上收进菜单的那些，这里**全部摊开**（空间够，就该少一次点击） */}
        <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-border/60 border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[11.5px]"
            disabled={busy}
            onClick={() => void reload(view.id)}
          >
            <RefreshCw className={cn("size-3", busy && "animate-spin")} aria-hidden="true" />
            {t("plugins.reload")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[11.5px]"
            onClick={() => void revealData(view.id)}
          >
            <FolderOpen className="size-3" aria-hidden="true" />
            {t("plugins.revealData")}
          </Button>
          {view.source !== "builtin" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11.5px]"
              disabled={busy}
              onClick={() => void exportPlugin(view.id)}
            >
              <Share2 className="size-3" aria-hidden="true" />
              {t("plugins.share")}
            </Button>
          )}
          {/*
            卸载：**不弹确认框**，理由是这一条可逆的两半都做到了 ——
            文件删掉可以重装，而**数据是保留的**（`keepData: true` 写死在这里）。
            真正不可逆的是"连同数据一起删"，那条路径不在这个界面上。

            `removable: false` 的来源（内置、项目目录）不显示它 ——
            「卸载」在那两处会意味着"删掉你自己的文件"，与它在别处的意思不是一回事。
          */}
          {view.removable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ms-auto h-7 gap-1 text-[11.5px] text-red-600 hover:text-red-600 dark:text-red-400"
              disabled={busy}
              onClick={() => {
                void uninstall(view.id, true);
                onClose();
              }}
            >
              <Trash2 className="size-3" aria-hidden="true" />
              {t("plugins.uninstall")}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
