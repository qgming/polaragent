// Electron 会话级安全：CSP 注入、权限白名单、导航与 webview 防护。
// 决策逻辑尽量做成纯函数，便于在无 Electron 运行时的 vitest 中单测。
import type { Session } from "electron";

export type AppUiKind = "dev" | "prod" | "office" | "other";

// 权限白名单：默认拒绝，仅放行产品明确需要的能力
const ALLOWED_PERMISSIONS = new Set([
  "media", // getUserMedia 麦克风录音
  "clipboard-sanitized-write",
  "fullscreen",
]);

// 判断请求是否属于应用 UI（用于决定是否注入 CSP）
function classifyAppUi(url: string, devServerUrl?: string | null): AppUiKind {
  const raw = String(url || "");
  if (!raw) return "other";
  if (devServerUrl && raw.startsWith(devServerUrl)) return "dev";
  if (raw.startsWith("file:")) {
    // 应用自身 dist/index.html 或同源静态资源；office 临时 HTML 用独立 partition，不走这里
    if (/dist[\\/]index\.html/i.test(raw) || /dist[\\/]/i.test(raw)) return "prod";
  }
  return "other";
}

// 组装 CSP 字符串。dev 需放行 HMR 的 ws/http，以及 Vite React Refresh 的内联 preamble。
function buildCsp(options: { mode: "dev" | "prod" }): string {
  const connect = ["'self'"];
  const script = ["'self'"];
  if (options.mode === "dev") {
    connect.push("ws:", "http://127.0.0.1:1420", "http://localhost:1420");
    // @vitejs/plugin-react 注入 inline preamble；不加会导致 dev 白屏
    script.push("'unsafe-inline'");
  }
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    // Tailwind / 内联样式 + 外链字体（用户资料渲染）
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' blob: data:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

// 权限决策：默认 false
function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(String(permission || ""));
}

// 仅允许 http/https 外部打开
function isSafeExternalUrl(url: unknown): boolean {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// 应用 UI 导航白名单：dev server 或 file 的 dist 资源
function isAllowedAppNavigation(url: string, devServerUrl?: string | null): boolean {
  const kind = classifyAppUi(url, devServerUrl);
  return kind === "dev" || kind === "prod";
}

// 安装默认会话上的 CSP / 权限 / webview 防护
function installSessionSecurity(session: Session, options?: { devServerUrl?: string | null }) {
  const devServerUrl = options?.devServerUrl ?? process.env.VITE_DEV_SERVER_URL ?? null;
  const devCsp = buildCsp({ mode: "dev" });
  const prodCsp = buildCsp({ mode: "prod" });

  session.webRequest.onHeadersReceived((details, callback) => {
    const kind = classifyAppUi(details.url, devServerUrl);
    const responseHeaders = { ...details.responseHeaders };
    if (kind === "dev" || kind === "prod") {
      responseHeaders["Content-Security-Policy"] = [kind === "dev" ? devCsp : prodCsp];
    }
    callback({ responseHeaders });
  });

  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isPermissionAllowed(permission));
  });

  session.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission));
}

// 给单个窗口挂导航与 webview 防护
function hardenWebContents(
  webContents: Electron.WebContents,
  options?: { devServerUrl?: string | null },
) {
  const devServerUrl = options?.devServerUrl ?? process.env.VITE_DEV_SERVER_URL ?? null;

  webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppNavigation(url, devServerUrl)) {
      event.preventDefault();
    }
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

export {
  ALLOWED_PERMISSIONS,
  classifyAppUi,
  buildCsp,
  isPermissionAllowed,
  isSafeExternalUrl,
  isAllowedAppNavigation,
  installSessionSecurity,
  hardenWebContents,
};
