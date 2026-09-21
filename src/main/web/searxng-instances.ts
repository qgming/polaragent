// 内置 SearXNG 实例清单与解析。
//
// **清单本身住在 shared/contracts/web.ts**（设置面板要显示它，而渲染层不能
// import `src/main/**`）。这里只保留「主进程才需要」的解析逻辑，
// 并把常量重新导出一次，让 main/web 内部的 import 路径保持就近。

import { DEFAULT_SEARXNG_INSTANCES } from "@/shared/contracts/web";

export { DEFAULT_SEARXNG_INSTANCES };

/**
 * 解析用户配置的实例清单（换行或逗号分隔）。
 *
 * 返回的每一项都已归一成 `URL`；非法项被丢弃（用户手写清单时打错字很常见，
 * 不该让整份配置失效）。
 *
 * 空清单 → 回落内置清单：设置面板里「留空则用内置实例」那句承诺的实现点。
 */
export function parseInstanceList(raw: string | undefined): URL[] {
  const custom: URL[] = [];
  const seen = new Set<string>();
  for (const piece of (raw ?? "").split(/[\n,]/)) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    // 只接受 http(s)：实例清单里混进 file:// 或别的协议没有意义
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const key = url.origin;
    if (seen.has(key)) continue;
    seen.add(key);
    custom.push(url);
  }
  if (custom.length > 0) return custom;

  return DEFAULT_SEARXNG_INSTANCES.map((instance) => new URL(instance));
}
