// dev 模式渲染验证：`npm run dev` 起来之后界面**真的挂载了吗**。
//
// 为什么需要它：白屏是「没有报错也说得通」的故障 —— CSP 拦掉 React Refresh preamble 时，
// vite 照常 connected、控制台甚至照常打印别的信息，只有一句 preamble 报错，
// 而表现是一整片空白。所以要有**正向证据**（React 树已提交），不能只看「没报错」。
//
// 用法（先另开一个终端跑 `npm run dev`，等它 ready）：
//   node scripts/probe-dev-render.mjs [devServerUrl]
//
// 它启动**第二个** Electron 实例（独立 user-data-dir，不抢单实例锁）指向同一个
// dev server，然后用 CDP 读渲染状态。这样不需要改任何配置就能拿到 dev 模式的真实证据。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19399;
const TMP = path.join(os.tmpdir(), "oint-dev-render-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        this.consoleErrors.push(msg.params.entry.text ?? "");
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")));
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已经关了 */
    }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "求值失败");
  }
  return result.result.value;
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

const env = {
  ...process.env,
  // 关键：让主进程走 loadURL(devServerUrl) 那条路，从而装上 dev 版 CSP
  VITE_DEV_SERVER_URL: DEV_URL,
  OINT_HOME: DATA_DIR,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
);
const appLog = [];
child.stdout.on("data", (d) => appLog.push(String(d)));
child.stderr.on("data", (d) => appLog.push(String(d)));

let cdp = null;
try {
  // dev server 必须已经在跑
  try {
    await fetch(DEV_URL);
  } catch {
    throw new Error(`${DEV_URL} 不可达 —— 请先在另一个终端跑 npm run dev`);
  }

  let target = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && target === null) {
    if (child.exitCode !== null) throw new Error(`应用提前退出，exitCode=${child.exitCode}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 端口未就绪 */
    }
    if (target === null) await sleep(400);
  }
  if (target === null) throw new Error("等待调试目标超时");

  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  // 正向证据：aside 是 RightSidebar 的根节点，它出现即说明 React 树已提交
  let mounted = false;
  for (let i = 0; i < 60 && !mounted; i += 1) {
    mounted = await evaluate(cdp, `document.querySelector("aside") !== null`);
    if (!mounted) await sleep(300);
  }
  check("React 树已挂载（dev 不是白屏）", mounted, mounted ? "aside 已渲染" : "白屏");

  const rootChildren = await evaluate(
    cdp,
    `document.getElementById("root")?.childElementCount ?? -1`,
  );
  check("#root 有子节点", rootChildren > 0, `childElementCount=${rootChildren}`);

  const bodyBg = await evaluate(
    cdp,
    `getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"`,
  );
  check("样式已生效", bodyBg, bodyBg ? "body 有背景色" : "样式未应用");

  const preambleOk = await evaluate(cdp, `typeof window.$RefreshReg$ === "function"`);
  check(
    "React Refresh preamble 已执行（CSP 放行了行内脚本）",
    preambleOk,
    preambleOk ? "$RefreshReg$ 已定义" : "preamble 未执行 —— dev 的 script-src 又缺 unsafe-inline",
  );

  const cspViolations = cdp.consoleErrors.filter((text) =>
    /Content Security Policy/i.test(text),
  );
  check("没有 CSP 违规", cspViolations.length === 0, `${cspViolations.length} 条`);
  for (const violation of cspViolations) console.log(`       ${violation.slice(0, 160)}`);

  const preambleErrors = appLog.filter((line) => /can't detect preamble/i.test(line));
  check("没有 preamble 报错", preambleErrors.length === 0, `${preambleErrors.length} 条`);
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\ndev 渲染：通过" : `\ndev 渲染：失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
