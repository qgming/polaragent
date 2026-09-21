// 网络工具的真实网络冒烟：抓取与搜索各打一次真实请求。
//
// 用法：npx tsx scripts/probe-web.mts
//
// 为什么单独一个脚本而不是单测：单测必须离线可跑（见 fetch-http.test.ts 顶部），
// 而这里要验证的恰恰是「真实网络下确实能工作」——包括 DNS、TLS、真实页面的 HTML 结构。
// 它也是唯一会打真实搜索网络的自动化入口。
import { createHttpFetchProvider } from "../src/main/web/fetch-http";
import { extractPageText } from "../src/main/web/html";
import { isPublicIpAddress, resolvePublicAddresses } from "../src/main/web/network";

let failures = 0;

function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label.padEnd(42)} ${detail}`);
}

// ---- 1. 公网判定与真实 DNS ----
console.log("== 地址判定（真实 DNS）==");
const allowed: [string, boolean][] = [
  ["example.com", true],
  ["localhost", false],
  ["127.0.0.1", false],
  ["169.254.169.254", false],
];
for (const [host, shouldPass] of allowed) {
  try {
    const addresses = await resolvePublicAddresses(host);
    report(shouldPass, `resolvePublicAddresses(${host})`, addresses.map((a) => a.address).join(", "));
  } catch (error) {
    report(!shouldPass, `resolvePublicAddresses(${host})`, `rejected: ${(error as Error).message}`);
  }
}
report(isPublicIpAddress("8.8.8.8"), "isPublicIpAddress(8.8.8.8)", "true");
report(!isPublicIpAddress("192.168.1.1"), "isPublicIpAddress(192.168.1.1)", "false");

// ---- 2. 真实抓取 ----
console.log("\n== 抓取 ==");
const provider = createHttpFetchProvider({ timeoutMs: 20_000 });

try {
  const started = Date.now();
  const result = await provider.fetch({ url: "https://example.com" });
  report(
    result.statusCode === 200 && result.content.includes("Example Domain"),
    "fetch https://example.com",
    `HTTP ${result.statusCode}, ${result.content.length} 字符, ${Date.now() - started}ms`,
  );
} catch (error) {
  report(false, "fetch https://example.com", `抛错：${(error as Error).message}`);
}

// 私网目标必须被拒
try {
  await provider.fetch({ url: "http://127.0.0.1:1/" });
  report(false, "fetch http://127.0.0.1:1/", "未被拒绝（安全问题）");
} catch (error) {
  report(true, "fetch http://127.0.0.1:1/", `已拒绝：${(error as Error).message}`);
}

// 云元数据必须被拒
try {
  await provider.fetch({ url: "http://169.254.169.254/latest/meta-data/" });
  report(false, "fetch 云元数据", "未被拒绝（安全问题）");
} catch (error) {
  report(true, "fetch 云元数据", `已拒绝：${(error as Error).message}`);
}

// 非 2xx 是结果
try {
  const result = await provider.fetch({ url: "https://example.com/definitely-not-here-12345" });
  report(
    result.statusCode >= 400 || result.statusCode === 200,
    "fetch 不存在的路径",
    `HTTP ${result.statusCode}（非 2xx 是结果而不是错误）`,
  );
} catch (error) {
  report(false, "fetch 不存在的路径", `抛错：${(error as Error).message}`);
}

// ---- 3. 真实页面的 HTML 提取 ----
console.log("\n== HTML 提取（真实页面）==");
try {
  const result = await provider.fetch({ url: "https://example.com" });
  const page = extractPageText(result.content, 5000);
  report(page.content.length > 0, "提取 example.com 正文", `${page.content.length} 字符`);
} catch (error) {
  report(false, "提取 example.com 正文", `抛错：${(error as Error).message}`);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
