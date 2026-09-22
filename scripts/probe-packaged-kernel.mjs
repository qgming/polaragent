// 打包期内核检查：验证 pi 包在 **asar 归档里**依然能被正确解析与加载。
//
// 为什么不能只靠 node 侧探针：打包后 pi 的资源文件住在 asar 里，`providers/all` 要跨 40+
// 个子模块动态 import，JSON 也要从 asar 里读 —— 「node 下能跑」不等于「打包后能跑」。
//
// 两个必须注意的点（本脚本踩过）：
// 1. pi 的包是 **ESM-only**（exports 里只有 import 条件），`require()` 会报
//    「No "exports" main defined」—— 必须用动态 import()；
// 2. 要用 **Electron 的 node 运行时**执行（ELECTRON_RUN_AS_NODE + electron 二进制），
//    否则测的是系统 node 的模块解析，而不是应用真实跑的那一套。
//
// 运行：node scripts/probe-packaged-kernel.mjs
// 说明：不弹窗、不碰用户数据目录。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Electron 二进制：优先本仓安装的那份 */
function resolveElectron() {
  try {
    const p = require("electron");
    if (typeof p === "string" && fs.existsSync(p)) return p;
  } catch {
    // 未安装 electron 时退回系统 node（仍能验证包解析，只是运行时不同）
  }
  return null;
}

/** 候选目标：发布目录里的 asar（打包后），否则退回本仓 node_modules（开发期） */
function resolveTarget() {
  const packaged = path.join(ROOT, "release", "win-unpacked", "resources", "app.asar");
  if (fs.existsSync(packaged)) return { kind: "asar", path: packaged };
  const dev = path.join(ROOT, "node_modules");
  if (fs.existsSync(dev)) return { kind: "node_modules", path: dev };
  return null;
}

const target = resolveTarget();
if (target === null) {
  console.error("找不到可检查的目标（release/win-unpacked 与 node_modules 都不存在）");
  process.exit(1);
}

const electronPath = resolveElectron();
const runtime = electronPath ?? process.execPath;
const runtimeLabel = electronPath ? "Electron(node 模式)" : "系统 node";

console.log("=".repeat(72));
console.log(`打包内核检查`);
console.log(`  目标：${target.kind} → ${target.path}`);
console.log(`  运行时：${runtimeLabel}`);
console.log("=".repeat(72));

/**
 * 在被检查的运行时里执行的脚本。
 *
 * 用 `import.meta.resolve` / 动态 import 走**包自己的 exports 解析**：asar 内的路径映射、
 * 子路径条件导出都在这一步被真实验证 —— 手写路径拼接会绕过 exports，测不出真问题。
 */
const script = `
const results = [];
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ name, ok: false, detail: error && error.message ? error.message : String(error) });
  }
}

await check("pi-ai 根导出（0.86/0.87 新接口）", async () => {
  const ai = await import("@earendil-works/pi-ai");
  const need = ["createModels", "createProvider", "normalizeContext", "getCurrentSystemPrompt", "getSystemMessageText", "createInitialSystemMessage"];
  const missing = need.filter((k) => typeof ai[k] !== "function");
  if (missing.length) throw new Error("缺少导出: " + missing.join(", "));
  return need.length + " 个新接口齐全";
});

await check("pi-agent-core 根导出", async () => {
  const core = await import("@earendil-works/pi-agent-core");
  const need = ["AgentHarness", "BACKGROUND_CONTEXT", "estimateContextTokens", "createBashTool"];
  const missing = need.filter((k) => core[k] === undefined);
  if (missing.length) throw new Error("缺少导出: " + missing.join(", "));
  return need.length + " 个关键导出齐全";
});

await check("providers/all 目录枚举（known-models 的数据源）", async () => {
  const all = await import("@earendil-works/pi-ai/providers/all");
  const providers = all.getBuiltinProviders();
  let total = 0;
  for (const p of providers) total += all.getBuiltinModels(p).length;
  if (providers.length < 40) throw new Error("provider 数量异常: " + providers.length);
  if (!providers.includes("meta") || !providers.includes("radius")) {
    throw new Error("缺少 0.86.0 新增的 meta / radius");
  }
  return providers.length + " 个 provider / " + total + " 个模型";
});

await check("provider 目录 JSON 能从归档里读出来", async () => {
  const m = await import("@earendil-works/pi-ai/providers/amazon-bedrock.models");
  const ids = Object.keys(m.AMAZON_BEDROCK_MODELS);
  if (ids.length === 0) throw new Error("目录为空（JSON 未随包分发？）");
  return "amazon-bedrock " + ids.length + " 个模型";
});

await check("typebox 与内核 schema 互通", async () => {
  const tb = await import("typebox");
  const ai = await import("@earendil-works/pi-ai");
  const schema = tb.Type.Object({ a: tb.Type.String() });
  const ctx = ai.normalizeContext({
    systemPrompt: "s",
    messages: [{ role: "user", content: "u", timestamp: 1 }],
    tools: [{ name: "t", description: "d", parameters: schema }],
  });
  if (!ctx.messages.length) throw new Error("normalizeContext 返回空消息");
  return "typebox " + tb.Type.String().type + " schema 通过 normalizeContext";
});

await check("NodeExecutionEnv.openTextLineReader（0.86.0 新增）", async () => {
  const { NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/harness/env/nodejs");
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  if (typeof env.openTextLineReader !== "function") throw new Error("实例上没有 openTextLineReader");
  return "方法存在且可调用";
});

await check("sqlite 会话后端", async () => {
  const sqlite = await import("@earendil-works/pi-session-backend-sqlite-node");
  const need = ["SqliteSessionRepo", "createNodeSqliteFactory"];
  const missing = need.filter((k) => typeof sqlite[k] !== "function");
  if (missing.length) throw new Error("缺少导出: " + missing.join(", "));
  return need.join(" / ") + " 可用";
});

console.log("__RESULTS__" + JSON.stringify(results));
`;

let raw;
try {
  raw = execFileSync(
    runtime,
    ["--input-type=module", "-e", script],
    {
      cwd: target.kind === "asar" ? path.dirname(target.path) : ROOT,
      env: {
        ...process.env,
        ...(electronPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 180000,
    },
  );
} catch (error) {
  console.error("执行失败：", error.stderr || error.message);
  process.exit(1);
}

const marker = raw.split(/\r?\n/).find((line) => line.startsWith("__RESULTS__"));
if (marker === undefined) {
  console.error("未取到结果，原始输出：\n" + raw);
  process.exit(1);
}

const results = JSON.parse(marker.slice("__RESULTS__".length));
let failed = 0;
for (const [index, result] of results.entries()) {
  if (!result.ok) failed += 1;
  console.log(`STEP ${index + 1} ${result.ok ? "OK  " : "FAIL"} - ${result.name} —— ${result.detail}`);
}
console.log("=".repeat(72));
console.log(`结果：${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
