import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { field } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useUiStore } from "@/renderer/stores/ui-store";
import { PanelEmpty } from "./panel-view";

/**
 * 内置浏览器面板：**一个实例 = 一个浏览器标签 = 一个 <webview> guest**。
 *
 * 标签的数量与身份由 RightSidebar / ui-store 管（id 形如 "t3"），这里只负责
 * 「这个 tabId 的 webview 建出来、把 guest 登记给主进程、把页面状态显示给人看」。
 * 主进程按 tabId 记账（registerTab / activateTab / unregisterTab，见 shared/contracts/browser.ts），
 * 模型的每个浏览器工具都能指定作用于哪个标签。
 *
 * 为什么用 <webview> 而不是 iframe：绝大多数站点都设了 X-Frame-Options / CSP
 * frame-ancestors，塞进 iframe 会直接白屏；<webview> 是独立的 guest 进程，
 * 不受这些响应头限制。主窗口已开 webviewTag，并在主进程收紧了 guest 的能力
 *（见 main/app/window.ts 的 hardenWebviews：清空 preload、关 nodeIntegration、
 * 拒绝一切弹窗）—— 那才是安全边界，这个文件只管用它。
 *
 * **元素是命令式创建的**，不走 JSX。两个理由：
 *   1. React 19 的 JSX 类型表里没有 webview（它是 Chromium 注入的扩展元素），
 *      要写就得给 JSX.IntrinsicElements 打补丁，而我们只需要它一个标签；
 *   2. webview 的生命周期比 React 的挂载/卸载更"粘"：它内部带着一个真实的浏览会话
 *      （cookie、滚动位置、表单草稿）。用 JSX 条件渲染会在每次 url 变化时重建元素，
 *      把页面状态整份丢掉，用户会看到「点个链接就白屏重载」。
 *      自己创建一次、之后只调 loadURL()，才是浏览器的行为。
 *
 * 与模型的关系：**页面可以由模型驱动**（打开网址、读页面、点击、输入、截图、看控制台）。
 * 但驱动不从这里走 —— guest 的 WebContents 由主进程在 did-attach-webview 时接管，
 * 之后的自动化全在那边完成（见 src/main/browser/service.ts 与 shared/contracts/browser.ts）。
 * 这个文件只负责三件事，缺一不可：
 *   1. **把 <webview> 元素建出来** —— 没有元素就没有 guest，自动化无从谈起；
 *   2. **把 guest 登记给主进程**（dom-ready 后 registerTab）—— 主进程靠它按 tabId 找到
 *      这个 guest；模型的 open-request 也在这一步交回执；
 *   3. 订阅 browser:event，把「模型正在操作页面」显示出来，并让地址栏跟上模型的导航。
 *
 * 为什么不让渲染层把 executeJavaScript 暴露给模型：那等于在 IPC 上开一个「任意页面代码
 * 执行」入口，任何拿到渲染进程执行权的东西都能借它读任意已登录站点。主进程本来就持有
 * guest，没有必要把这份能力再暴露一次。
 *
 * 地址栏按浏览器的习惯判定两种输入：像网址就当网址（缺 scheme 补 https），
 * 否则当搜索词。否则「输入 example.com 结果什么也没发生」这种困惑一定会发生。
 * 注意这与**模型**走的那条路不同：browser_open 只接受 http/https，不接受搜索词 ——
 * 模型该用搜索工具去找东西，而不是把一个词丢给地址栏。
 */

/** 地址栏里「看起来像网址」的判定：有 scheme，或 host 部分含点且不含空格 */
function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  if (value === "") return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(value)) return true;
  // host = 到第一个 / ? # 为止的那一段，必须含点、不含空格
  const host = value.split(/[/?#]/, 1)[0] ?? "";
  return host.includes(".") && !/\s/.test(host);
}

/** 用户输入 → 真正要加载的 URL */
function toUrl(input: string): string {
  const value = input.trim();
  if (!looksLikeUrl(value)) {
    return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * webview 上我们真正用到的成员。
 *
 * 不引 electron 的类型（渲染层没有它的声明），按结构描述一份最小接口：
 * 比 `any` 安全，也不需要为它拉一个类型包。
 */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  /** guest 的 WebContents id；dom-ready 之前调用会抛，所以只在 dom-ready 后读 */
  getWebContentsId(): number;
}
/** webview 事件对象里我们用到的字段（自定义元素的事件不带 TS 类型） */
interface WebviewEventDetail {
  url?: string;
  title?: string;
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
}

/**
 * 订阅「模型正在操作页面」事件。
 *
 * 页面状态（地址栏、加载中、失败）**不从这里取**：那些由 webview 元素自己的
 * did-navigate / did-start-loading 事件提供，而模型操作的正是同一个 guest，
 * 所以两条路径看到的状态本就一致。再叠一份主进程状态只会多一个可能不同步的来源。
 *
 * 事件带 tabId（模型在操作哪一个标签）：只有那个标签显示提示条，
 * 否则开着的每一页都喊「Oint 正在操作这个页面」，而实际上只动了其中一个。
 */
function useAgentActivity(tabId: string): string | null {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    return window.oint.browser.onEvent((event) => {
      if (event.type !== "agent") return;
      if (event.tabId !== undefined && event.tabId !== tabId) return;
      setNote(event.active ? (event.note ?? "") : null);
    });
  }, [tabId]);

  return note;
}

