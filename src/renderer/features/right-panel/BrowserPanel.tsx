import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { field } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { PanelEmpty } from "./panel-view";

/**
 * 内置浏览器面板。
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
 * 范围：这一版只做「能看」。让模型操作页面（点击/输入/读 DOM）需要一整套会话与权限设计，
 * 属于后续工作。webview 元素本身有 executeJavaScript 能力，但这里**不暴露**任何自动化入口 ——
 * 没有需求就先把攻击面关掉。
 *
 * 地址栏按浏览器的习惯判定两种输入：像网址就当网址（缺 scheme 补 https），
 * 否则当搜索词。否则「输入 example.com 结果什么也没发生」这种困惑一定会发生。
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
}

/** webview 事件对象里我们用到的字段（自定义元素的事件不带 TS 类型） */
interface WebviewEventDetail {
  url?: string;
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
}

export function BrowserPanel(): React.JSX.Element {
  const { t } = useTranslation();

  /** 地址栏内容：用户编辑期间是草稿，导航完成后回写成实际 URL */
  const [address, setAddress] = useState("");
  /** 当前已请求的 URL；空串 = 还没打开任何页面（显示空态而不是空白 webview） */
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  /**
   * 页面加载失败。**存布尔而不是文案**：文案在渲染时用 t() 取，
   * 这样创建 webview 的那个 effect 不必依赖 t（它必须只跑一次，见其说明）。
   */
  const [failed, setFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  /** webview 的宿主容器：元素自己创建后插进来 */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);

  /**
   * 创建 webview 并挂事件。
   *
   * 只在挂载时跑一次（严格模式下会跑两次，所以卸载时要把元素一起摘掉，
   * 否则会留下一个仍在跑的 guest 进程）。
   *
   * 依赖数组**必须为空**：一旦把 t 之类的值放进去，切换界面语言就会销毁并重建 webview，
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
    // 免得某个站点的存储污染应用自己的会话
    element.setAttribute("partition", "persist:oint-browser");

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
        setUrl(detail.url);
        setAddress(detail.url);
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

    element.addEventListener("did-start-loading", onStart);
    element.addEventListener("did-stop-loading", syncNavigation);
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    element.addEventListener("did-fail-load", onFail);

    host.appendChild(element);
    webviewRef.current = element;

    return () => {
      element.removeEventListener("did-start-loading", onStart);
      element.removeEventListener("did-stop-loading", syncNavigation);
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
      element.removeEventListener("did-fail-load", onFail);
      element.remove();
      webviewRef.current = null;
    };
    // 空依赖：只创建一次。这里已经不读 t 了（失败只存布尔），所以不需要任何豁免 ——
    // 一旦把 t 加回来，切语言就会重建整个 guest，页面的浏览状态会整份丢掉。
  }, []);

  /*
    把「当前该显示的 URL」同步给 webview。

    **必须用 setAttribute("src", …)，不能用 loadURL()** —— 这是实测出来的硬约束：
    webview 的 loadURL 要求 guest 已经 dom-ready，否则会**同步抛出**
    「The WebView must be attached to the DOM and the dom-ready event emitted
    before this method can be called.」。而首次导航时 guest 一定还没 ready，
    所以那个异常会从 effect 里逃出去、把整棵 React 树带塌 ——
    表现就是「输入网址点进入之后整个软件空白」。
    setAttribute("src") 走的是元素属性那条路，任何时机都安全（实测首载与二次导航都通过）。

    代价：它不像 loadURL 那样返回 Promise，所以失败只能靠 did-fail-load 事件上报 ——
    那条路径本来就有（见上面 onFail），不重复处理。
  */
  useEffect(() => {
    const element = webviewRef.current;
    if (element === null) return;
    if (url === "") return;
    element.setAttribute("src", url);
  }, [url]);

  const navigate = (input: string) => {
    const next = toUrl(input);
    if (next === "") return;
    setFailed(false);
    // 同一个 URL 再点一次回车（刷新语义）：effect 不会重跑，所以这里显式 reload
    if (next === url) {
      setLoading(true);
      webviewRef.current?.reload();
      return;
    }
    setUrl(next);
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
