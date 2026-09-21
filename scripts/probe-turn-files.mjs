// 视觉验证：「本轮文件改动」在真实应用里长什么样、点下去有没有反应。
//
// 为什么需要它：组件级测试（TurnFiles.test.tsx / thread-turn-files.test.tsx）证明的是
// 数据链与 DOM 结构，证明不了**样式真的落地了**（Tailwind 类名写错时 DOM 断言照样过），
// 也证明不了右栏查看器能在真实 Electron 里把文件读出来并渲染 markdown。
//
// 做法：起一个独立 user-data-dir 的 Electron 实例（不抢单实例锁）指向 dev server，
// 用 CDP **import 真实的 store 模块**灌一轮「改了 md + txt + html + ts」的消息，
// 再读回真实的几何与文本。
//
// 只在 dev 模式下可用（要 import /src/... 的模块）：
//   终端 A: npm run dev
//   终端 B: node scripts/probe-turn-files.mjs
//
// 它验证四件事：
//   1. 区块出现在真实消息流里，且卡片与 chip 的分流生效；
//   2. 卡片等宽、每行最多 3 张（读真实 rect.width 比对，不是读 class）；
//   3. 点 md 卡片 → 右栏查看器打开该文件，**默认渲染档**（h1 真的出现）；
//   4. 点 html 卡片 → 内置浏览器标签出现并加载 file:// 地址。

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19417;
const TMP = path.join(os.tmpdir(), "oint-turn-files-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
/** 探针自己的工程目录：卡片点开时主进程要真的读得到这里的文件 */
const PROJECT = path.join(TMP, "project");

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

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

// —— 准备一个真工程目录 ——
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(PROJECT, "docs"), { recursive: true });
fs.mkdirSync(path.join(PROJECT, "src"), { recursive: true });
fs.writeFileSync(
  path.join(PROJECT, "docs", "guide.md"),
  "# 指南标题\n\n这是**正文**段落。\n\n- 条目一\n- 条目二\n",
  "utf8",
);
fs.writeFileSync(path.join(PROJECT, "notes.txt"), "第一行\n第二行\n", "utf8");
fs.writeFileSync(path.join(PROJECT, "page.html"), "<h1>本地页面</h1>\n", "utf8");
fs.writeFileSync(path.join(PROJECT, "src", "a.ts"), "export const a = 1;\n", "utf8");

