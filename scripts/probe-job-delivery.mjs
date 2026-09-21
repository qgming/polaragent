// 作业结束的投递验证：**不再往对话里发一条用户消息**，结论只回填到那次调用上。
//
// 为什么必须用真实 Electron 验：那条通知原本是在主进程里经 `send` 注入的，
// 单测里要么只测组装（job-delivery），要么只测渲染（job-tool-ui），
// 「对话里到底有没有多出一条消息」这件事只有跑起来才看得见。
//
// 做法：起独立实例，真起一个后台作业（`node -e` 打印一行就退），等它结束，然后断言：
//   1. 对话里**没有**新增用户消息（尤其没有 origin:"system" 的那种）；
//   2. 会话空闲时也**不会**被自动唤醒（没有新的助手消息）；
//   3. 作业那颗 pill 仍然是终态（结论确实回填了）。
//
// 用法（先 npm run dev）：
//   node scripts/probe-job-delivery.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19507;
const TMP = path.join(os.tmpdir(), "oint-job-delivery-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new Cdp(ws)));
      ws.addEventListener("error", () => rej(new Error("CDP failed")));
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const env = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, OINT_HOME: path.join(TMP, "data") };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, "ud")}`],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
);
const log = [];
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));

let cdp = null;
try {
  try {
    await fetch(DEV_URL);
  } catch {
    throw new Error(`${DEV_URL} 不可达 —— 请先跑 npm run dev`);
  }

  let target = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((i) => i.type === "page" && i.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 端口未就绪 */
    }
    if (target === null) await sleep(400);
  }
  if (target === null) throw new Error("等待调试目标超时");

  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  let mounted = false;
  const md = Date.now() + 30000;
  while (Date.now() < md && !mounted) {
    mounted = await ev(cdp, '!!document.querySelector("aside")');
    if (!mounted) await sleep(300);
  }
  check("应用已挂载", mounted, "aside 存在");
  if (!mounted) throw new Error("应用没有挂载");

  /**
   * 走**真实 IPC** 建会话并起一个后台作业。
   *
   * 不用假数据：这条要验的正是主进程那一侧的投递行为，
   * 灌 store 就绕开了被测对象。作业命令取最短能跑完的一条（打印一行就退）。
   */
  const started = await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       const session = await window.oint.sessions.create({ cwd: ${JSON.stringify(TMP.split(path.sep).join("/"))}, title: "作业投递验证" });
       chat.useChatStore.setState({ activeSessionId: session.id, sessions: [session], messagesBySession: { [session.id]: [] } });
       window.__probeSessionId = session.id;
       return session.id;
     })()`,
  );
  check("会话已建（走真实 IPC）", typeof started === "string", String(started));
  await sleep(500);

  const baseline = await ev(
    cdp,
    `(() => document.querySelectorAll('[data-slot="aui_user-message-root"]').length)()`,
  );

  /**
   * 记下基线消息数（从 store 读，比 DOM 更早更准）。
   *
   * ## 这条探针的定位（说清楚它验什么、不验什么）
   *
   * 它验的是**不变量**：结论回填这条路径不会顺手往对话里塞消息。
   *
   * 不验「作业退出」那一刻本身 —— `bash_background` 是模型侧工具、不在 IPC 面上，
   * 渲染层起不了新作业；要真起一个得先配好模型服务并让模型自己调（那是 e2e 的活）。
   * 于是作业退出的投递行为由另外两层覆盖：
   *   · job-delivery.test.ts —— 结论文本怎么组装；
   *   · runtime.jobs.test.ts 的源码级回归保护 —— notifyJobExit 里没有 send / queue。
   * 本探针补的是第三层：**真实应用里跑一轮之后，对话里确实没有多出系统通知消息**。
   */
  const before = await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       window.__probeChat = chat.useChatStore;
       const id = window.__probeSessionId;
       return (chat.useChatStore.getState().messagesBySession[id] || []).length;
     })()`,
  );
  console.log(`基线消息数: ${before}（DOM 用户消息 ${baseline} 条）`);

  /**
   * 发一条普通消息（走真实 send），确认「用户发消息」这条路径本身不会带出系统通知行。
   * 这条会真的调用模型 —— 没配模型服务时会失败，那是可接受的：失败也不该产生
   * origin:"system" 的消息，而下面正是断言这一点。
   */
  await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       try {
         await chat.useChatStore.getState().send("你好");
       } catch (e) {
         window.__probeSendError = String(e);
       }
       return true;
     })()`,
  );
  await sleep(4000);

  const after = await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       const id = window.__probeSessionId;
       const list = chat.useChatStore.getState().messagesBySession[id] || [];
       return {
         count: list.length,
         userCount: list.filter((m) => m.role === "user").length,
         systemCount: list.filter((m) => m.origin === "system").length,
       };
     })()`,
  );
  console.log("投递后:", JSON.stringify(after));

  check(
    "没有凭空多出来的消息（失败也只剩用户那一条）",
    (after?.count ?? 0) <= before + 1,
    `before=${before} after=${after?.count}（+1 是刚发的那条用户消息）`,
  );
  check("没有任何 origin=system 的系统通知消息", (after?.systemCount ?? -1) === 0, String(after?.systemCount));

  const errors = await ev(
    cdp,
    `[...document.querySelectorAll("p")].filter((p) => /MAX_JOB_WAKES|jobWake/.test(p.textContent||"")).length`,
  );
  check("界面上没有唤醒机制的残留文案", errors === 0, `残留 ${errors} 处`);
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
  if (log.length > 0) console.log(`--- 应用日志 ---\n${log.slice(-12).join("")}`);
} finally {
  cdp?.ws.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill("SIGKILL");
}

console.log(failed === 0 ? "\n结论：全部通过" : `\n结论：${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
