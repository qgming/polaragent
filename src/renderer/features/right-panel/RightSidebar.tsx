import { Plus, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/renderer/app/WindowControls";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { type RightPanelTab, type RightPanelView, useUiStore } from "@/renderer/stores/ui-store";
import { BrowserPanel } from "./BrowserPanel";
import { FilesPanel } from "./FilesPanel";
import { FileViewPanel } from "./FileViewPanel";
import { RIGHT_PANEL_VIEW_META } from "./panel-meta";
import { ReviewPanel } from "./ReviewPanel";
import { RightPanelChooser } from "./RightPanelChooser";
import { SubagentPanel } from "./SubagentPanel";
import { TerminalPanel } from "./TerminalPanel";
/**
 * 右侧栏本体：内容区顶栏那颗按钮开出来的面板。
 *
 * 两屏结构（都在这一块界面内，没有第二层浮层）：
 *   1. **某个标签的内容** —— 顶行是标签条，点标签即切换；
 *   2. **选择列表**（activeTabId === null）—— 展开面板后的第一屏，也是关掉最后一个
 *      标签后落到的那一屏：列出五个入口，点一项即开出一个（或复用）标签。
 * 收起只由内容区顶栏那颗右侧栏开关负责（面板内刻意没有收起按钮，
 * 理由与左侧栏一致：开合只放在始终可见的那一处）。
 *
 * 顶行是**标签条**：左起依次是各标签（图标 + 名字 + ×）与「+」（回到选择列表），
 * 右端是窗口控制（最小化 / 最大化 / 关闭）—— 面板展开时它们从内容区顶栏挪过来，
 * 于是「窗口控制永远在窗口右上角」保持成立（见 TitleBar 的对应判断）。
 * 整行是窗口拖拽区：侧边栏占满整窗高度，它的顶行也被拖拽区覆盖，
 * 这样「从右侧栏顶上拖窗口」与「从顶栏拖」是一致的。
 *
 * 形态与左侧栏（SidebarShell）逐条对齐，保证开合行为一致：
 *   · 只有「展开 / 完全隐藏」两态，没有窄轨道；
 *   · 收起时宽度收到 0，内层锁死展开宽度、内容被左边缘剪掉（不是重排挤压）；
 *   · 收起期间整棵子树 `inert`：宽度 0 + 剪裁只是视觉上不可见，
 *     里面的按钮仍会被 Tab 命中、仍进辅助技术树。
 *
 * **浏览器标签全部常驻**（切到别的标签只加 hidden，不卸载）：<webview> 一旦被卸载，
 * Electron 会把 guest 一起销毁 —— 页面、滚动位置、表单草稿全丢，主进程的自动化服务
 * 也会拿不到 guest、一路等到超时（表现就是「模型想接着操作网页，却报浏览器不可用」）。
 * 其余视图重建成本低，切走即卸载是对的，保持原样。
 *
 * 隐藏用 display:none 而不是卸载、也不改尺寸：实测 guest 的视口尺寸不会因此归零
 *（元素不参与布局时 guest 保留最后一次的 innerWidth/innerHeight），
 * 所以隐藏期间依赖坐标的 click / type 依然能投递 —— 这条正是「后台自动化」的前提。
 * 唯一要注意的是渲染节流：display:none 期间 Chromium 会压低 guest 的 rAF/定时器，
 * 主进程已在 attachBrowserGuest 里调用 setBackgroundThrottling(false) 关掉它
 *（本机 Electron 44.3 实测：rAF 92→0，关节流后回到 90；见 service.ts 的说明）。
 *
 * 一个例外：**模型要用浏览器时，这里负责把右侧栏展开并切到浏览器标签**（见 useEffect）。
 * guest 由 BrowserPanel 的 webview 元素创建，标签不挂载就没有可自动化的页面 ——
 * 所以「模型想打开一个网址」这件事必须能自己把标签建出来，否则模型每次都得先求你
 * 手动打开面板，而人会觉得「这工具怎么连这个都要我动手」。
 * 收起状态也照样展开：这是有意的（模型主动要用），且对同一个请求是幂等的。
 */
export function RightSidebar(): React.JSX.Element {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.rightPanelOpen);
  const tabs = useUiStore((s) => s.rightPanelTabs);
  const activeTabId = useUiStore((s) => s.activeTabId);
  const activateRightPanelTab = useUiStore((s) => s.activateRightPanelTab);
  const closeRightPanelTab = useUiStore((s) => s.closeRightPanelTab);
  const showRightPanelChooser = useUiStore((s) => s.showRightPanelChooser);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  // 模型要用浏览器：把右侧栏展开，并按请求的策略准备标签。
  //
  // 策略（契约见 shared/contracts/browser.ts 的 BrowserEvent）：
  //   · newTab → 总是新建一个浏览器标签；
  //   · 否则 tabId 指定且存在 → 用它；再否则复用任意一个已有浏览器标签；都没有才新建。
  // 无论哪条路径，都保证「面板展开 + 目标标签是当前标签」。
  //
  // 主进程那一侧会**反复发这个请求**直到 guest 注册（见 browser/service.ts 的
  // requireGuest），所以这里必须幂等：按 requestId 认领「已经为它建好的标签」，
  // 否则每次重发都会多开一页，而主进程只认最后那个，前面的就成了没人管的孤儿。
  useEffect(() => {
    return window.oint.browser.onEvent((event) => {
      if (event.type !== "open-request") return;
      const ui = useUiStore.getState();

      const pending = ui.pendingBrowserRequest;
      if (pending !== null && pending.requestId === event.requestId) {
        const existing = ui.rightPanelTabs.find((tab) => tab.id === pending.tabId);
        if (existing !== undefined) {
          if (!ui.rightPanelOpen || ui.activeTabId !== existing.id) {
            useUiStore.setState({ rightPanelOpen: true, activeTabId: existing.id });
          }
          return;
        }
      }

      if (!event.newTab) {
        // 指定的标签存在就用它；没有指定（或指定了不存在）时退回最后一个浏览器标签 ——
        // 与「+ / Ctrl+T 复用」同一条口径：最近创建的标签最可能是模型上次在用的那个
        const browserTabs = ui.rightPanelTabs.filter((tab) => tab.view === "browser");
        const target =
          (event.tabId === undefined
            ? undefined
            : browserTabs.find((tab) => tab.id === event.tabId)) ?? browserTabs.at(-1);
        if (target !== undefined) {
          if (!ui.rightPanelOpen || ui.activeTabId !== target.id) {
            useUiStore.setState({ rightPanelOpen: true, activeTabId: target.id });
          }
          return;
        }
      }

      // 新标签：记下回执凭据，BrowserPanel 在 guest 就绪、登记时把它交回主进程
      const tabId = ui.openBrowserTab();
      useUiStore.setState({ pendingBrowserRequest: { requestId: event.requestId, tabId } });
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
          顶行 = 标签条 + 「+」+ 窗口控制。

          标签条单独一层横向滚动（app-scrollbar）：标签多了只滚标签，
          「+」与窗口控制留在原地 —— 否则标签一多，那两个入口就被滚出屏幕。
          「+」的语义是「开一个内容」：它不直接建标签，而是回到选择列表让用户选
         （浏览器多开的那条路也在那儿，每次点「浏览器」都是新标签）。
        */}
        <div
          className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-2"
          data-electron-drag-region
        >
          <div className="app-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <RightPanelTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onSelect={() => activateRightPanelTab(tab.id)}
                onClose={() => closeRightPanelTab(tab.id)}
              />
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("rightPanel.newTab")}
              title={t("rightPanel.newTab")}
              onClick={showRightPanelChooser}
              className="shrink-0"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WindowControls />
          </div>
        </div>

        {/* 内容区：填满剩余高度。每个面板自己管内部滚动（有的是整块滚动、有的是分栏），
            所以这里只给 min-h-0 的容器，不加 overflow —— 加了会把面板内部的吸顶元素一起滚走。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/*
            所有浏览器标签都渲染（每个都在自己的宿主 div 里），只有当前标签那个可见。
            这是「页面状态活过切换」的实现处：display:none 不销毁 guest，
            切回来时页面、滚动位置、表单草稿都还在（理由见文件头）。
          */}
          {tabs
            .filter((tab) => tab.view === "browser")
            .map((tab) => (
              <div
                key={tab.id}
                className={cn("flex min-h-0 flex-1 flex-col", tab.id !== activeTabId && "hidden")}
              >
                <BrowserPanel tabId={tab.id} active={tab.id === activeTabId} />
              </div>
            ))}
          {activeTab === null ? (
            <RightPanelChooser />
          ) : (
            activeTab.view !== "browser" && <TransientPanel view={activeTab.view} />
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * 标签条上的一颗标签：图标 + 名字 + ×。
 *
 * 名字优先用页面标题（浏览器标签会报上来，见 BrowserPanel），没有就用视图名 ——
 * 于是「浏览器 / 浏览器」在开了多页之后自然会变成各自的页面标题。
 * 结构对齐 TerminalPanel 的 TerminalTab（同一个仓里两处标签不该长得不一样）：
 * 外层 div + 两个 button。
 *
 * **× 一直显示**（本次改动的用户要求）：早先它只在 hover / 键盘聚焦时显形，
 * 理由是「静止时标签条更干净」—— 但那把「这个标签能关」这条信息藏进了一次试探里：
 * 用户得先碰一下才知道有这回事，而在触屏与触控板上根本没有 hover 这个状态。
 * 现在它常驻，只把颜色压淡：静止时是 `text-ink-4`，hover 到整颗标签或按钮本身才转深 ——
 * 「能关」始终可见，「正在指的是它」才靠颜色表达。
 */
function RightPanelTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: RightPanelTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const meta = RIGHT_PANEL_VIEW_META[tab.view];
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        "group flex h-7 shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-[12px]",
        active
          ? "bg-accent text-accent-foreground"
          : "text-ink-3 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 items-center gap-1.5"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="max-w-[8rem] truncate">{tab.title ?? t(meta.labelKey)}</span>
      </button>
      <button
        type="button"
        aria-label={t("rightPanel.tabClose")}
        title={t("rightPanel.tabClose")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={cn(
          "rounded p-0.5 text-ink-4 transition-colors",
          // hover 到标签本身或按钮自己：转深，给出「就要点它了」的反馈。
          // 不用 group-hover 控制显隐（那是旧写法），只控制颜色
          "hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/20",
          active ? "text-ink-3" : "group-hover:text-ink-3",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * 除浏览器外的四个面板：切走就卸载（重建成本低，同时留着只会白占内存）。
 *
 * 单独一个组件而不是在上一层的 return 里写 switch：那一层要同时表达
 * 「浏览器常驻」与「其余瞬时」，两件事混在一个 switch 里读不出这个区别。
 * 入参把 browser 排除掉：浏览器由上一层常驻渲染，走不到这里。
 */
function TransientPanel({ view }: { view: Exclude<RightPanelView, "browser"> }): React.JSX.Element {
  switch (view) {
    case "review":
      return <ReviewPanel />;
    case "files":
      return <FilesPanel />;
    case "file":
      return <FileViewPanel />;
    case "subagent":
      return <SubagentPanel />;
    case "terminal":
      return <TerminalPanel />;
  }
}
