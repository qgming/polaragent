// 端到端：走**真实的工具对象**（buildTools 装配出来的那两个），
// 用内核的 AgentHarnessTool 契约调用它们 —— 这条链路是模型实际走的那条。
//
// 用法：npx tsx scripts/probe-web-tools.mts
//
// 与其它探针的分工：
//   · probe-web.mts          → 抓取后端与地址判定
//   · probe-searxng.mts      → provider 与实例
//   · probe-web-service.mts  → 生产装配（设置刷新、上限、provider 选择）
//   · 本脚本                  → **工具层**：schema、details 形状、错误文案、
//                             以及「模型看到的文本」到底长什么样
//
// 为什么需要它：单测里的工具层用的是假 WebService（见 tools/web.test.ts），
// 假实现永远返回"形状正确"的数据；而真实 provider 的返回是否恰好能过
// details 的字段校验、格式化后的文本是否可读，只有把两边接起来才知道。
import { buildTools } from "../src/main/pisdk/tools";
import { createProductionWebService } from "../src/main/web";
import { DEFAULT_SETTINGS } from "../src/main/settings/store";
import type { Settings } from "../src/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS, WEB_TOOL_NAMES } from "../src/shared/contracts/web";

let failures = 0;
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
}

const settings: Settings = { ...DEFAULT_SETTINGS, webSearch: { ...DEFAULT_WEB_SEARCH_SETTINGS } };
const web = createProductionWebService({ getSettings: async () => settings });

// ---- 1. 装配：工具真的在工具表里 ----
console.log("== 装配 ==");
// buildTools(extra, ask, jobs, browser, subagents, web) —— 只有第 6 个参数给了实现
const tools = buildTools([], undefined, [], undefined, [], web);
const searchTool = tools.find((tool) => tool.name === WEB_TOOL_NAMES.search);
const fetchTool = tools.find((tool) => tool.name === WEB_TOOL_NAMES.fetch);
report(Boolean(searchTool), "web_search 已装配", searchTool?.label ?? "缺失");
report(Boolean(fetchTool), "web_fetch 已装配", fetchTool?.label ?? "缺失");
report(
  searchTool?.parameters !== undefined && fetchTool?.parameters !== undefined,
  "两个工具都有 parameters",
  "（内核契约要求）",
);

/** 按内核契约调用工具，取出「模型看到的文本」与 details */
async function call(
  tool: NonNullable<typeof searchTool>,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = await tool.execute(
    "probe-call",
    params as never,
    () => {},
    { env: {} } as never,
    {} as never,
    {} as never,
  );
  const first = result.content[0];
  return {
    text: first !== undefined && first.type === "text" ? first.text : "",
    details: result.details,
  };
}

// ---- 2. 失败路径：SSRF 目标 ----
console.log("\n== 失败路径（模型会看到的文案）==");
if (fetchTool !== undefined) {
  const blocked = await call(fetchTool, { url: "http://169.254.169.254/latest/meta-data/" });
  report(
    blocked.text.startsWith("Error:") && blocked.text.includes("public internet addresses"),
    "云元数据被拒且文案可操作",
    blocked.text.split("\n")[0]?.slice(0, 62) ?? "",
  );
  // details 在失败时也必须是完整形状（渲染层按它画卡片，缺字段会崩）
  const details = blocked.details as Record<string, unknown> | undefined;
  report(
    details !== undefined &&
      typeof details.url === "string" &&
      typeof details.statusCode === "number" &&
      typeof details.truncated === "boolean",
    "失败时 details 形状仍完整",
    JSON.stringify(details),
  );
}

// ---- 3. 成功路径：真实检索 ----
console.log("\n== 真实检索（模型看到的文本）==");
if (searchTool !== undefined) {
  const started = Date.now();
  const found = await call(searchTool, { query: "electron webview tag", limit: 3 });
  const lines = found.text.split("\n").filter((line) => line.startsWith("- ["));
  report(lines.length > 0, "返回来源列表", `${lines.length} 行, ${Date.now() - started}ms`);
  report(
    found.text.startsWith("External web content follows."),
    "以不可信内容提示开头",
    found.text.slice(0, 44),
  );
  report(
    found.text.includes("Cite the relevant URLs"),
    "以引用指引结尾",
    found.text.slice(-46).replace(/\n/g, " "),
  );

  // details 必须是渲染层能解析的形状
  const details = found.details as Record<string, unknown> | undefined;
  report(
    details !== undefined &&
      typeof details.provider === "string" &&
      Array.isArray(details.sources) &&
      typeof details.truncated === "boolean",
    "details 可被渲染层解析",
    `provider=${String(details?.provider)}, sources=${Array.isArray(details?.sources) ? details.sources.length : "?"}`,
  );

  console.log("\n--- 模型实际看到的文本（前 6 行）---");
  console.log(found.text.split("\n").slice(0, 6).join("\n"));
}

// ---- 4. 抓取成功路径 ----
console.log("\n== 真实抓取 ==");
if (fetchTool !== undefined) {
  const page = await call(fetchTool, { url: "https://example.com", maxChars: 400 });
  // 注意尾斜杠：URL 会经 new URL() 归一，空路径会补成 "/"（这是对的，不是 bug）
  report(
    page.text.startsWith("Fetched https://example.com/ (HTTP 200)"),
    "头部形状正确",
    page.text.split("\n")[0] ?? "",
  );
  const details = page.details as Record<string, unknown> | undefined;
  report(
    details?.statusCode === 200 && typeof details?.url === "string",
    "details 带最终 URL 与状态码",
    `HTTP ${String(details?.statusCode)}`,
  );
  console.log("\n--- 模型实际看到的文本 ---");
  console.log(page.text);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
