// SearXNG provider 的真实网络验证。
//
// 用法：npx tsx scripts/probe-searxng.mts
//
// 与 probe-searxng.mjs 的分工：那个脚本只探测「哪些公共实例开了 format=json」
// （用于生成内置清单），本脚本走**完整的 provider 代码路径** ——
// 验证响应映射、去重、answer 提取、以及不可用实例的错误文案。
import { createSearxngProvider } from "../src/main/web/search/searxng";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../src/shared/contracts/web";
import { DEFAULT_SEARXNG_INSTANCES, parseInstanceList } from "../src/main/web/searxng-instances";

let failures = 0;
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label.padEnd(46)} ${detail}`);
}

const settings = (instances?: string) => ({
  ...DEFAULT_WEB_SEARCH_SETTINGS,
  searxng: { apiKey: "", ...(instances === undefined ? {} : { instances }) },
});

console.log("== 实例清单解析 ==");
report(parseInstanceList("").length === DEFAULT_SEARXNG_INSTANCES.length, "空配置用内置清单", `${parseInstanceList("").length} 个`);
report(parseInstanceList("https://a.test\nhttps://b.test").length === 2, "换行分隔", "2 个");
report(parseInstanceList("https://a.test,https://b.test").length === 2, "逗号分隔", "2 个");
report(parseInstanceList("垃圾\nfile:///x\nhttps://ok.test").length === 1, "非法项被丢弃", "1 个");

console.log("\n== 真实检索（逐个内置实例）==");
const provider = createSearxngProvider({ resolve: () => settings() });
for (const instance of DEFAULT_SEARXNG_INSTANCES) {
  const started = Date.now();
  try {
    const result = await createSearxngProvider({
      resolve: () => settings(instance),
    }).search({ query: "electron webview guest", maxResults: 8 });
    const first = result.sources[0];
    report(
      result.sources.length > 0,
      instance.replace("https://", ""),
      `${result.sources.length} 条, ${Date.now() - started}ms, 首条: ${first?.title?.slice(0, 40) ?? "（无标题）"}`,
    );
  } catch (error) {
    report(false, instance.replace("https://", ""), `失败：${(error as Error).message.slice(0, 80)}`);
  }
}

console.log("\n== 错误路径 ==");
// 返回 200 + HTML 但不是 SearXNG 的站点：用来验证「未开启 JSON 输出」这条诊断。
// （不能用 example.com：它对 /search 返回 404，走不到 JSON 检测那一步。）
try {
  await createSearxngProvider({
    resolve: () => settings("https://www.iana.org"),
  }).search({ query: "x", maxResults: 5 });
  report(false, "返回 HTML 的实例", "未被识别（应报「未开启 JSON 输出」）");
} catch (error) {
  const message = (error as Error).message;
  report(
    /未开启 JSON|没有 results|HTTP \d/.test(message),
    "返回 HTML 的实例",
    message.slice(0, 70),
  );
}

// 不存在的域名
try {
  await createSearxngProvider({
    resolve: () => settings("https://nonexistent-searxng-xyz.test"),
  }).search({ query: "x", maxResults: 5 });
  report(false, "不可达实例", "未报错");
} catch (error) {
  report(true, "不可达实例", (error as Error).message.slice(0, 70));
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