const env = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, OINT_HOME: DATA_DIR };
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

  let mounted = false;
  const mountDeadline = Date.now() + 30_000;
  while (Date.now() < mountDeadline && !mounted) {
    mounted = await evaluate(cdp, `!!document.querySelector("aside")`);
    if (!mounted) await sleep(300);
  }
  check("应用已挂载", mounted, "aside 存在");
  if (!mounted) throw new Error("应用没有挂载，后续断言无法进行");

  /**
   * 灌一轮测试消息。
   *
   * dev 模式下能 import 真实模块，所以直接拿 store 写状态 ——
   * 探针要验的是**渲染与交互**，而让模型真跑一轮需要配模型服务并等它真的写文件
   *（那是 e2e-smoke.mjs 的活，且会引入模型不确定性）。
   *
   * **会话必须先经 IPC 真建出来**：右栏查看器读文件时，主进程是按 sessionId 去
   * **会话索引**里解析根目录的（渲染层给不了 root，见 main/ipc/files.ts）。
   * 只往 store 里塞一条假 session 的话，索引里没有这个 id，读文件会直接失败
   *（探针第一版就是这么错的：界面全对，只是报「读取失败」）。
   */
  const projectPosix = PROJECT.split(path.sep).join("/");
  const injected = await evaluate(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");

       // 走真 IPC 建会话：主进程的会话索引里才会有这个 id 与它的 cwd
       const session = await window.oint.sessions.create({
         cwd: ${JSON.stringify(projectPosix)},
         title: "探针会话",
       });

       const call = (id, i, toolName, p) => ({
         type: "tool-call",
         toolCallId: id + "-" + i,
         toolName,
         argsText: JSON.stringify({ path: p }),
         args: { path: p },
         status: "done",
       });
       const user = {
         id: "u1", role: "user", createdAt: Date.now() - 1000,
         parts: [{ type: "text", text: "写一份指南" }], status: "complete",
       };
       const assistant = {
         id: "a1", role: "assistant", createdAt: Date.now(),
         parts: [
           call("c1", 0, "write", "docs/guide.md"),
           call("c1", 1, "write", "notes.txt"),
           call("c1", 2, "write", "page.html"),
           call("c1", 3, "write", "src/a.ts"),
         ],
         status: "complete",
       };
       chat.useChatStore.setState({
         activeSessionId: session.id,
         sessions: [session],
         messagesBySession: { [session.id]: [user, assistant] },
         // 先标记「整轮还在跑」：这一块**不该**出现（用户报的「中途闪一下」就是它）
         runningBySession: { [session.id]: true },
       });
       window.__probeSessionId = session.id;
       return session.id;
     })()`,
  );
  check("测试数据已灌入 store", typeof injected === "string", `会话 ${injected}：md + txt + html + ts`);

  await sleep(900);

  /**
   * —— 0. **整轮结束时才出块**（用户报的回归点）——
   *
   * 判据必须是「整轮 run 结束」而不是「这一轮里没有工具在跑」：多步 run 的**步骤之间**
   * 恰好满足后者，于是块会中途冒出来、下一步工具一起来又消失。
   *
   * 这里灌的数据**所有工具都是 done、消息也是 complete** —— 正是旧判据会误判成
   * 「跑完了」的形态。只把 runningBySession 设成 true，块就必须按住不出。
   */
  const whileRunning = await evaluate(
    cdp,
    `(() => ({
       hasBlock: document.querySelector('[data-slot="turn-files"]') !== null,
       text: (document.body.textContent || "").includes("本轮文件改动"),
     }))()`,
  );
  check(
    "整轮还在跑时不出这一块（哪怕所有工具都已完成）",
    whileRunning?.hasBlock === false && whileRunning?.text === false,
    JSON.stringify(whileRunning),
  );

  // 标记整轮结束 → 块应当立刻出现
  await evaluate(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       chat.useChatStore.setState({ runningBySession: { [window.__probeSessionId]: false } });
       return true;
     })()`,
  );
  await sleep(700);

  const afterSettle = await evaluate(
    cdp,
    `(() => document.querySelector('[data-slot="turn-files"]') !== null)()`,
  );
  check("整轮结束后这一块出现", afterSettle === true, String(afterSettle));

  // —— 1. 区块出现，且分流正确 ——
  const block = await evaluate(
    cdp,
    `(() => {
       const root = document.querySelector('[data-slot="turn-files"]');
       if (!root) return null;
       const text = root.textContent || "";
       return {
         label: text.includes("本轮文件改动"),
         // chip 与卡片都是 button，用 aria-label 区分：只有卡片带它
         chips: [...root.querySelectorAll("button")].filter((b) => !b.getAttribute("aria-label")).length,
         cardLabels: [...root.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")),
       };
     })()`,
  );
  check("区块已渲染", block !== null, block === null ? "没找到 [data-slot=turn-files]" : "找到了");
  check("标题写着「本轮文件改动」", block?.label === true, String(block?.label));
  check(
    "代码文件只出 chip、文档出卡片",
    block !== null &&
      block.chips === 4 &&
      block.cardLabels.length === 3 &&
      !block.cardLabels.some((l) => l.includes("a.ts")),
    `chips=${block?.chips} cards=${JSON.stringify(block?.cardLabels)}`,
  );

  // —— 2. 卡片等宽、最多 3 列 ——
  const grid = await evaluate(
    cdp,
    `(() => {
       const root = document.querySelector('[data-slot="turn-files"]');
       const cards = [...root.querySelectorAll("button[aria-label]")];
       const rects = cards.map((c) => c.getBoundingClientRect());
       return {
         widths: rects.map((r) => Math.round(r.width)),
         tops: rects.map((r) => Math.round(r.top)),
         gap: getComputedStyle(cards[0].parentElement).gap,
         columns: getComputedStyle(cards[0].parentElement).gridTemplateColumns.split(" ").length,
       };
     })()`,
  );
  const widths = grid?.widths ?? [];
  const sameWidth = widths.length > 1 && new Set(widths).size === 1;
  const sameRow = (grid?.tops ?? []).length > 1 && new Set(grid?.tops).size === 1;
  check("卡片等宽", sameWidth, JSON.stringify(widths));
  check("3 张卡片在同一行（≤3 列不换行）", sameRow && grid?.columns === 3, JSON.stringify(grid));

  /**
   * 右栏是**第二个 aside**（第一个是左侧会话栏，宽度 240）。
   * 两处细节：
   *   · 面板收起时宽度是 0 且带 inert，所以必须先点卡片把它打开；
   *   · 读内容要等文件真的从主进程读回来（IPC + 渲染），所以等的是 h1 出现，
   *     而不是固定 sleep —— 固定等待在慢机器上会假红。
   */
  const RIGHT_PANEL = `[...document.querySelectorAll("aside")].find((a) => a.getAttribute("aria-label") === "右侧面板")`;

  // —— 3. 点 md 卡片 → 右栏查看器，默认渲染档 ——
  await evaluate(
    cdp,
    `(() => {
       const root = document.querySelector('[data-slot="turn-files"]');
       const card = [...root.querySelectorAll("button[aria-label]")].find((b) =>
         (b.getAttribute("aria-label") || "").includes("guide.md"));
       card.click();
       return true;
     })()`,
  );

  // 等右栏把文件读回来并渲染出 h1（最多 8 秒）
  let viewer = null;
  const viewDeadline = Date.now() + 8000;
  while (Date.now() < viewDeadline) {
    viewer = await evaluate(
      cdp,
      `(() => {
         const aside = ${RIGHT_PANEL};
         if (!aside) return null;
         const h1 = aside.querySelector("h1");
         return {
           open: !aside.hasAttribute("inert"),
           tabText: (aside.textContent || "").includes("guide.md"),
           heading: h1 ? h1.textContent : null,
           hasRenderedToggle: !!aside.querySelector('[aria-label="渲染显示"]'),
           hasSourceToggle: !!aside.querySelector('[aria-label="源码显示"]'),
           errorText: (aside.textContent || "").includes("读取失败"),
         };
       })()`,
    );
    if (viewer?.heading !== null && viewer?.heading !== undefined) break;
    if (viewer?.errorText === true) break;
    await sleep(300);
  }
  check("右栏已展开", viewer?.open === true, JSON.stringify({ open: viewer?.open }));
  check("右栏打开了该文件（标签名是文件名）", viewer?.tabText === true, JSON.stringify(viewer));
  check(
    "markdown 默认按渲染显示（h1 真的渲染出来）",
    viewer?.heading === "指南标题",
    String(viewer?.heading ?? viewer?.errorText),
  );
  check(
    "给了渲染/源码两个切换按钮",
    viewer?.hasRenderedToggle === true && viewer?.hasSourceToggle === true,
    JSON.stringify({ r: viewer?.hasRenderedToggle, s: viewer?.hasSourceToggle }),
  );

  // —— 4. 切到源码档 ——
  await evaluate(cdp, `${RIGHT_PANEL}.querySelector('[aria-label="源码显示"]').click()`);
  await sleep(600);
  const source = await evaluate(
    cdp,
    `(() => {
       const aside = ${RIGHT_PANEL};
       const pre = aside.querySelector("pre");
       return { text: pre ? pre.textContent : null, stillHeading: !!aside.querySelector("h1") };
     })()`,
  );
  check(
    "切到源码后看到原始 markdown",
    (source?.text ?? "").includes("# 指南标题"),
    JSON.stringify((source?.text ?? "").slice(0, 40)),
  );
  check("源码档不再有渲染出来的 h1", source?.stillHeading === false, String(source?.stillHeading));

  // —— 5. 点 html 卡片 → 内置浏览器加载 file:// ——
  await evaluate(
    cdp,
    `(() => {
       const root = document.querySelector('[data-slot="turn-files"]');
       const card = [...root.querySelectorAll("button[aria-label]")].find((b) =>
         (b.getAttribute("aria-label") || "").includes("page.html"));
       card.click();
       return true;
     })()`,
  );

  // 等 webview 元素的 src 被设成 file:// 地址
  let browser = null;
  const browserDeadline = Date.now() + 8000;
  while (Date.now() < browserDeadline) {
    browser = await evaluate(
      cdp,
      `(() => {
         const aside = ${RIGHT_PANEL};
         const webview = aside.querySelector("webview");
         return {
           tabCount: aside.querySelectorAll('[aria-label="关闭标签"]').length,
           src: webview ? webview.getAttribute("src") : null,
         };
       })()`,
    );
    if ((browser?.src ?? "").startsWith("file:///")) break;
    await sleep(300);
  }
  check(
    "HTML 用内置浏览器打开（file:// 地址）",
    (browser?.src ?? "").startsWith("file:///"),
    String(browser?.src),
  );
  check(
    "复用了同一个浏览器标签（没有为第二个文件再开一个）",
    (browser?.tabCount ?? 99) <= 2,
    `标签数=${browser?.tabCount}（文件查看器 + 浏览器）`,
  );

  const errors = cdp.consoleErrors.filter((text) => !text.includes("Download the React DevTools"));
  check("渲染期无控制台报错", errors.length === 0, errors.slice(0, 3).join(" | ") || "无");
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
  if (appLog.length > 0) console.log(`--- 应用日志（末尾）---\n${appLog.slice(-12).join("")}`);
} finally {
  cdp?.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill("SIGKILL");
}

console.log(failed === 0 ? "\n结论：全部通过" : `\n结论：${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
