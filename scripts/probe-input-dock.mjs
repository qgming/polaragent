// 视觉验证：输入框上方的停靠区（任务清单 + 待发送队列）在真实 Electron 里长什么样。
//
// 为什么需要它：组件测试证明的是 DOM 结构与数据链，证明不了**位置与形态**真的对 ——
// 「贴在输入框上沿、圆角只在顶部、宽度与输入框一致」全是 CSS 的事，
// Tailwind 类名写错时 DOM 断言照样全绿。这里量的是真实几何与计算样式。
//
// 与 probe-composer-dock.mjs 的分工：那个量的是**输入框下方**（状态条间距、底栏不透明度），
// 本文件量的是**输入框上方**（停靠区位置、圆角、队列交互）。
//
// 用法（先另开一个终端跑 `npm run dev`）：
//   node scripts/probe-input-dock.mjs [devServerUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19489;
const TMP = path.join(os.tmpdir(), "oint-input-dock-probe");
const OUT = path.resolve("shot-input-dock.png");
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

  // 灌入：一条带 todo 的助手消息 + 两条排队消息（一条 steer）
  const script = [
    "(async () => {",
    '  const chat = await import("/src/renderer/stores/chat-store.ts");',
    "  const todos = [",
    '    { id: "1", text: "读代码，梳理现有渲染链", status: "done" },',
    '    { id: "2", text: "把任务清单迁到输入框上方", status: "active" },',
    '    { id: "3", text: "对齐 DSH 的队列样式与功能", status: "pending" },',
    '    { id: "4", text: "补测试并在真实应用里验证", status: "pending" },',
    "  ];",
    "  const part = {",
    '    type: "tool-call", toolCallId: "c1", toolName: "todo",',
    '    argsText: "{}", args: { todos }, details: { todos, revision: 3 }, status: "done",',
    "  };",
    '  const session = { id: "s-dock", title: "停靠区验证", createdAt: Date.now(), updatedAt: Date.now(), cwd: "", archived: false, pinned: false, messageCount: 2, model: null };',
    "  chat.useChatStore.setState({",
    '    activeSessionId: "s-dock",',
    "    sessions: [session],",
    "    messagesBySession: { 's-dock': [",
    '      { id: "u1", role: "user", createdAt: Date.now() - 1000, parts: [{ type: "text", text: "开始吧" }], status: "complete" },',
    '      { id: "a1", role: "assistant", createdAt: Date.now(), status: "complete", parts: [part] },',
    "    ]},",
    '    queueBySession: { "s-dock": [',
    '      { id: "q1", text: "顺便把右侧面板的图标换一下", mode: "steer" },',
    '      { id: "q2", text: "然后补一条回归测试", mode: "followUp" },',
    "    ]},",
    '    runningBySession: { "s-dock": true },',
    "  });",
    "  return true;",
    "})()",
  ].join("\n");
  await ev(cdp, script);
  await sleep(1200);

  // —— 几何与位置 ——
  const geo = await ev(
    cdp,
    `(() => {
       const dock = document.querySelector('[data-slot="composer-dock"]');
       const todo = document.querySelector('[data-slot="composer-dock-todo"]');
       const queue = document.querySelector('[data-slot="composer-dock-queue"]');
       const input = document.querySelector('textarea');
       if (!dock || !todo || !queue || !input) {
         return { missing: { dock: !dock, todo: !todo, queue: !queue, input: !input } };
       }

       /**
        * 量输入框的**最外层**外壳，不能量 input.closest('div[class*=rounded-]')：
        * 那会选到内层的 AttachmentDropzone（它也带 rounded-[24px]），而它在 Root 的
        * 1px 边框以内 —— 量出来永远比停靠区小 2px，于是「同宽」这条断言假红
        *（第一版探针就这么错过）。这里向上找到第一个带 border 的祖先，那才是 Root。
        */
       let shell = input.parentElement;
       while (shell && !/border/.test(shell.className || "")) shell = shell.parentElement;
       const compose = (shell || input.parentElement).getBoundingClientRect();

       const d = dock.getBoundingClientRect();
       const t = todo.getBoundingClientRect();
       const q = queue.getBoundingClientRect();
       const cs = getComputedStyle(dock);
       const todoStyle = getComputedStyle(todo);
       return {
         dockTop: Math.round(d.top), dockBottom: Math.round(d.bottom), dockWidth: Math.round(d.width),
         dockLeft: Math.round(d.left - compose.left), dockRight: Math.round(compose.right - d.right),
         todoTop: Math.round(t.top), todoBottom: Math.round(t.bottom),
         queueTop: Math.round(q.top), queueBottom: Math.round(q.bottom),
         composerTop: Math.round(compose.top), composerWidth: Math.round(compose.width),
         radiusTop: cs.borderTopLeftRadius, radiusBottom: cs.borderBottomLeftRadius,
         // 块之间的分隔线画在**下一块的上边框**上（见 DockSection 的 divided）
         queueBorderTop: getComputedStyle(queue).borderTopWidth,
         todoText: (todo.textContent || "").slice(0, 30),
         queueText: (queue.textContent || "").slice(0, 30),
       };
     })()`,
  );
  console.log("几何:", JSON.stringify(geo));

  check("任务清单在输入框上方", (geo.todoBottom ?? 1e9) <= (geo.composerTop ?? 0) + 2, `todo.bottom=${geo.todoBottom} composer.top=${geo.composerTop}`);
  check("队列在清单之下、输入框之上", (geo.queueBottom ?? 1e9) <= (geo.composerTop ?? 0) + 2, `queue.bottom=${geo.queueBottom} composer.top=${geo.composerTop}`);
  // 宽度：输入框的 90%（用户明确要求），居中 —— 左右各留 5%，
  // 落在输入框 24px 圆角之外，因此不会与那段圆弧错位
  const ratio = (geo.dockWidth ?? 0) / (geo.composerWidth ?? 1);
  check(
    "停靠区宽度约为输入框的 90%",
    Math.abs(ratio - 0.9) <= 0.03,
    `dock=${geo.dockWidth} composer=${geo.composerWidth} ratio=${ratio.toFixed(3)}`,
  );
  // 居中：左右留白相等（差 2px 以内）。
  // 注意 left / right 都是**相对输入框左右边缘**量的：左边留白 = dock.left - composer.left，
  // 右边留白 = composer.right - dock.right。两边相等即居中，不需要再掺 composerWidth。
  check(
    "停靠区居中（左右留白相等）",
    Math.abs((geo.dockLeft ?? 0) - (geo.dockRight ?? 0)) <= 2,
    `left=${geo.dockLeft} right=${geo.dockRight}`,
  );
  check(
    "四角都是圆角（下沿不再敞开接输入框）",
    geo.radiusTop === "12px" && geo.radiusBottom === "12px",
    `top=${geo.radiusTop} bottom=${geo.radiusBottom}`,
  );
  check(
    "与输入框之间留了缝（不再无缝相接）",
    (geo.composerTop ?? 0) - (geo.dockBottom ?? 0) >= 3,
    `gap=${(geo.composerTop ?? 0) - (geo.dockBottom ?? 0)}px`,
  );
  check("两块之间有分隔线", geo.queueBorderTop === "1px", `queue.border-top=${geo.queueBorderTop}`);
  check("任务清单显示进度", (geo.todoText ?? "").includes("1/4"), geo.todoText);
  check("队列显示条数", (geo.queueText ?? "").includes("2 条待发送"), geo.queueText);

  // —— 展开任务清单 ——
  await ev(cdp, `document.querySelector('[data-slot="composer-dock-todo"] button').click()`);
  await sleep(500);
  const expanded = await ev(
    cdp,
    `(() => {
       const todo = document.querySelector('[data-slot="composer-dock-todo"]');
       const items = [...todo.querySelectorAll("li")];
       return {
         count: items.length,
         texts: items.map((li) => (li.textContent || "").trim()),
         glyphs: items.map((li) => { const s = li.querySelector("svg"); return s ? s.getAttribute("class") : null; }),
       };
     })()`,
  );
  check("展开后四条都在", expanded.count === 4, `count=${expanded.count} texts=${JSON.stringify(expanded.texts)}`);
  check("进行中那条是旋转环（蓝色）", (expanded.glyphs ?? []).some((g) => (g ?? "").includes("animate-spin")), String(expanded.glyphs?.[1]));
  check("已完成那条是绿勾", (expanded.glyphs ?? []).some((g) => (g ?? "").includes("text-emerald-500")), String(expanded.glyphs?.[0]));

  /**
   * —— 队列行的移除：点击真的到达按钮 ——
   *
   * 这里**故意不去替换 window.oint.chat.cancelQueued** 来"记账"。
   * contextBridge 暴露出去的对象在渲染层是**冻结**的（实测 `writable: false`），
   * 赋值会静默失败 —— 第一版探针就是这么写的，于是无论点击是否生效，
   * 记到的永远是 null，看起来像"按钮坏了"，其实测的是探针自己。
   *
   * 换成三条真能观测的证据：
   *   1. 按钮存在、可命中（elementFromPoint 落在它自己或子元素上）；
   *   2. 投递**真实受信任的鼠标事件**（CDP Input.dispatchMouseEvent，按 CSS 像素坐标）
   *      后，document 上能捕获到 trusted 的 click，且 target 在该按钮内；
   *   3. 点击后主进程真的把这条撤销了 —— 队列由 queue-updated 事件驱动，
   *      条目从界面上消失即证明整条链路（渲染层 → IPC → 内核 → 事件回流）走通。
   *
   * 合成事件（页面内 dispatchEvent）不算数：isTrusted 为 false，Radix 的
   * TooltipTrigger 不把它当一次真实交互（同一按钮在 jsdom 里 fireEvent.click 是通过的，
   * 说明按钮本身没问题）。
   */
  const box = await ev(
    cdp,
    `(() => {
       const queue = document.querySelector('[data-slot="composer-dock-queue"]');
       const btn = queue.querySelector("li button");
       if (!btn) return null;
       const r = btn.getBoundingClientRect();
       const cx = Math.round(r.left + r.width / 2);
       const cy = Math.round(r.top + r.height / 2);
       const hit = document.elementFromPoint(cx, cy);
       return {
         x: cx, y: cy,
         label: btn.getAttribute("aria-label"),
         hitIsButtonOrChild: hit ? (hit === btn || btn.contains(hit)) : false,
         queueRowsBefore: queue.querySelectorAll("li").length,
       };
     })()`,
  );
  check("队列行里有移除按钮，且坐标可命中", box !== null && box.hitIsButtonOrChild === true, JSON.stringify(box));

  /**
   * 装两层观测：
   *   1. 捕获阶段的 click 监听 —— 确认**真实受信任**的事件到了队列块；
   *   2. 包一层 store 的 cancelQueued —— 确认 React 的 onClick 真的触发了这个动作。
   *
   * 为什么包 store 而不是包 `window.oint.chat.cancelQueued`：contextBridge 暴露的对象
   * 在渲染层是冻结的（`Object.getOwnPropertyDescriptor(...).writable === false`，实测），
   * 赋值会**静默失败** —— 第一版探针就栽在这上面，无论点击是否生效记到的永远是 null。
   * store 是我们自己 import 出来的普通对象，可以放心替换。
   */
  await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       window.__probeClicks = [];
       window.__probeStoreCalls = [];
       document.addEventListener("click", (e) => {
         const q = document.querySelector('[data-slot="composer-dock-queue"]');
         window.__probeClicks.push({
           trusted: e.isTrusted,
           insideQueue: q ? q.contains(e.target) : false,
         });
       }, true);
       const original = chat.useChatStore.getState().cancelQueued;
       chat.useChatStore.setState({
         cancelQueued: async (id) => {
           window.__probeStoreCalls.push(id);
           return original(id);
         },
       });
       return true;
     })()`,
  );

  if (box !== null) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1,
    });
    await sleep(700);
  }

  const clicked = await ev(
    cdp,
    `({ clicks: window.__probeClicks, storeCalls: window.__probeStoreCalls })`,
  );
  console.log("点击诊断:", JSON.stringify(clicked));
  check(
    "真实（受信任的）点击到达队列块",
    (clicked?.clicks ?? []).some((c) => c.trusted === true && c.insideQueue === true),
    JSON.stringify(clicked?.clicks),
  );
  // 这一条才是「按钮真的接线了」的证据：事件 → React onClick → store 动作。
  // 再往下（store → IPC → 内核 → queue-updated 回流）需要**真会话**才走得通，
  // 而探针灌的是假会话（主进程没有它的 runtime）—— 那一段由
  // ComposerDock.test.tsx 的「点移除会走 IPC」与主进程的 runtime 测试覆盖。
  check(
    "点击触发了撤销动作（带那条的 id）",
    (clicked?.storeCalls ?? []).includes("q1"),
    JSON.stringify(clicked?.storeCalls),
  );
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`截图: ${OUT}`);
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
  if (appLog.length > 0) console.log(`--- 应用日志 ---\n${appLog.slice(-12).join("")}`);
} finally {
  cdp?.ws.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill("SIGKILL");
}

console.log(failed === 0 ? "\n结论：全部通过" : `\n结论：${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
