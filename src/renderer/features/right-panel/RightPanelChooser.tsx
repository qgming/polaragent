import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";
import { RIGHT_PANEL_VIEWS, useUiStore } from "@/renderer/stores/ui-store";
import { RIGHT_PANEL_VIEW_META } from "./panel-meta";

/**
 * 面板的第一屏：五个内容的入口列表（与参考图一致）。
 *
 * 它取代了原来的浮层菜单 —— 选择发生在这里，而不是在弹出的组件里。
 * 打开侧边栏按钮 → 面板展开 → 这一屏出现 → 点一项进入，
 * 是同一块界面上的连续动作，没有第二个浮层要处理。
 *
 * 行高刻意放大（py-3.5，约 48px）：这是面板的主入口列表，不是密集的设置项，
 * 参考图里五行占据了明显的纵向空间，给的是「一眼扫过、好点」的密度。
 */
export function RightPanelChooser(): React.JSX.Element {
  const { t } = useTranslation();
  const openRightPanel = useUiStore((s) => s.openRightPanel);

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col px-2 pt-2">
        {RIGHT_PANEL_VIEWS.map((view) => {
          const meta = RIGHT_PANEL_VIEW_META[view];
          const Icon = meta.icon;

          return (
            <li key={view}>
              <button
                type="button"
                onClick={() => openRightPanel(view)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-3.5 text-left",
                  "text-[14.5px] text-foreground outline-none transition-colors",
                  "hover:bg-accent focus-visible:ring-1 focus-visible:ring-foreground/20",
                )}
              >
                <Icon className="text-ink-2 size-[18px] shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t(meta.labelKey)}</span>
                {/* 快捷键提示：只给真有快捷键的那两项，其余留白 ——
                    给每一项都画一个空胶囊会变成噪声 */}
                {meta.shortcut !== undefined && <ShortcutHint letter={meta.shortcut} />}
              </button>
            </li>
          );
        })}
      </ul>
      {/* 一句话说清多开的规则：浏览器每次从这里打开都是新标签（多开是特性），
          其余视图再点一次只是切回已有标签。不说的话，「怎么开了两个浏览器」和
          「为什么文件只开了一个」都会变成困惑 */}
      <p className="px-4 pt-2 text-[11.5px] leading-relaxed text-ink-4">
        {t("rightPanel.chooserHint")}
      </p>
    </div>
  );
}

/**
 * 快捷键提示（参考图右侧那种胶囊）。
 *
 * 前缀按平台给：macOS 用 ⌘、其余用 Ctrl —— 全局快捷键判定本来就同时认 Ctrl 与 Cmd
 *（见 useGlobalShortcuts 的 matchesModifier），提示照着实际生效的键显示。
 * 用 navigator.platform 判断：window.oint 没有暴露平台信息，为一行提示新增一条 IPC 不值得。
 */
function ShortcutHint({ letter }: { letter: string }): React.JSX.Element {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <kbd
      className={cn(
        "shrink-0 rounded-md border border-border/60 px-1.5 py-0.5",
        "font-mono text-[11px] leading-none text-ink-4",
      )}
    >
      {isMac ? `⌘${letter}` : `Ctrl+${letter}`}
    </kbd>
  );
}
