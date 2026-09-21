// 生产装配的端到端验证：走 createProductionWebService → 真实网络。
//
// 用法：npx tsx scripts/probe-web-service.mts
//
// 为什么需要它：单测里的 service 全是假 provider（见 service.test.ts），
// 装配层（index.ts）的接线（设置刷新、provider 注册、超时现取）**没有任何自动化覆盖** ——
// 而 pisdk 那边踩过一次「算出来了但没传」的坑（见 runtime.ts 关于系统提示的注释）。
// 这个脚本就是把那条缝补上。
import { createProductionWebService } from "../src/main/web";
import { DEFAULT_SETTINGS } from "../src/main/settings/store";
import type { Settings } from "../src/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../src/shared/contracts/web";

let failures = 0;
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label.padEnd(38)} ${detail}`);
}

/** 可控的设置源：改它就能验证「改设置立即生效」 */
let current: Settings = {
  ...DEFAULT_SETTINGS,
  webSearch: { ...DEFAULT_WEB_SEARCH_SETTINGS },
};
const service = createProductionWebService({ getSettings: async () => current });

console.log("== 搜索（默认 SearXNG）==");
try {
  const started = Date.now();
  const result = await service.search({ query: "electron webview guest attach" });
  const first = result.sources[0];
  report(
    result.sources.length > 0,
    "search 免 Key 可用",
    `${result.sources.length} 条, provider=${result.provider}, 实例=${result.instance?.replace("https://", "")}, ${Date.now() - started}ms`,
  );
  report(Boolean(first?.url?.startsWith("http")), "返回可用的 URL", first?.url ?? "（无）");
} catch (error) {
  report(false, "search 免 Key 可用", `失败：${(error as Error).message.slice(0, 100)}`);
}

console.log("\n== 上限强制 ==");
try {
  const result = await service.search({ query: "electron", maxResults: 3 });
  report(result.sources.length <= 3, "maxResults 被服务层夹住", `${result.sources.length} 条`);
} catch (error) {
  report(false, "maxResults 被服务层夹住", (error as Error).message.slice(0, 80));
}

console.log("\n== 设置即时生效 ==");
// 关掉开关之后立刻应该被拒（验证「每次调用现取设置」真的生效）
current = { ...current, webSearch: { ...current.webSearch, enabled: false } };
try {
  await service.search({ query: "electron" });
  report(false, "关掉开关后立即拒绝", "未被拒绝");
} catch (error) {
  report(/关闭/.test((error as Error).message), "关掉开关后立即拒绝", (error as Error).message);
}
current = { ...current, webSearch: { ...current.webSearch, enabled: true } };

// 换成没有 Key 的 provider：应报「缺 Key」而不是静默走 SearXNG
current = { ...current, webSearch: { ...current.webSearch, provider: "tavily" } };
try {
  await service.search({ query: "electron" });
  report(false, "缺 Key 的 provider 被拒绝", "未报错");
} catch (error) {
  report(/API Key|设置/.test((error as Error).message), "缺 Key 的 provider 被拒绝", (error as Error).message.slice(0, 80));
}
current = { ...current, webSearch: { ...current.webSearch, provider: "searxng" } };

console.log("\n== 抓取 ==");
try {
  const result = await service.fetch({ url: "https://example.com" });
  report(result.statusCode === 200 && result.content.length > 0, "fetch example.com", `${result.content.length} 字符`);
} catch (error) {
  report(false, "fetch example.com", (error as Error).message.slice(0, 80));
}
try {
  await service.fetch({ url: "http://169.254.169.254/" });
  report(false, "fetch 云元数据被拒", "未被拒绝（安全问题）");
} catch (error) {
  report(/非公网/.test((error as Error).message), "fetch 云元数据被拒", (error as Error).message.slice(0, 60));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
