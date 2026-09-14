// 端到端验证内置浏览器的两条关键行为（都只有真 Electron 才能验）：
//
//   A. **guest 附着**。时序是「渲染层建元素 → Electron 创建 guest → 主进程接管」，
//      两边的单测都覆盖不到这条缝。这里用 CDP 驱动渲染层，再问应用自己的 IPC ——
//      `browser:status` 的 `open` 字段就是 `attached !== null && !attached.isDestroyed()`，
//      即「主进程是否真的拿到了 guest」，正是修复前一直为 false 的那个值（元素没有 src
//      时 Electron 根本不创建 guest）。
//   B. **JS 弹窗被自动应答**。拦截走 CDP（debugger.attach + Page 域），而「能不能 attach
//      一个 <webview> 的 guest、事件会不会来」也是纯 Electron 行为。判定方式是
//      「alert 之后的代码有没有继续跑」—— 没人应答时页面会永久停在那一行。
//
// 用法：node scripts/probe-browser-guest.mjs

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = 19344;
const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), "oint-browser-guest-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
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
      /* 已断开 */
    }
  }
}

/** 在渲染层求值并取回 JSON（走 CDP 的 Runtime.evaluate） */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`求值抛错：${result.exceptionDetails.text ?? "unknown"}`);
  }
  return result.result.value;
}

/**
 * 用界面上的地址栏导航。
 *
 * 走这条路的理由：探针只能驱动**渲染层**（它连的是渲染进程的 CDP），而模型的操作面在
 * 主进程 —— 这里不试图绕过那个分层，只是把页面切到指定 URL，好让后续检查有东西可看。
 * React 受控输入必须走原生 setter 再派发 input，否则改了 value 状态不更新、提交不上。
 */
