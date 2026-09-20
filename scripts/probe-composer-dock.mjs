// 底栏间距与不透明度的渲染验证：`npm run dev` 起来之后，用 CDP 量**真实像素**。
//
// 为什么必须量而不是看代码：间距是 flex + margin + padding 叠加的结果，
// 「输入框 → 状态条 → 窗口底边」两段到底各是多少 px，只有 getBoundingClientRect 说了算；
// 「底栏不透明」也只有渲染后的 background-color 能证明。
//
// 用法（先另开一个终端跑 `npm run dev`）：
//   node scripts/probe-composer-dock.mjs [devServerUrl]
//
// 它启动第二个 Electron 实例（独立 user-data-dir，不抢单实例锁），用 CDP 注入一段会话数据
// 让状态条真的出现，然后逐项测量。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19401;
const TMP = path.join(os.tmpdir(), "oint-dock-probe");
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
      /* 已关 */
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

  // 等 React 树提交（输入框出现即说明对话区已渲染）
  // 注意：Composer 根是 assistant-ui 的 form，没有 data-slot，只能从脚注里找
  let mounted = false;
  for (let i = 0; i < 60 && !mounted; i += 1) {
    mounted = await evaluate(
      cdp,
      `document.querySelector('[data-slot="aui_thread-viewport-footer"] form') !== null`,
    );
    if (!mounted) await sleep(300);
  }
  check("对话区已挂载（能找到输入框）", mounted, mounted ? "脚注里的 form 已渲染" : "未找到输入框");
  if (!mounted) throw new Error("输入框未渲染，无法测量底栏");

  /**
   * 状态条在「有统计、有用量」时才渲染。真实会话要跑一轮才有数据，
   * 这里通过 store 直接注入两个分片 —— 量的是布局，不是数据链
   *（数据链已由 composer-stats-wiring.test.tsx 覆盖）。
   * store 出口由 main.tsx 在 DEV 下挂到 window.__ointChatStore。
   */
  const storeReady = await evaluate(cdp, `typeof window.__ointChatStore?.getState === "function"`);
  check("dev store 出口可用", storeReady, storeReady ? "window.__ointChatStore 已挂载" : "缺失");
  if (!storeReady) throw new Error("store 出口缺失 —— main.tsx 的 DEV 分支没有生效");

  const injected = await evaluate(
    cdp,
    `(() => {
      const store = window.__ointChatStore;
      const stats = {
        turns: 1, steps: 25,
        llmMs: 351000, toolMs: 12500,
        ttftMs: 13700, ttftSteps: 1,
        decodeMs: 8000, decodeTokens: 13184,
      };
      const usage = {
        uncachedInputTokens: 72388, outputTokens: 14153,
        cacheReadTokens: 1054208, cacheWriteTokens: 0,
      };
      const state = store.getState();
      // 空会话（还没建过）时先撑起一个会话 id：状态条按会话分片读取，
      // activeSessionId 为 null 时它整条不渲染，布局就没得量
      const sessionId = state.activeSessionId ?? "probe-dock-session";
      store.setState({
        activeSessionId: sessionId,
        messagesBySession: { ...state.messagesBySession, [sessionId]: state.messagesBySession[sessionId] ?? [] },
        loadedSessions: { ...state.loadedSessions, [sessionId]: true },
        statsBySession: { ...state.statsBySession, [sessionId]: stats },
        tokenUsageBySession: { ...state.tokenUsageBySession, [sessionId]: usage },
      });
      return { sessionId, ok: true };
    })()`,
  );
  check("会话统计数据已注入", injected?.ok === true, `sessionId=${injected?.sessionId}`);

  // 等状态条出现
  let hasBar = false;
  for (let i = 0; i < 20 && !hasBar; i += 1) {
    hasBar = await evaluate(cdp, `document.querySelector('[data-slot="composer-stats"]') !== null`);
    if (!hasBar) await sleep(200);
  }

  if (!hasBar) {
    check("状态条渲染出来了", false, "注入数据后仍未出现 —— 选择器或订阅有问题");
  } else {
    check("状态条渲染出来了", true, "composer-stats 已在 DOM 里");
    const metrics = await evaluate(
      cdp,
      `(() => {
        const bar = document.querySelector('[data-slot="composer-stats"]');
        // 输入框根是脚注里的 form（assistant-ui 的 ComposerPrimitive.Root，无 data-slot）
        const composer = document.querySelector('[data-slot="aui_thread-viewport-footer"] form');
        const dock = bar?.parentElement ?? null;
        const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, height: r.height } : null; };
        const composerRect = composer ? rect(composer) : null;
        const barRect = rect(bar);
        const dockRect = rect(dock);
        const style = dock ? getComputedStyle(dock) : null;
        return {
          gapAbove: composerRect && barRect ? Math.round(barRect.top - composerRect.bottom) : null,
          gapBelow: barRect ? Math.round(window.innerHeight - barRect.bottom) : null,
          dockBg: style?.backgroundColor ?? null,
          dockPaddingTop: style?.paddingTop ?? null,
          dockPaddingBottom: style?.paddingBottom ?? null,
          dockBorderTop: style?.borderTopWidth ?? null,
          footerPaddingBottom: getComputedStyle(document.querySelector('[data-slot="aui_thread-viewport-footer"]')).paddingBottom,
          dockRect, barRect, composerRect,
          barText: (bar?.textContent ?? "").trim(),
          viewportHeight: window.innerHeight,
        };
      })()`,
    );

    check(
      "输入框 → 状态条 的间距 = 3px",
      metrics.gapAbove === 3,
      `实测 ${metrics.gapAbove}px（底栏 padding-top=${metrics.dockPaddingTop}，胶囊自身无纵向 margin）`,
    );
    check(
      "状态条 → 窗口底边 的间距 = 3px",
      metrics.gapBelow === 3,
      `实测 ${metrics.gapBelow}px（底栏 padding-bottom=${metrics.dockPaddingBottom}）`,
    );
    check(
      "底栏不透明（消息不再从输入框下方透出）",
      typeof metrics.dockBg === "string" && !/rgba\(0, 0, 0, 0\)|transparent/.test(metrics.dockBg),
      `background-color = ${metrics.dockBg}`,
    );
    check(
      "底栏一直铺到窗口底边（下方无留白）",
      metrics.dockRect !== null && Math.abs(metrics.dockRect.bottom - metrics.viewportHeight) <= 1,
      `dock.bottom=${metrics.dockRect?.bottom} vs innerHeight=${metrics.viewportHeight}`,
    );
    check(
      "输入区域上方没有分割线",
      metrics.dockBorderTop === "0px",
      `底栏 border-top-width = ${metrics.dockBorderTop}`,
    );
    console.log(`       状态条文本：${metrics.barText}`);
  }
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n底栏间距：通过" : `\n底栏间距：失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
