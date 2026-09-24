// 插件模态窗的宿主：一个 `<webview>` 装在一个 Radix Dialog 里。
//
// ## 与面板宿主的关系：容器不同，内容完全一样
//
// webview 那一层**复用 `PluginSurfacePanel`** —— 分区、桥、骨架屏、失败态都在那里，
// 而它不关心自己是被谁装着的。所以这个文件只做三件事：
//   1. 从 `plugins:list` 的结果里**现查**要开的那份界面描述（url 与 partition 由主进程算好）；
//   2. 用 Dialog 装它，尺寸取清单里的 `width` / `height`；
//   3. 插件被停用 / 卸载 / 界面不再声明时把自己收掉。
//
// ## 为什么"现查 + 查不到就收"而不是把描述存在状态里
//
// ui-store 只存 `pluginId + surfaceId`（见 PluginModalTarget 的说明）。插件被停用时，
// 主进程确实会摘掉界面归属，但**渲染层的模态窗状态它管不着** —— 那是我们自己的 React 状态。
// 现查一次，恰好让"插件停了""界面删了""清单变坏了"这三种情况都表现为**自己收掉**，
// 而不必再补一条"插件被停用"的事件通道。
//
// ## 键盘交互上的一条实情
//
// Escape 由 Radix 处理，而**焦点进了 `<webview>` 之后按键到不了对话框**（guest 自己吞掉）。
// 所以保证可用的是另外两条路：右上角的关闭按钮、点遮罩关闭。插件页面自己也有一条
// （`window.oint.close()`），它靠主进程的 `plugins:surfaceClosed` 事件回到这里。

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { cn } from "@/renderer/lib/utils";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { PluginSurfacePanel } from "./PluginSurfacePanel";

/**
 * 清单没给尺寸时的默认值。
 *
 * 与设置 / 插件管理两个字模态窗**不同尺寸**：那两个是"管理"（列表、要宽），
 * 这个是插件自己的界面，尺寸由插件说。给一个不比主界面小的默认值，
 * 免得插件作者什么都没写时看到一个局促的框。
 */
const MODAL_DEFAULT = { width: 760, height: 600 };

/**
 * 已打开的那个插件模态窗；没有打开时渲染 `null`。
 *
 * 挂在 App 根部（与 SettingsModal / PluginsModal 并列）：模态窗是浮层，
 * 不该受侧栏或主区的溢出裁剪影响。
 */
export function PluginSurfaceModal(): React.JSX.Element | null {
  const { t } = useTranslation();
  const target = useUiStore((s) => s.pluginModal);
  const closePluginModal = useUiStore((s) => s.closePluginModal);
  const views = usePluginsStore((s) => s.views);
  const unavailable = usePluginsStore((s) => s.unavailable);

  const view =
    target === null ? undefined : (views ?? []).find((item) => item.id === target.pluginId);
  const surface = view?.surfaces.find((item) => item.id === target?.surfaceId);

  /*
    可用的判据是**三个条件**：找到插件、它启用着、它真的声明了这个界面。
    `enabled` 必须显式判 —— 被停用的插件仍然留在列表里（界面要显示它、还要能再启用），
    只是它的界面不该继续开着。
  */
  const usable = view?.enabled === true && surface !== undefined;

  /*
    **"查不到"要分两种**，这是踩过的一次：

      · `views === null`（还没加载）或 `unavailable` 非空（这次 IPC 读不到）——
        那是**"还不知道"**，不是"没有"。这时收掉模态窗，症状是用户点了「打开界面」之后
        对话框一闪而过（探针实测到过：openSurface 明明返回了 modal，DOM 里却没有对话框）；
      · 列表已经加载出来了，而里面没有这个插件 / 插件被停用 / 界面不再声明 ——
        那才是真的没了，该收掉。

    与之配套的是 effect 里的条件：**只有"确定了没有"才关**。
  */
  const decided = views !== null && unavailable === null;
  const gone = decided && !usable;

  /*
    该收就收。
    放在 effect 里而不是渲染期直接 `close()`：渲染期改另一个 store 的状态是 React 的禁忌
    （会触发"渲染中更新"警告，且在并发模式下行为未定义）。这里只把结果落到下一次提交。
  */
  useEffect(() => {
    if (target !== null && gone) closePluginModal();
  }, [target, gone, closePluginModal]);

  if (target === null || view === undefined || surface === undefined || !usable) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && closePluginModal()}>
      <DialogContent
        /*
          尺寸取清单：`width` / `height` 对模态窗就是对话框尺寸（见 PluginSurfaceDecl 的说明）。
          兜底用 max-h / max-w 把窗口小的情形护住 —— 插件写 2000px 高也不该超出屏幕。
        */
        style={{
          width: surface.width ?? MODAL_DEFAULT.width,
          height: surface.height ?? MODAL_DEFAULT.height,
        }}
        className="flex max-h-[86vh] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]"
      >
        <header className="shrink-0 border-border/60 border-b px-5 pt-4 pb-3">
          {/*
            标题直接取清单里那个**已经双语**的 `title`（主进程按当前语言解析过），
            不在宿主的语言包里再写一份 —— 插件文案不能进宿主语言包是约束 D 定的。
          */}
          <DialogTitle className={cn("text-[13.5px] font-semibold text-foreground")}>
            {surface.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("plugins.surfaceModalDescription", { plugin: view.name })}
          </DialogDescription>
        </header>

        {/* 内容区就是那份共用的 webview 宿主（它自带 loading / failed 两种骨架） */}
        <PluginSurfacePanel surface={surface} />
      </DialogContent>
    </Dialog>
  );
}
