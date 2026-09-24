// `oint-plugin://` 自定义协议：把插件界面资源从插件目录里服务出去。
//
// ## 两条注册，时机不同（写错了会静默失效）
//
// 1. **`registerSchemesAsPrivileged` 必须在 app ready 之前**调用 —— Electron 在
//    初始化网络栈时读这份表，之后再注册**不报错也不生效**，症状是
//    "页面加载了但 `fetch` / 相对路径全坏"。所以它在 main/index.ts 的模块顶层。
// 2. `protocol.handle` 在 ready 之后。
//
// ## 权限位逐条的理由
//
//  - `standard: true` —— **必须有**。非 standard 的 scheme 没有 URL 语义
//    （没有 origin、相对路径解析、pathname），`surface-url.ts` 那套解析就无从谈起。
//  - `secure: true` —— 当作安全上下文。不开的话 `crypto.subtle`、`navigator.clipboard`
//    这类 API 直接不可用，而插件界面用它们是完全合理的。
//  - `supportFetchAPI: true` —— 让页面能用 fetch 读**同源**资源（自己的 js/css）。
//    跨源由 CSP 的 `connect-src 'none'` 挡住，不是靠这个开关。
//  - `corsEnabled: false` —— 不参与 CORS 协商：所有插件的 host 都是 `surface`，
//    开 CORS 只会给"跨插件读"多开一条路。
//  - `bypassCSP: false` —— **关键**。开了它，下面那份 CSP 就形同虚设。
//  - `allowServiceWorkers: false` —— 插件界面不需要 SW，而 SW 能拦截后续请求。
//
// ## 一个如实的边界（不是漏洞，但要知道）
//
// 所有插件界面**共用同一个 origin**（host 固定为 `surface`，理由见 surface-url.ts）。
// 于是插件 A 的页面能用 `<img src="oint-plugin://surface/B/logo.png">` 显示插件 B 的
// **静态资源**（CSP 的 `img-src 'self'` 对同源是放行的）。
//
// 为什么接受：协议**只服务插件包目录**，从不服务插件的私有数据目录
//（`plugins/data/<id>`，那里才可能有密钥与缓存）。所以跨插件能读到的上限是
// "另一个已安装插件里随包分发的图片"，而那对攻击者没有价值 —— 他可以直接去读那个包。
// 要做到逐插件隔离需要按插件分 host，而 id 里的 `_` 与大小写会让 hostname 解析
// 变得依赖具体实现（见 surface-url.ts 的文件头），不值得为这个上限付那个代价。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocol, type Session, session } from "electron";
import { resolveRealPath, validateRealPathAccess } from "@/main/security/path-guard";
import { getPluginRegistry } from "./registry";
import { PLUGIN_SCHEME, parseSurfaceUrl } from "./surface-url";

/**
 * 插件界面的 CSP。
 *
 * 逐条的理由：
 *  - `default-src 'none'` —— 白名单式起步，下面每一条都是显式开口子；
 *  - `script-src 'self'` —— **没有 `'unsafe-inline'`、没有 `'unsafe-eval'`**。
 *    插件的 JS 只能来自它自己的包；
 *  - `style-src 'self' 'unsafe-inline'` —— 样式允许内联（React 一类框架靠注入
 *    `<style>` 工作），而内联样式**不能执行代码**，这是标准取舍；
 *  - `img-src 'self' data: blob:` —— 图标常用 data URI，图表常用 blob；
 *  - `connect-src 'none'` —— **插件界面的出站一律禁用**。要联网就走宿主桥的
 *    `net.fetch`（那里有域名白名单与审计）。这是"审计过的出口"与"任意出口"的分界；
 *  - `frame-src 'none'` / `object-src 'none'` —— 不让插件再嵌一层别人的内容；
 *  - `base-uri 'none'` / `form-action 'none'` —— 堵掉 `<base>` 改写相对路径与表单外发。
 */
const SURFACE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * 扩展名 → Content-Type。
 *
 * 只列插件界面真正用得到的那些。**不认识的扩展名一律 `application/octet-stream`**
 * 并带 `nosniff` —— 猜错的后果是 `.svg` 被当成 HTML 执行（一类真实的 XSS 手法）。
 */
const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** 一律带上这些头（`nosniff` 是防"扩展名猜错"的那一道） */
function baseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    // 只有 HTML 需要 CSP：给一张 png 加 CSP 是无意义的字节
    ...(contentType.startsWith("text/html") ? { "content-security-policy": SURFACE_CSP } : {}),
  };
}

