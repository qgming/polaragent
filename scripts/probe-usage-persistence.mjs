// 用量持久化端到端验证（不需要 API key）：预置索引 → 启动 → 底栏显示 → 重启 → 仍在。
//
// 验的是**读回路径**：sessions-index.json 里的用量快照 → 主进程 IPC 带回 →
// store 分片 → 底栏 DOM。这条链断了就是用户看到的「底部空着」。
// 写盘路径（runtime 在 run_end 落盘）由 session-store / runtime 的单测覆盖。
//
// 为什么用预置文件而不是真跑一轮：真跑需要 API key；而持久化的价值恰恰是
// 「进程重启后数据还在」，用磁盘上的既有数据启动正好模拟这个场景。
//
// 用法（先另开终端跑 `npm run dev`）：
//   node scripts/probe-usage-persistence.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const TMP = path.join(os.tmpdir(), "oint-usage-persist");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

/** 一份「看起来像跑过一轮」的用量快照 */
const USAGE = {
  stats: {
    turns: 1,
    steps: 25,
    llmMs: 351_000,
    toolMs: 12_500,
    ttftMs: 13_700,
    ttftSteps: 1,
    decodeMs: 8_000,
    decodeTokens: 13_184,
  },
  tokenUsage: {
    uncachedInputTokens: 72_388,
    outputTokens: 14_153,
    cacheReadTokens: 1_054_208,
    cacheWriteTokens: 0,
  },
  breakdown: { systemTokens: 1_800, toolsTokens: 7_100, messageTokens: 63_800 },
};

async function launch(port) {
  const env = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, OINT_HOME: DATA_DIR };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronPath,
    [".", `--remote-debugging-port=${port}`, `--user-data-dir=${USER_DATA}`],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let target = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && target === null) {
    if (child.exitCode !== null) throw new Error(`应用提前退出 exitCode=${child.exitCode}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((i) => i.type === "page" && i.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 未就绪 */
    }
    if (target === null) await sleep(400);
  }
  if (target === null) throw new Error("等待调试目标超时");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 1;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  });
  await new Promise((res) => ws.addEventListener("open", res));
  const cdp = {
    ws,
    send(method, params = {}) {
      const myId = id++;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
  };
  await cdp.send("Runtime.enable");
  await sleep(6000);
  return { cdp, child };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
  return result.result.value;
}

/** 读底栏的实测状态 */
async function readBar(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const bar = document.querySelector('[data-slot="composer-stats"]');
      if (!bar) return { exists: false };
      const r = bar.getBoundingClientRect();
      return {
        exists: true,
        empty: bar.getAttribute("data-empty") === "true",
        text: (bar.textContent ?? "").trim(),
        height: Math.round(r.height),
        bottom: Math.round(r.bottom),
      };
    })()`,
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA_DIR, "sessions"), { recursive: true });

try {
  await fetch(DEV_URL);

  // ---- 第一次启动：建一个会话，拿到它的 id ----
  const first = await launch(19411);
  let sessionId = null;
  let emptyBar = null;
  try {
    sessionId = await evaluate(
      first.cdp,
      `(async () => {
        const session = await window.oint.sessions.create({ title: "persist-probe" });
        return session.id;
      })()`,
    );
    // 打开这个空会话，量「没有数据」时的底栏高度（用作恒定高度的基准）
    await evaluate(
      first.cdp,
      `(async () => {
        const store = window.__ointChatStore;
        await store.getState().setActiveSession(${JSON.stringify(sessionId)});
        return true;
      })()`,
    );
    await sleep(1200);
    emptyBar = await readBar(first.cdp);
    check("空会话也渲染底栏（占位行存在）", emptyBar.exists, `存在=${emptyBar.exists}`);
    check(
      "空会话底栏标记为空态",
      emptyBar.empty === true,
      `data-empty=${emptyBar.empty}`,
    );
  } finally {
    first.cdp.ws.close();
    first.child.kill();
    await sleep(2500);
  }

  // ---- 进程已退出：把用量快照写进索引文件（模拟上一轮 run_end 的落盘结果）----
  const indexPath = path.join(DATA_DIR, "sessions-index.json");
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};
  index[sessionId] = { ...(index[sessionId] ?? {}), usage: USAGE };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  check("索引文件已写入用量快照", true, `${Object.keys(index).length} 条会话记录`);

  // ---- 第二次启动：不跑对话，直接打开旧会话 ----
  const second = await launch(19413);
  try {
    const restored = await evaluate(
      second.cdp,
      `(async () => {
        const store = window.__ointChatStore;
        await store.getState().setActiveSession(${JSON.stringify(sessionId)});
        const state = store.getState();
        const id = ${JSON.stringify(sessionId)};
        return {
          steps: state.statsBySession[id]?.steps ?? null,
          turns: state.statsBySession[id]?.turns ?? null,
          cacheRead: state.tokenUsageBySession[id]?.cacheReadTokens ?? null,
          output: state.tokenUsageBySession[id]?.outputTokens ?? null,
          breakdown: state.breakdownBySession[id] ?? null,
        };
      })()`,
    );
    check("重启后 store 恢复 steps", restored.steps === 25, `steps=${restored.steps}`);
    check("重启后 store 恢复 turns", restored.turns === 1, `turns=${restored.turns}`);
    check(
      "重启后 store 恢复 Token 桶",
      restored.cacheRead === 1_054_208 && restored.output === 14_153,
      `cacheRead=${restored.cacheRead}, output=${restored.output}`,
    );
    check(
      "重启后 store 恢复上下文分解",
      restored.breakdown !== null && restored.breakdown.toolsTokens === 7_100,
      JSON.stringify(restored.breakdown),
    );

    await sleep(1200);
    const bar = await readBar(second.cdp);
    check("重启后底栏渲染出数据", bar.exists && bar.empty !== true, `data-empty=${bar.empty}`);
    check(
      "底栏文本含轮/步与 tok/s",
      /1 轮 25 步/.test(bar.text) && /1648 tok\/s/.test(bar.text),
      `文本：${bar.text}`,
    );
    check(
      "底栏文本含 Token 总量与缓存命中",
      /1\.1M tok/.test(bar.text) && /缓存命中 94%/.test(bar.text),
      `文本：${bar.text}`,
    );

    // ---- 恒定高度：有数据 vs 空会话，两次实测必须相等 ----
    const filledHeight = bar.height;
    const emptyHeight = emptyBar.height;
    check(
      "有数据 / 无数据的底栏高度一致",
      filledHeight === emptyHeight,
      `有数据 ${filledHeight}px vs 空态 ${emptyHeight}px`,
    );

    // ---- 底栏仍铺到窗口底边，间距不随数据变化 ----
    const gap = await evaluate(
      second.cdp,
      `(() => {
        const bar = document.querySelector('[data-slot="composer-stats"]');
        const form = document.querySelector('[data-slot="aui_thread-viewport-footer"] form');
        const br = bar.getBoundingClientRect();
        const fr = form.getBoundingClientRect();
        return {
          above: Math.round(br.top - fr.bottom),
          below: Math.round(window.innerHeight - br.bottom),
        };
      })()`,
    );
    check("输入框 → 底栏间距仍为 3px", gap.above === 3, `实测 ${gap.above}px`);
    check("底栏 → 窗口底边间距仍为 3px", gap.below === 3, `实测 ${gap.below}px`);
  } finally {
    second.cdp.ws.close();
    second.child.kill();
    await sleep(2500);
  }
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n用量持久化：通过" : `\n用量持久化：失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