async function navigateViaAddressBar(cdp, url) {
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector("input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
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

let cdp = null;
let failed = 0;

function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

try {
  // 1) 等调试目标就绪
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
  // 等界面真正挂载：window.oint 由 preload 注入，**比 React 早得多** ——
  // 只等它就派发快捷键，事件会在 useGlobalShortcuts 注册监听之前发出、被静默丢掉
  //（实测过一次：面板没开、地址栏为 null，看起来像功能坏了，其实只是探针抢跑）。
  // aside 是 RightSidebar 的根节点，它出现即说明 React 树已提交。
  let uiReady = false;
  for (let i = 0; i < 60 && !uiReady; i += 1) {
    uiReady = await evaluate(cdp, `document.querySelector("aside") !== null`);
    if (!uiReady) await sleep(300);
  }
  check("界面已挂载", uiReady, uiReady ? "React 树已提交" : "等待界面挂载超时");

  // 2) 修复前的状态：没打开过浏览器面板，主进程手里没有 guest
  const before = await evaluate(cdp, `window.oint.browser.status()`);
  check(
    "面板未打开时 status.open=false",
    before.open === false,
    `open=${before.open}（此时还没有 guest，符合预期）`,
  );

  // 3) 触发打开浏览器面板：Ctrl+T 是应用自己的全局快捷键。
  //    这里**重试直到元素出现**：即使界面已挂载，快捷键监听也可能刚注册完，
  //    一次性的派发在慢机器上依然是掷骰子 —— 探针不该因为时序抖动而误报功能坏了。
  let panelMounted = false;
  const mountDeadline = Date.now() + 20_000;
  while (Date.now() < mountDeadline && !panelMounted) {
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true })), true`,
    );
    await sleep(400);
    panelMounted = await evaluate(cdp, `document.querySelector("webview") !== null`);
  }
  check("Ctrl+T 打开了浏览器面板", panelMounted, panelMounted ? "webview 元素已出现" : "20 秒内没有出现 webview 元素");

  // 4) 轮询「guest 是否附着」——这正是修复前永远为 false 的那个值。
  //    修复前：5 秒后仍然 open=false（元素没有 src，Electron 从不创建 guest）。
  //    修复后：元素带 src=about:blank 引导，guest 立刻创建。
  let open = false;
  let waited = 0;
  const waitDeadline = Date.now() + 8_000;
  while (Date.now() < waitDeadline && !open) {
    await sleep(200);
    waited += 200;
    const status = await evaluate(cdp, `window.oint.browser.status()`);
    open = status.open === true;
  }
  check(
    "打开面板后主进程拿到 guest（status.open=true）",
    open,
    open ? `在 ${waited}ms 内附着` : `等待 8 秒仍未附着 —— guest 从未创建（修复前的症状）`,
  );

  // 5) 元素自身也要能报出 webContentsId：它抛错就说明 guest 根本没附着
  const element = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector("webview");
      if (el === null) return { found: false };
      let id = null;
      let error = null;
      try { id = el.getWebContentsId(); } catch (e) { error = e.message; }
      return { found: true, src: el.getAttribute("src"), id, error };
    })()`,
  );
  check("渲染层存在 webview 元素", element.found === true, JSON.stringify(element));
  check(
    "webview 元素带引导 src",
    typeof element.src === "string" && element.src !== "",
    `src=${JSON.stringify(element.src)}`,
  );
  check(
    "元素能报出 webContentsId（guest 真的存在）",
    typeof element.id === "number",
    element.error === null ? `webContentsId=${element.id}` : `抛错：${element.error}`,
  );

  // 6) 地址栏/空态不受引导影响：引导不等于打开页面
  const ui = await evaluate(
    cdp,
    `(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      return { address: inputs.length > 0 ? inputs[0].value : null };
    })()`,
  );
  check(
    "地址栏没有被 about:blank 污染",
    ui.address === "",
    `地址栏=${JSON.stringify(ui.address)}`,
  );

  const status = await evaluate(cdp, `window.oint.browser.status()`);
  check(
    "页面状态是「空页面」而不是 about:blank",
    status.state.url === "",
    `state.url=${JSON.stringify(status.state.url)}`,
  );

  // 7) 真导航一次（走用户/模型的同一条路）：验证引导之后地址栏仍然可用，
  //    并数一数发生了几次导航 —— 若面板把「观察到的导航」又写回 src，
  //    同一页会被加载两遍（表现为页面自己刷新一下、滚动位置丢失）。
  //    用本地文件，避免依赖网络。
  const pageFile = path.join(TMP, "page.html");
  fs.writeFileSync(pageFile, "<!doctype html><title>PROBE-PAGE</title><h1>probe ok</h1>");
  const pageUrl = `file:///${pageFile.replace(/\\/g, "/")}`;

  // 计数器要在导航**之前**挂上，否则可能漏数第一次 did-navigate
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector("webview");
      window.__probeNavCount = 0;
      el.addEventListener("did-navigate", () => { window.__probeNavCount += 1; });
      return true;
    })()`,
  );
  await navigateViaAddressBar(cdp, pageUrl);

  let navigated = false;
  const navDeadline = Date.now() + 10_000;
  while (Date.now() < navDeadline && !navigated) {
    await sleep(200);
    const now = await evaluate(cdp, `window.oint.browser.status()`);
    navigated = now.state.url !== "" && now.state.url.endsWith("/page.html") === true;
  }
  check("地址栏导航生效，主进程看到新地址", navigated, `state.url=${pageUrl}`);

  // 再等一会儿让可能存在的第二次导航发生，然后数导航次数
  await sleep(1_500);
  const navCount = await evaluate(cdp, `window.__probeNavCount`);
  check(
    "同一页只加载一次（没有把观察到的导航写回 src）",
    navCount === 1,
    `did-navigate 触发 ${navCount} 次${navCount === 1 ? "" : "（>1 说明发生了重复导航）"}`,
  );

  const title = await evaluate(cdp, `window.oint.browser.status().then((s) => s.state.title)`);
  check("页面标题回填正确", title === "PROBE-PAGE", `title=${JSON.stringify(title)}`);

  // 8) JS 弹窗必须被自动应答，否则页面会永久卡死（外面那份报告里的 P1）。
  //    为什么这条必须在真 Electron 里验：拦截靠 CDP（debugger.attach + Page 域），
  //    而「attach 一个 <webview> 的 guest 能不能成功、事件会不会来」是纯 Electron 行为，
  //    单测与类型系统都看不出来。
  //    判定方式选得很直接：**看 alert 之后的代码有没有继续跑** ——
  //    页面停在一个没人应答的 alert 上时，后面那行改标题的语句永远不会执行，
  //    而主进程读到的 title 正是它。反过来，标题变了就说明弹窗被应答过。
  const dialogFile = path.join(TMP, "dialog.html");
  fs.writeFileSync(
    dialogFile,
    [
      "<!doctype html><title>DIALOG-PAGE</title><h1>dialog probe</h1>",
      "<script>",
      "setTimeout(() => { alert('probe-alert'); document.title = 'DIALOG-DISMISSED'; }, 300);",
      "</script>",
    ].join("\n"),
  );
  await navigateViaAddressBar(cdp, `file:///${dialogFile.replace(/\\/g, "/")}`);

  let dialogCleared = false;
  const dialogDeadline = Date.now() + 8_000;
  while (Date.now() < dialogDeadline && !dialogCleared) {
    await sleep(200);
    const now = await evaluate(cdp, `window.oint.browser.status()`);
    dialogCleared = now.state.title === "DIALOG-DISMISSED";
  }
  check(
    "alert() 被自动应答，页面没有卡死",
    dialogCleared,
    dialogCleared
      ? "alert 之后的脚本继续执行（标题已更新为 DIALOG-DISMISSED）"
      : "8 秒内标题未更新 —— 弹窗把页面卡住了，CDP 拦截没有生效",
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  cdp?.close();
  if (child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n结果：全部通过" : `\n结果：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