export function BrowserPanel({
  tabId,
  active,
}: {
  /** 本标签的 id（由 ui-store 分配）：发给主进程的登记 / 激活 / 注销都带上它 */
  tabId: string;
  /** 是否当前标签：不活动的实例由 RightSidebar 用 hidden 藏起来，但不卸载 */
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  /** 地址栏内容：用户编辑期间是草稿，导航完成后回写成实际 URL */
  const [address, setAddress] = useState("");
  /**
   * 当前**实际显示**的页面 URL；空串 = 还没有页面（显示空态而不是空白 webview）。
   *
   * 它只从 webview 的导航事件来（用户导航、页面内跳转、主进程替模型导航都会触发），
   * **不反向驱动 src** —— 那正是「同一页被加载两遍」的来源，见 navigate 的说明。
   */
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  /**
   * 页面加载失败。**存布尔而不是文案**：文案在渲染时用 t() 取，
   * 这样创建 webview 的那个 effect 不必依赖 t（它必须只跑一次，见其说明）。
   */
  const [failed, setFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  /** 模型正在操作页面时的说明文案；为 null 表示模型没在动它（只认本标签的事件） */
  const agentNote = useAgentActivity(tabId);
  /**
   * 用户点 HTML 卡片产生的「打开这个地址」请求。
   *
   * 订阅整个对象（引用稳定）：请求不变时 useUiStore 按 Object.is 判等，不会引起重渲染；
   * 变了才重渲染一次，正好驱动下面那个 effect 去导航。
   */
  const browserOpenRequest = useUiStore((s) => s.browserOpenRequest);

  /** webview 的宿主容器：元素自己创建后插进来 */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);

  /**
   * 用户切到这个标签：告诉主进程（status 里的 active 由它维护）。
   *
   * 新建的标签在 guest 就绪前就已经是「当前标签」，所以这一次上报会被主进程当作
   * 未知标签丢掉 —— 不要紧，registerGuest 登记完成后会按当时的 activeTabId 补报一次。
   */
  useEffect(() => {
    if (!active) return;
    void window.oint.browser.activateTab(tabId).catch(() => {});
  }, [active, tabId]);

  /**
   * 创建 webview、挂事件、并把 guest 登记给主进程。
   *
   * 只在挂载时跑一次（严格模式下会跑两次，所以卸载时要把元素一起摘掉，
   * 否则会留下一个仍在跑的 guest 进程）。
   *
   * 依赖数组里只有 tabId：它由 RightSidebar 按标签 key 传入，一个实例活多久它就多久，
   * 变化意味着换了一个标签，重建 webview 正是该做的事。
   * **不要**把 t 之类的值放进来：切换界面语言就会销毁并重建 webview，
   * 页面的浏览状态（滚动位置、表单草稿、登录态）会整份丢掉。
   * 所以失败文案固定读一次，不做语言实时跟随 —— 代价只是一条错误文案在切语言后
   * 仍是旧语言，而重建 guest 的代价要大得多。
   *
   * 事件监听器在闭包里直接用 setState —— 这些 setState 都是幂等的状态写入
   *（loading / canGoBack / error），不需要读最新 state，也就没有闭包陷阱。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const element = document.createElement("webview") as WebviewElement;
    // 不给 guest 传 preload、不加 allowpopups：主进程会强制清掉这些，
    // 这里不写相当于不依赖「渲染层自觉」做安全
    element.className = "h-full w-full border-0";
    // 独立分区：内置浏览器的 cookie / 缓存与主窗口分开，
    // 免得某个站点的存储污染应用自己的会话。
    // 所有浏览器标签共用这个分区：它们本就是同一个浏览器的多个标签页
    element.setAttribute("partition", "persist:oint-browser");

    /**
     * 页面标题与 URL 的最近值：给标签栏报名字用。
     *
     * 用闭包变量而不是 state：它们只在事件里读写，没必要让每次导航都重渲染；
     * 而 onTitleUpdated 要拿「当前 URL」兜底时，state 在闭包里是过期的。
     */
    let lastUrl = "";
    let lastTitle = "";

    // 空标题（页面没写 <title>）时退回 URL：标签上宁可显示一串地址，
    // 也不要一排分不清彼此的「浏览器」
    const reportTitle = () => {
      const label = lastTitle.trim() !== "" ? lastTitle : lastUrl;
      if (label.trim() !== "") useUiStore.getState().setRightPanelTabTitle(tabId, label);
    };

    const onTitleUpdated = (event: Event) => {
      lastTitle = (event as Event & WebviewEventDetail).title ?? "";
      reportTitle();
    };

    /**
     * 把 guest 交给主进程。
     *
     * 时机是 dom-ready：Electron 在 guest 建好之前调 getWebContentsId 会抛
     *（「must be attached to the DOM and the dom-ready event emitted」），
     * 而这个事件之后它一定可用。登记只做一次（重复登记没有意义）。
     *
     * requestId 只在「本标签正是模型这次 open-request 要的」时带上：
     * 主进程靠这个回执才知道往哪个 guest 上导航（见 shared/contracts/browser.ts），
     * 回执交回后立刻结算，避免它被下一个标签误领。
     */
    let registered = false;
    const registerGuest = () => {
      if (registered) return;
      let webContentsId: number;
      try {
        webContentsId = element.getWebContentsId();
      } catch {
        // guest 还没建出来：事件顺序由 Electron 保证（dom-ready 在前），这里不轮询
        return;
      }
      registered = true;
      const pending = useUiStore.getState().pendingBrowserRequest;
      const requestId = pending !== null && pending.tabId === tabId ? pending.requestId : undefined;
      if (requestId !== undefined) useUiStore.getState().settleBrowserRequest();
      void window.oint.browser
        .registerTab(tabId, webContentsId, requestId)
        .then(() => {
          // 登记前那次 activateTab 会被主进程当作未知标签丢掉，这里按当前焦点补一次
          if (useUiStore.getState().activeTabId === tabId) {
            void window.oint.browser.activateTab(tabId).catch(() => {});
          }
        })
        .catch(() => {});
    };

    const onStart = () => {
      setLoading(true);
      setFailed(false);
    };

    const syncNavigation = () => {
      setLoading(false);
      setCanGoBack(element.canGoBack());
      setCanGoForward(element.canGoForward());
    };

    const onNavigate = (event: Event) => {
      const detail = event as Event & WebviewEventDetail;
      // 只跟随主框架导航：页面里的 iframe 也会发 did-navigate-in-page，
      // 拿它的 URL 覆盖地址栏会让地址栏在第三方页面上乱跳
      if (detail.url !== undefined && detail.isMainFrame !== false) {
        // 引导用的 about:blank 不算页面：它只是把 guest 拉起来的手段。
        // 收下它会让空态浮层消失、刷新按钮变亮，而那两件事在「还没导航」时都是错的。
        if (detail.url !== "" && detail.url !== "about:blank") {
          lastUrl = detail.url;
          setUrl(detail.url);
          setAddress(detail.url);
          // 新页面可能改标题（也可能不改）：先按当前已知的标题/地址刷新一次标签名，
          // 页面随后发来 page-title-updated 再纠正 —— 与真实浏览器标签的行为一致
          reportTitle();
        }
      }
      syncNavigation();
    };

    const onFail = (event: Event) => {
      const detail = event as Event & WebviewEventDetail;
      setLoading(false);
      // 子资源失败（图片、广告）不算「页面加载失败」；
      // -3 是 ERR_ABORTED，即用户主动中止（点链接后立刻又点了别的）——也不是错误
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      // 只记「失败了」这个事实，文案在渲染时翻译 ——
      // 这样这个 effect 就不依赖 t（见依赖数组的说明）。
      setFailed(true);
    };

    element.addEventListener("dom-ready", registerGuest);
    element.addEventListener("page-title-updated", onTitleUpdated);
    element.addEventListener("did-start-loading", onStart);
    element.addEventListener("did-stop-loading", syncNavigation);
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    element.addEventListener("did-fail-load", onFail);

    host.appendChild(element);
    /*
      引导：Electron 44 的 <webview> **只在第一次设置 src 时才创建 guest**。
      实测（最小复现，窗口配置与本应用一致）：元素挂在 DOM 里而不给 src，
      did-attach-webview 永远不触发、getWebContentsId() 抛「must be attached to the
      DOM and the dom-ready event emitted」，而主进程的自动化服务拿不到 guest 就一路等到超时。

      所以这里给一个 about:blank 把 guest 拉起来，之后主进程的 loadURL 与地址栏的
      setAttribute 才有对象可操作。代价是多一次 about:blank「加载」——
      它在 onNavigate 里被过滤掉，不算作「打开了页面」。
    */
    element.setAttribute("src", "about:blank");
    webviewRef.current = element;

    return () => {
      element.removeEventListener("dom-ready", registerGuest);
      element.removeEventListener("page-title-updated", onTitleUpdated);
      element.removeEventListener("did-start-loading", onStart);
      element.removeEventListener("did-stop-loading", syncNavigation);
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
      element.removeEventListener("did-fail-load", onFail);
      element.remove();
      webviewRef.current = null;
      // 卸载 = 标签没了：主进程要释放这个 guest 的引用与缓冲。
      // fire-and-forget、吞掉错误：关窗时桥可能已经拆掉，这里没有能补救的事
      void window.oint.browser.unregisterTab(tabId).catch(() => {});
    };
    // tabId 是唯一依赖，理由见上面的说明。
  }, [tabId]);

  /**
   * 用户点了 HTML 文件卡片：把这个地址加载到本标签。
   *
   * ## 为什么不是「消费一次就清掉请求」
   *
   * 第一版把请求当成一次性事件：读到就 settle，然后写 src。**实测不行** ——
   * StrictMode 下这个组件会挂载两次，第一次建出的元素随后被清理 effect 摘掉，
   * 请求却已经在第一次被结算，第二次挂载时拿到的是 null，于是在 DOM 里留下的那个
   * webview 永远停在 about:blank。表现是「点了 HTML 卡片，浏览器打开了、标签也在，
   * 但页面是白的」——只在 dev 下出现，生产构建看不到，必须靠真实 Electron 里的探针抓
   *（scripts/probe-turn-files.mjs 就是为它写的）。
   *
   * 现在的判据是 **(元素, token)**：请求留在 store 里当「最后一次要求打开的地址」，
   * 每个元素各自记住自己已经应用过哪个 token。于是：
   *   · 换了个元素（StrictMode 的第二次挂载、关掉标签再开）→ 元素不同 → 会重新应用；
   *   · 同一个元素、同一个 token（普通重渲染、切走再切回）→ 跳过，不会自己刷新；
   *   · 又点一次同一个文件 → token 变了 → 重新加载（这正是「再点一次 = 刷新」）。
   *
   * 只有**当前活动的标签**响应：请求进 store 时 openInBrowser 已经把目标标签设为当前，
   * 所以真正的目标一定会看到它；其余标签也响应的话，同一份文件会被加载两次。
   *
   * 用 setAttribute 而不是 loadURL，理由与 navigate 里那段一字不差（guest 未就绪时
   * loadURL 会同步抛）。本地 file:// 地址不做任何补全：它就是最终地址。
   */
  const appliedRef = useRef<{ element: HTMLElement | null; token: number }>({
    element: null,
    token: 0,
  });

  useEffect(() => {
    if (!active || browserOpenRequest === null) return;
    const element = webviewRef.current;
    if (element === null) return;
    // 已经在这个元素上应用过这一条请求：不重复导航（否则每次重渲染都刷新一遍）
    if (
      appliedRef.current.element === element &&
      appliedRef.current.token === browserOpenRequest.token
    ) {
      return;
    }
    appliedRef.current = { element, token: browserOpenRequest.token };
    setFailed(false);
    setLoading(true);
    element.setAttribute("src", browserOpenRequest.url);
  }, [active, browserOpenRequest]);

  /**
   * 导航到用户输入的地址。
   *
   * **导航只在这里发起**（写 src 属性）；页面自己产生的导航不再回写 url 去触发第二次加载。
   * 这是踩过坑的地方：主进程替模型导航（loadURL）同样会让 did-navigate 触发，
   * 如果那时把 URL 灌回 src，同一页会被加载两遍 —— 表现是页面自己刷新一下、滚动位置丢失。
   *
   * 首次引导不走这里：元素创建时已经设了 src="about:blank"（见上面创建元素的那个 effect），
   * 那条路径负责把 guest 拉起来，地址栏只负责之后的事。
   *
   * 仍然**必须用 setAttribute("src", …)**：webview 的 loadURL 要求 guest 已经 dom-ready，
   * 否则同步抛出（「The WebView must be attached to the DOM and the dom-ready event
   * emitted before this method can be called.」），异常会从事件处理器里逃出去。
   * src 属性那条路任何时机都安全。代价是没有 Promise，失败只能靠 did-fail-load 上报。
   */
  const navigate = (input: string) => {
    const next = toUrl(input);
    if (next === "") return;
    const element = webviewRef.current;
    if (element === null) return;
    setFailed(false);
    // 同一个 URL 再点一次回车（刷新语义）
    if (next === url) {
      setLoading(true);
      element.reload();
      return;
    }
    element.setAttribute("src", next);
  };

  /**
   * 用系统浏览器打开当前页面。
   *
   * 有些页面（登录、下载、需要扩展）在内置浏览器里就是不好用，给一条明确的退路
   * 比让用户自己复制地址强。guest 自己弹不出窗口（主进程把 window.open 拒了），
   * 所以这条出口在我们的 UI 上。
   */
  const openExternal = () => {
    if (url === "") return;
    void window.oint.app.openPath(url);
  };

  const hasPage = url !== "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：后退 / 前进 / 刷新 / 地址栏 / 外部打开。
          这里不套 PanelSection —— 地址栏本身就是这一行的主体，
          再叠一层标题行只会白占 44px。 */}
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.browserBack")}
          title={t("rightPanel.browserBack")}
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.browserForward")}
          title={t("rightPanel.browserForward")}
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.browserReload")}
          title={t("rightPanel.browserReload")}
          disabled={!hasPage}
          onClick={() => {
            // 加载中就停：同一个键在两个状态间切换，是浏览器的既有习惯
            const element = webviewRef.current;
            if (element === null) return;
            if (loading) element.stop();
            else element.reload();
          }}
        >
          <RotateCw
            className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")}
          />
        </Button>

        <form
          className="flex min-w-0 flex-1 items-center px-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={t("rightPanel.browserPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("rightPanel.browserPlaceholder")}
            className={cn(
              field,
              "h-7 w-full min-w-0 rounded-lg px-2.5 text-xs outline-none",
              "placeholder:text-ink-4 focus-visible:ring-1 focus-visible:ring-foreground/20",
            )}
          />
        </form>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.browserOpenExternal")}
          title={t("rightPanel.browserOpenExternal")}
          disabled={!hasPage}
          onClick={openExternal}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>

      {/* 加载进度：一条 2px 的 live 蓝，只在加载中出现。
          不用 spinner，因为它会改变周边布局；浏览器都在顶部放细线，这里照办。 */}
      {loading && <div className="h-0.5 shrink-0 animate-pulse bg-live" aria-hidden="true" />}

      {/* 失败提示：文案在这里翻译（不存进 state，见 failed 的说明） */}
      {failed && (
        <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-destructive">
          {t("rightPanel.browserFailed")}
        </p>
      )}

      {/* 模型正在操作页面：它会在你眼前滚动、点击、输入，说明白比让人困惑好。
          用 text-live 与加载进度条同一套语义色（「正在发生」），不用 danger/warn。 */}
      {agentNote !== null && (
        <p className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-live/5 px-3 py-1.5 text-[11.5px] text-live">
          <Bot className="size-3.5 shrink-0" aria-hidden="true" />
          {agentNote === "" ? t("rightPanel.browserAgentActive") : agentNote}
        </p>
      )}

      {/*
        webview 的宿主。**始终渲染**（不跟着 hasPage 卸载）：
        元素由上面的 effect 创建一次，页面在不在只影响它是否加载了 URL。
        每次切换页面都重建元素会把浏览会话（cookie、滚动位置）一并丢掉。

        空态叠在上面（absolute）：这样「还没有页面」时看到提示，
        一旦有 URL，webview 就在它下班。
      */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div ref={hostRef} className="h-full w-full" />
        {!hasPage && (
          <div className="absolute inset-0 flex flex-col bg-background">
            <PanelEmpty
              icon={Globe}
              title={t("rightPanel.browserEmpty")}
              hint={t("rightPanel.browserHint")}
            />
          </div>
        )}
      </div>
    </div>
  );
}
