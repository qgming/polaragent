// 插件面板的宿主：一个 `<webview>`，src 指向 `oint-plugin://`。
//
// ## 与内置浏览器面板的关系
//
// 长得像，信任模型相反。浏览器面板是一个**通用浏览器**（用户让它去哪它去哪、
// guest 没有 preload、没有身份）；插件面板是一个**沙箱化的第三方应用**
//（只能待在自己的资源里、有 preload、有身份）。
// 所以两者不共用组件 —— 共用一个的话，任何一边的放宽都会顺手放宽另一边。
//
// ## 这个组件不做任何安全判断
//
// 它没有"这个插件允许不允许"的判断，也不构造 URL —— `url` 与 `partition` 都是主进程
// 算好给的（见 PluginSurfaceInfo 的说明）。**渲染层只负责把元素建出来**。
// 这不是偷懒：安全判断在渲染层做等于把边界放在可以被插件影响的地方。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";
import type { PluginSurfaceInfo } from "@/shared/contracts/plugin";

/** webview 上我们真正用到的成员（与 BrowserPanel 里那份同款，但只留这几项） */
interface WebviewElement extends HTMLElement {
  reload(): void;
  getWebContentsId(): number;
}

type Phase = "loading" | "ready" | "failed";

/**
 * 一个插件面板实例。
 *
 * `surface` 由插件面板的同步钩子从 `plugins:list` 的结果里取，
 * 所以它一定是**主进程刚刚算出来的那一份**。
 */
export function PluginSurfacePanel({ surface }: { surface: PluginSurfaceInfo }): React.JSX.Element {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    setPhase("loading");
    setError("");

    const element = document.createElement("webview") as WebviewElement;
    element.className = "h-full w-full border-0";
    /*
      分区由主进程给（每个插件一个，见 PluginSurfaceInfo 的说明）。
      **渲染层算不出来也不该算** —— 主进程要为这个分区装"全拒绝"的权限处理器，
      两处算出来的字符串不一致时症状是"权限阻挡悄悄失效"，而那不会有任何报错。

      这里**不写 preload**：主进程在 will-attach-webview 里按 src 的 scheme
      决定装不装，渲染层写什么都会被覆盖。不写相当于不依赖"渲染层自觉"。
    */
    element.setAttribute("partition", surface.partition);

    const onReady = (): void => setPhase("ready");
    const onFail = (event: Event): void => {
      setPhase("failed");
      // webview 的失败事件带 errorCode / errorDescription（自定义元素，没有 TS 类型）
      const detail = event as unknown as { errorCode?: number; errorDescription?: string };
      setError(
        detail.errorDescription ??
          (detail.errorCode === undefined ? "" : `错误码 ${detail.errorCode}`),
      );
    };
    element.addEventListener("dom-ready", onReady);
    element.addEventListener("did-fail-load", onFail);
    element.addEventListener("render-process-gone", onFail);

    /*
      Electron 44 的 `<webview>` **只在第一次设置 src 时才创建 guest**
     （与 BrowserPanel 里那段说明同一个坑）。这里直接设真 src 就够 ——
      我们不需要它先停在 about:blank，因为这个组件一建出来就是要加载那个页面的。
    */
    element.setAttribute("src", surface.url);
    host.appendChild(element);

    return () => {
      element.removeEventListener("dom-ready", onReady);
      element.removeEventListener("did-fail-load", onFail);
      element.removeEventListener("render-process-gone", onFail);
      // 从 DOM 摘掉就会销毁 guest（主进程在 did-attach-webview 登记的归属由
      // webContents 的 destroyed 事件清理，见 surfaces.ts 的 claimPanelSurface）
      element.remove();
    };
  }, [surface.url, surface.partition]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 宿主容器**始终渲染**：webview 元素是手动插进来的，这块 div 消失它就没了 */}
      <div ref={hostRef} className={cn("min-h-0 flex-1", phase !== "ready" && "invisible")} />

      {phase === "loading" && (
        <div className="absolute inset-0 grid place-items-center">
          <p className="text-[13px] text-ink-3">{t("plugins.surfaceLoading")}</p>
        </div>
      )}

      {phase === "failed" && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div>
            <p className="text-[13px] text-ink-2">{t("plugins.surfaceFailed")}</p>
            {error !== "" && <p className="mt-1 text-xs text-ink-4">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
