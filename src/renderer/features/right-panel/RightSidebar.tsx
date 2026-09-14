import { ArrowLeft, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/renderer/app/WindowControls";
import { Button } from "@/renderer/components/ui/button";
import { type RightPanelView, useUiStore } from "@/renderer/stores/ui-store";
import { BrowserPanel } from "./BrowserPanel";
import { FilesPanel } from "./FilesPanel";
import { RIGHT_PANEL_VIEW_META } from "./panel-meta";
import { ReviewPanel } from "./ReviewPanel";
import { RightPanelChooser } from "./RightPanelChooser";
import { SideChatPanel } from "./SideChatPanel";
import { TerminalPanel } from "./TerminalPanel";
/**
 * 右侧栏本体：内容区顶栏那颗按钮开出来的面板。
 *
 * 三屏结构（都在这一块界面内，没有第二层浮层）：
 *   1. **选择列表**（rightPanelView === null）—— 审查 / 文件 / 侧边聊天 / 浏览器 / 终端；
 *   2. **某个面板** —— 点第一屏的一项进入，标题左侧是「返回」（回到选择列表）；
 *   3. **收起** —— 只由内容区顶栏那颗右侧栏开关负责（面板内没有收起按钮）。
 * 收起时视图退回 null，所以再次打开总是落在第一屏（见 ui-store 的 closeRightPanel）。
 *
 * 顶行右侧放窗口控制（最小化 / 最大化 / 关闭）：面板展开时它们从内容区顶栏挪过来，
 * 于是「窗口控制永远在窗口右上角」这件事保持成立（见 TitleBar 的对应判断）。
 *
 * 形态与左侧栏（SidebarShell）逐条对齐，保证开合行为一致：
 *   · 只有「展开 / 完全隐藏」两态，没有窄轨道；
 *   · 收起时宽度收到 0，内层锁死展开宽度、内容被左边缘剪掉（不是重排挤压）；
 *   · 收起期间整棵子树 `inert`：宽度 0 + 剪裁只是视觉上不可见，
 *     里面的按钮仍会被 Tab 命中、仍进辅助技术树。
 *
 * 视图本体按 rightPanelView 挂载（切走就卸载）：五个面板各有互斥的重活
 *（文件树请求、webview 页面、xterm 实例），同时留着只会白占内存，
 * 而每个面板的重建成本都很低（终端有主进程的回放缓冲兜底，切回来能补齐输出）。
 *
 * 一个例外：**模型要用浏览器时，这里负责把右侧栏展开并切到「浏览器」**（见 useEffect）。
 * guest 由 BrowserPanel 的 webview 元素创建，面板不挂载就没有可自动化的页面 ——
 * 所以「模型想打开一个网址」这件事必须能自己把面板叫出来，否则模型每次都得先求你
 * 手动打开面板，而人会觉得「这工具怎么连这个都要我动手」。
 * 收起状态也照样展开：这是有意的（模型主动要用），且是幂等的，重复请求不会反复重渲染。
 */
export function RightSidebar(): React.JSX.Element {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.rightPanelOpen);
  const view = useUiStore((s) => s.rightPanelView);
  const showRightPanelChooser = useUiStore((s) => s.showRightPanelChooser);

  // 还没选视图时显示选择列表：这时头部没有具体图标，用面板自己的图标占位
  const meta = view === null ? null : RIGHT_PANEL_VIEW_META[view];

  // 模型要用浏览器：把右侧栏展开并切到「浏览器」视图。
  //
  // **与第一版的行为差异**：原先只在面板已经展开时切视图，收起状态不动它。
  // 现在模型可以自己把面板叫出来 —— 否则每次浏览器任务的第一个动作都是
  // 「请你手动打开右侧面板」，而模型并没有别的办法完成用户的要求。
  // 人的感受是「面板自己出现了」，这正是主流 agent 工具的行为。
  //
  // 主进程那一侧会**反复发这个请求**直到 guest 就绪（见 browser/service.ts 的
  // requireGuest）：所以这里做成幂等 —— 已经是「展开 + 浏览器」时不再写 store，
  // 避免每 50ms 触发一次重渲染。
  useEffect(() => {
    return window.oint.browser.onEvent((event) => {
      if (event.type !== "open-request") return;
      const ui = useUiStore.getState();
      if (ui.rightPanelOpen && ui.rightPanelView === "browser") return;
      ui.openRightPanel("browser");
    });
  }, []);

  return (
    <aside
      inert={!open}
      aria-label={t("rightPanel.title")}
      className="shrink-0 overflow-hidden bg-background transition-[width] duration-200 motion-reduce:transition-none"
      style={{ width: open ? "var(--layout-right-sidebar-width)" : "0px" }}
    >
      {/* 内层锁死展开宽度：折叠动画期间内容不跟着挤压重排，只是被左边缘剪掉（含那条左边框） */}
      <div
        className="flex h-full flex-col border-l border-border/60"
        style={{ width: "var(--layout-right-sidebar-width)" }}
      >
        {/*
          头部：返回（仅在看某个面板时）+ 视图名 + 窗口控制。

          三件事要说清：
          1. **没有「收起面板」按钮**。开合只由顶栏那颗右侧栏开关负责 ——
             同一个动作有两个入口时，人会在两处之间犹豫；
             而那颗开关本来就一直在屏幕上（不像 × 只在面板展开时存在）。
          2. 「返回」与「收起」是不同意图：返回回到五个入口的选择列表、
             面板保持展开；这里没有收起。所以两者不会互相替代。
          3. 窗口控制（最小化 / 最大化 / 关闭）在面板展开时挪到这里的最右端，
             与内容区顶栏同一行的右端对齐；展开期间顶栏那套不再渲染
             （见 TitleBar），屏幕上始终只有一套。

          整行是窗口拖拽区：侧边栏占满整窗高度，它的顶行也被拖拽区覆盖，
          这样「从右侧栏顶上拖窗口」与「从顶栏拖」是一致的。
        */}
        <div
          className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/60 pr-2 pl-3"
          data-electron-drag-region
        >
          {meta === null ? (
            <PanelRight className="text-ink-3 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.back")}
              title={t("rightPanel.back")}
              onClick={showRightPanelChooser}
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {meta === null ? t("rightPanel.title") : t(meta.labelKey)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <WindowControls />
          </div>
        </div>

        {/* 内容区：填满剩余高度。每个面板自己管内部滚动（有的是整块滚动、有的是分栏），
            所以这里只给 min-h-0 的容器，不加 overflow —— 加了会把面板内部的吸顶元素一起滚走。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          {view === null ? <RightPanelChooser /> : <RightPanelViewHost view={view} />}
        </div>
      </div>
    </aside>
  );
}

/**
 * 视图分发表。
 *
 * 单独一个组件而不是在 RightSidebar 里写 switch：五个面板各自的 props 与数据源都不同，
 * 放在同一处会让主壳变成一个什么都懂的巨型函数。
 */
function RightPanelViewHost({ view }: { view: RightPanelView }): React.JSX.Element {
  // 浏览器面板一旦打开过就**常驻**：切到别的视图时用 CSS 隐藏，而不是卸载它。
  //
  // 为什么只有它特殊：<webview> 被卸载时 Electron 会把 guest 一起销毁 ——
  // 页面、滚动位置、表单草稿全丢，而主进程的自动化服务会拿不到 guest、
  // 一路等到超时（表现就是「模型想接着操作网页，却报浏览器不可用」）。
  // 其余四个面板（审查 / 文件 / 侧聊 / 终端）重建成本低，切走即卸载是对的，保持原样。
  //
  // 隐藏用 display:none 而不是卸载、也不改尺寸：实测 guest 的视口尺寸不会因此归零
  //（元素不参与布局时 guest 保留最后一次的 innerWidth/innerHeight），
  // 所以隐藏期间依赖坐标的 click / type 依然能投递 —— 这条正是「后台自动化」的前提。
  const [browserMounted, setBrowserMounted] = useState(view === "browser");
  useEffect(() => {
    if (view === "browser") setBrowserMounted(true);
  }, [view]);

  return (
    <>
      {browserMounted && (
        <div className={view === "browser" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <BrowserPanel />
        </div>
      )}
      {view !== "browser" && <TransientPanel view={view} />}
    </>
  );
}

/**
 * 除浏览器外的四个面板：切走就卸载（重建成本低，同时留着只会白占内存）。
 *
 * 单独一个组件而不是在上一层的 return 里写 switch：那一层要同时表达
 * 「浏览器常驻」与「其余瞬时」，两件事混在一个 switch 里读不出这个区别。
 */
function TransientPanel({ view }: { view: RightPanelView }): React.JSX.Element {
  switch (view) {
    case "review":
      return <ReviewPanel />;
    case "files":
      return <FilesPanel />;
    case "sideChat":
      return <SideChatPanel />;
    case "terminal":
      return <TerminalPanel />;
    case "browser":
      // 浏览器面板由上一层常驻渲染，这里不重复挂载
      return <></>;
  }
}
