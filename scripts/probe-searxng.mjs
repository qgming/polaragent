// 一次性探针：验证哪些公共 SearXNG 实例开启了 format=json。
// 用法：node scripts/probe-searxng.mjs
//
// 与 probe-searxng.mts 的分工：
//   · 本脚本**只探测实例本身**（不看应用代码），用于筛选内置清单的候选；
//   · .mts 版本走完整的 provider 代码路径，验证响应映射与回退。
// 更新内置清单时的顺序：先跑本脚本选出候选，再跑 .mts 复测它们真的能用。
import process from "node:process";

const INSTANCES = [
  "https://search.volmute.com",
  "https://google.thejot.org",
  "https://ddg.thejot.org",
  "https://search.thejot.org",
  "https://search.0x7c0.com",
  "https://search.corrently.cloud",
  "https://search.skyday.eu",
  "https://search.chgr.cc",
  "https://search.hirad.it",
  "https://search.jakespeed.org",
  "https://search.no-code.gdn",
  "https://search.notashelf.dev",
  "https://etsi.me",
  "https://searx.party",
  "https://search.mdosch.de",
  "https://search.mectov.my.id",
];

const TIMEOUT_MS = 12_000;
const UA = "oint-searxng-probe/0.1 (+https://github.com/qgming/oint)";

async function probe(instance) {
  const url = new URL("/search", instance);
  url.searchParams.set("q", "searxng json api test");
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    const elapsed = Date.now() - started;
    if (!response.ok) return { instance, ok: false, why: `HTTP ${response.status}`, elapsed };
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const isHtml = text.trimStart().startsWith("<");
      return {
        instance,
        ok: false,
        why: isHtml ? "返回 HTML（未开启 format=json）" : "非 JSON 响应",
        elapsed,
      };
    }
    if (!Array.isArray(data.results)) {
      return { instance, ok: false, why: "JSON 里没有 results 字段", elapsed };
    }
    if (data.results.length === 0) {
      return { instance, ok: false, why: "results 为空", elapsed };
    }
    return { instance, ok: true, count: data.results.length, elapsed };
  } catch (error) {
    return {
      instance,
      ok: false,
      why: error instanceof Error ? error.message : String(error),
      elapsed: Date.now() - started,
    };
  }
}

const results = await Promise.all(INSTANCES.map((instance) => probe(instance)));
const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

console.log("=== 通过（format=json 可用）===");
for (const r of passed.sort((a, b) => a.elapsed - b.elapsed)) {
  console.log(`  ✅ ${r.instance}  (${r.count} 条, ${r.elapsed}ms)`);
}
console.log("\n=== 失败 ===");
for (const r of failed.sort((a, b) => a.elapsed - b.elapsed)) {
  console.log(`  ❌ ${r.instance}  ${r.why}  (${r.elapsed}ms)`);
}
console.log(`\n汇总：${passed.length}/${results.length} 通过`);
process.exit(0);
