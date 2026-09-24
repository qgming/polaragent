// 插件出站请求的判据。
//
// **纯函数、无 electron 依赖** —— 这是"net.domains 到底管住了什么"的唯一实现，
// 每一条规则都要能单测。真正的请求在 ipc/surface.ts。
//
// ## 为什么不能简单地做字符串包含
//
// 最朴素的写法是 `url.includes(domain)`，而它有一整类绕过：
// `https://evil.com/?x=api.example.com`、`https://api.example.com.evil.com/`。
// 所以判据是**先解析成 URL、再比 host**。
//
// ## 四条规则
//
//  1. **只允许 http/https**：`file:` 能读本地文件，`data:`/`blob:` 能绕过来源检查；
//  2. **host 必须在白名单里**：`*.example.com` 匹配子域，**不匹配 `example.com` 本身**
//    （规范里 `*` 就是一个标签，而"子域通配顺带包含根域"是各家实现的常见分歧 ——
//     这里选严格的那个，因为写 `*.example.com` 的人要的通常就是子域）；
//  3. **字面量私网地址拒绝**：`http://127.0.0.1:8080` 打的是用户自己的机器；
//  4. **重定向要逐跳检查**（在调用方）：允许的主机可以把人转到任意地方，
//     只查第一跳等于没查。

/** 拒绝的原因（给插件作者看的一句话） */
export interface UrlBlocked {
  ok: false;
  reason: string;
}

export type UrlDecision = { ok: true; url: URL; host: string } | UrlBlocked;

/** 只允许这两种协议 —— 见文件头第 1 条 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 私网 / 回环 / 链路本地的**字面量**地址。
 *
 * ⚠️ **这不等于防住了 SSRF**：一个在白名单里的域名可以解析到 `127.0.0.1`
 *（DNS rebinding 或作者自己配的 A 记录），而字面量检查看不见那个。
 * 完整防护要在 DNS 解析之后按 IP 判，那需要自己接管解析 —— 代价与收益不成比例，
 * 因为插件的白名单是**用户在安装时看过的**。这里挡的是"直接写个私网地址"，
 * 而那条是最容易被写出来的一种。
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // 链路本地（云元数据服务在这里）
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 唯一本地地址
];

/** 这个 host 是否命中白名单里的某一项 */
export function isHostAllowed(host: string, domains: readonly string[]): boolean {
  const target = host.toLowerCase();
  for (const entry of domains) {
    const rule = entry.trim().toLowerCase();
    if (rule === "") continue;
    if (rule.startsWith("*.")) {
      /*
        通配只覆盖**子域**，且必须至少多一个标签：
        `*.example.com` 匹配 `a.example.com` 与 `a.b.example.com`，
        **不匹配** `example.com`（严格解释，见文件头第 2 条）。

        比的是 `endsWith("." + suffix)` 而不是 `endsWith(suffix)` ——
        后者会让 `evil-example.com` 命中 `*.example.com` 的 suffix 部分。
      */
      const suffix = rule.slice(2);
      if (target === suffix) continue;
      if (target.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (target === rule) return true;
  }
  return false;
}

/**
 * 判一个出站 URL 能不能发。
 *
 * @param domains 清单里 `net.domains` 的内容。**空数组 = 什么都不许** ——
 *   "没写"与"写了个 `*`"在语义上都该是拒绝，而后者在校验器那层已经被拒了。
 */
export function checkOutboundUrl(raw: string, domains: readonly string[]): UrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw}` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      reason: `只允许 http/https 出站，收到 ${url.protocol}`,
    };
  }

  const host = url.hostname.toLowerCase();
  if (host === "") return { ok: false, reason: "URL 里没有主机名" };

  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      return { ok: false, reason: `不允许访问本机/内网地址：${host}` };
    }
  }

  if (!isHostAllowed(host, domains)) {
    return {
      ok: false,
      reason:
        domains.length === 0
          ? `插件没有声明 net.domains，不能发起出站请求`
          : `${host} 不在插件的出站白名单里（${domains.join(", ")}）`,
    };
  }

  return { ok: true, url, host };
}