function fail(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/**
 * 注册 scheme 权限位。
 *
 * **必须在 app ready 之前调用**（见文件头）。重复调用无害 —— Electron 允许，
 * 只是后一次会覆盖前一次，而我们传的是同一份常量。
 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        bypassCSP: false,
        allowServiceWorkers: false,
        stream: false,
      },
    },
  ]);
}

/**
 * 装上协议处理器。**在 app ready 之后调用一次。**
 *
 * 每一次请求都要重新查注册表，而不是启动时缓存一份目录表：
 * 插件可以在运行期被启用 / 停用 / 重载，缓存会让"停用之后旧页面还能读到新文件"。
 */
/**
 * 把协议处理器装到**指定 session** 上。
 *
 * ## 为什么必须能装到任意 session（这是一个真的踩过的坑）
 *
 * `protocol.handle(scheme, …)` 只作用于**默认 session**。而插件界面为了隔离
 * `localStorage` 用的是**每个插件自己的分区**（`persist:oint-plugin-<id>`）——
 * 那是另一个 session。
 *
 * 于是默认 session 上的处理器对它**完全不可见**，Chromium 找不到 `oint-plugin://`
 * 的处理器，就按"外部协议"处理 —— Windows 上弹出一个
 * **「获取打开此 oin-plugin 链接的应用」**的系统对话框。
 *
 * 那个弹窗完全不指向真正的原因（看起来像协议没注册，实际是注册在了另一个 session 上），
 * 所以这条注释写长一点。
 */
/**
 * 已经装过协议处理器的 session。
 *
 * **`protocol.handle` 对同一个 scheme 注册两次会抛**（`Failed to register protocol:…`），
 * 而这个函数会被反复调用 —— 每次刷新插件列表都会走一遍 `preparePluginPartitions`，
 * 每次 `verify` 也会。所以必须幂等。
 *
 * 用 WeakSet 而不是 Set：session 的生命周期由 Electron 管，这里只在它活着的时候
 * 记一笔，不参与它的回收。
 */
const handled = new WeakSet<Session>();

export function installPluginProtocolOn(target: Session): void {
  if (handled.has(target)) return;
  /*
    **先注册成功，再记账。**
    反过来的话，`handle` 因为别的原因抛错（scheme 权限位没注册、session 已销毁……）
    会把这个 session 永久标记成"已处理"，之后就再也不重试了 ——
    而症状与"从没装过"完全一样（外部协议弹窗），却没有任何东西指向这一行。
  */
  target.protocol.handle(PLUGIN_SCHEME, async (request) => {
    const parsed = parseSurfaceUrl(request.url);
    if (parsed === null) return fail(400, "Bad plugin surface URL");

    const registry = getPluginRegistry();
    if (!registry.loaded) await registry.reload();

    /*
      **只有已启用且清单合法的插件能服务资源。**
      停用之后旧页面还在（用户没关那个面板），但它的后续请求会 404 ——
      这是刻意的：停用要立刻生效，而不是"等页面关掉之后再生效"。
    */
    const source = registry.enabledSources().find((candidate) => candidate.id === parsed.pluginId);
    if (source === undefined) return fail(404, "Plugin is not enabled");

    const requested = path.join(source.dir, parsed.relativePath);
    /*
      **realpath 围栏。** 上面那层 `parseSurfaceUrl` 已经挡掉了 `..` 与编码变体，
      但挡不住**符号链接**：插件包里放一个指向 `../../..` 的链接就能读出去了。
      这里用与文件工具同一套判据（resolveRealPath + validateRealPathAccess），
      而不是自己写一遍字符串比较 —— 那种"每个入口各写一份围栏"的写法，
      迟早会有一个入口漏掉。
    */
    const resolved = await resolveRealPath(requested);
    const access = await validateRealPathAccess(resolved, [source.dir]);
    if (!access.ok) return fail(403, "Path outside the plugin directory");

    let body: Buffer;
    try {
      body = await readFile(resolved);
    } catch {
      return fail(404, "Not found");
    }

    const contentType = MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(body), { status: 200, headers: baseHeaders(contentType) });
  });
  // 注册成功才记账（见函数开头那段）
  handled.add(target);
}

/** 装到默认 session 上（插件窗口走这条；面板走各自分区的那个重载） */
export function installPluginProtocol(): void {
  installPluginProtocolOn(session.defaultSession);
}
