// 事件链侦察：在真实 Electron 里跑一轮对话，抓 `chat:event` 上到底来了哪些事件类型。
//
// 用途：底部状态条不显示时，区分「主进程没发」与「渲染层没接住」——
// 直接把事件名与关键载荷打出来，不靠猜。
//
// 用法（先另开终端跑 `npm run dev`，并设 OINT_PROBE_API_KEY）：
//   OINT_PROBE_API_KEY=... node scripts/probe-stats-events.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19407;
const TMP = path.join(os.tmpdir(), "oint-stats-events");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
const BASE_URL = process.env.OINT_PROBE_BASE_URL ?? "https://ai.qgming.com/v1";
const API_KEY = process.env.OINT_PROBE_API_KEY ?? "";
const MODEL_ID = process.env.OINT_PROBE_MODEL ?? "deepseek-v4-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
  return result.result.value;
}

if (API_KEY === "") {
  console.log("需要 OINT_PROBE_API_KEY（真实端点才能跑出一轮对话）");
  process.exit(1);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

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

let cdp = null;
let ws = null;
try {
  await fetch(DEV_URL);
  let target = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((i) => i.type === "page" && i.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 未就绪 */
    }
    if (target === null) await sleep(400);
  }
  if (target === null) throw new Error("等待调试目标超时");

  ws = new WebSocket(target.webSocketDebuggerUrl);
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
  cdp = {
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

  // 安装事件抓取器：包住 store.applyEvent，记录每个事件的类型
  await evaluate(
    cdp,
    `(() => {
      const store = window.__ointChatStore;
      if (!store) return false;
      window.__probeEvents = [];
      const original = store.getState().applyEvent;
      // 从 store 本身拿：setState 里替换 applyEvent 不可行（它是 action），
      // 改为订阅（zustand 的 subscribe 只给 state，所以直接包 store.setState 之外的路）
      const seen = window.__probeEvents;
      const originalSetState = store.setState;
      store.setState = (partial, replace) => {
        const before = store.getState();
        const result = originalSetState(partial, replace);
        const after = store.getState();
        for (const key of ["statsBySession", "tokenUsageBySession", "breakdownBySession"]) {
          if (after[key] !== before[key]) {
            seen.push({ key, value: after[key] });
          }
        }
        return result;
      };
      void original;
      return true;
    })()`,
  );

  // 配好服务并跑一轮
  const configured = await evaluate(
    cdp,
    `(async () => {
      const settings = await window.oint.settings.read();
      const next = {
        ...settings,
        services: [{
          id: "probe",
          name: "Probe",
          baseUrl: ${JSON.stringify(BASE_URL)},
          apiKey: ${JSON.stringify(API_KEY)},
          wireFormat: "openai-completions",
          models: [{ id: ${JSON.stringify(MODEL_ID)}, name: "Probe Model", contextWindow: 128000 }],
        }],
        defaultModel: { serviceId: "probe", modelId: ${JSON.stringify(MODEL_ID)} },
        permissionMode: "full",
      };
      await window.oint.settings.write(next);
      return true;
    })()`,
  );
  console.log(`配置写入：${configured}`);

  // 新建会话并发送一句极短的消息
  const sent = await evaluate(
    cdp,
    `(async () => {
      const session = await window.oint.sessions.create({ title: "probe-stats" });
      await window.oint.chat.send(session.id, "只回复两个字：你好", []);
      return session.id;
    })()`,
  );
  console.log(`已发送到会话：${sent}`);

  // 等 25 秒收事件
  await sleep(25_000);

  const captured = await evaluate(cdp, `window.__probeEvents ?? []`);
  const keys = captured.map((c) => c.key);
  const counts = keys.reduce((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
  console.log("\n=== 渲染层收到的分片更新次数 ===");
  console.log(JSON.stringify(counts, null, 2));

  const lastStats = [...captured].reverse().find((c) => c.key === "statsBySession");
  const lastUsage = [...captured].reverse().find((c) => c.key === "tokenUsageBySession");
  const lastBreakdown = [...captured].reverse().find((c) => c.key === "breakdownBySession");
  console.log("\n=== 最后一次 statsBySession ===");
  console.log(JSON.stringify(lastStats?.value ?? null, null, 2));
  console.log("=== 最后一次 tokenUsageBySession ===");
  console.log(JSON.stringify(lastUsage?.value ?? null, null, 2));
  console.log("=== 最后一次 breakdownBySession ===");
  console.log(JSON.stringify(lastBreakdown?.value ?? null, null, 2));

  // 状态条是否渲染
  const barText = await evaluate(
    cdp,
    `document.querySelector('[data-slot="composer-stats"]')?.textContent ?? "(状态条不存在)"`,
  );
  console.log(`\n=== 状态条文本 ===\n${barText}`);
} catch (error) {
  console.log(`侦察异常：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* 已关 */
  }
  child.kill();
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}
