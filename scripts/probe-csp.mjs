// CSP 的端到端验证：策略装上之后，界面还活着吗？该拦的真的被拦了吗？
//
// **为什么必须真跑一次**：单测只能证明「策略字符串长这样」，证明不了
// 「Electron 认这条策略、且界面在它之下仍能工作」。而 CSP 配错的典型表现是
// 白屏或局部不渲染 —— 那类回归一旦发出去，用户看到的是「应用打不开」。
// 这里同时验两件事，缺一不可：
//   A. **不误伤**：React 树挂载、样式生效、data: 图片能显示（消息里的图片就是 dataUrl）；
//   B. **真拦得住**：内联脚本被拒、外链图片被拒、eval 被拒。
//
// 用法：node scripts/probe-csp.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = 19355;
const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), "oint-csp-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const env = { ...process.env, OINT_HOME: DATA_DIR };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

let cdp = null;
try {
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

  // --- A. 不误伤：界面必须正常起来 ---
  let uiReady = false;
  for (let i = 0; i < 60 && !uiReady; i += 1) {
    uiReady = await evaluate(cdp, `document.querySelector("aside") !== null`);
    if (!uiReady) await sleep(300);
  }
  check("CSP 之下界面仍能挂载", uiReady, uiReady ? "React 树已提交" : "白屏或挂载超时");

  const stylesApplied = await evaluate(
    cdp,
    `getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"`,
  );
  check(
    "样式生效（style-src 放行行内样式是对的）",
    stylesApplied,
    stylesApplied ? "body 背景色已应用" : "样式未应用 —— style-src 可能过紧",
  );

  // data: 图片必须能显示：消息里的图片附件就是 dataUrl 形态
  const dataImageOk = await evaluate(
    cdp,
    `(async () => {
       const img = document.createElement("img");
       const p = new Promise((resolve) => {
         img.onload = () => resolve(true);
         img.onerror = () => resolve(false);
       });
       img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
       document.body.appendChild(img);
       return p;
     })()`,
  );
  check("data: 图片可显示", dataImageOk === true, dataImageOk ? "1x1 gif 加载成功" : "被 CSP 拦下");

  // --- B. 真拦得住 ---
  const inlineBlocked = await evaluate(
    cdp,
    `(() => {
       const script = document.createElement("script");
       script.textContent = "window.__cspInlineRan = true";
       document.body.appendChild(script);
       return window.__cspInlineRan !== true;
     })()`,
  );
  check("内联脚本被拦下", inlineBlocked === true, inlineBlocked ? "未执行" : "执行了！");

  // eval 必须用**页面上下文**的方式验。
  //
  // 注意：CDP 自己的 `Runtime.evaluate` 按设计**绕开 CSP**（调试器不是页面脚本），
  // 所以直接用 evaluate 去 eval 会得到「执行了」的假失败。这里改用
  // `setTimeout("...")` 的字符串形式 —— 它在页面上下文里求值，受 CSP 管。
  const evalBlocked = await evaluate(
    cdp,
    `(async () => {
       const verdict = await new Promise((resolve) => {
         try { setTimeout("window.__cspEvalRan = true", 0); } catch { resolve(true); return; }
         setTimeout(() => resolve(window.__cspEvalRan !== true), 120);
       });
       return verdict;
     })()`,
  );
  check(
    "页面上下文的 eval 被拦下",
    evalBlocked === true,
    evalBlocked ? "未执行" : "执行了！",
  );

  // 外链图片：加载失败即说明 img-src 没放行 http(s)
  const remoteBlocked = await evaluate(
    cdp,
    `(async () => {
       const img = document.createElement("img");
       const p = new Promise((resolve) => {
         img.onload = () => resolve(false);
         img.onerror = () => resolve(true);
         setTimeout(() => resolve(false), 4000);
       });
       img.src = "https://example.com/favicon.ico";
       document.body.appendChild(img);
       return p;
     })()`,
  );
  check(
    "外链图片被拦下（模型无法用图片外带）",
    remoteBlocked === true,
    remoteBlocked ? "请求被拒" : "竟然加载了",
  );

  const cspViolations = cdp.consoleErrors.filter((text) => /Content Security Policy/i.test(text));
  check("确实有 CSP 违规日志（证明策略生效而非未装上）", cspViolations.length > 0, `${cspViolations.length} 条`);
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nCSP 探针全部通过" : `\nCSP 探针失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
