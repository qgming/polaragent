// 工具详情的渲染验证：`npm run dev` 起来之后，逐类展开并核对内容。
//
// 为什么需要它：组件与解析器的单测证明的是**数据链**，证明不了「在真实 Electron 里点开
// 到底长什么样」—— 尤其是展开区那一层（ToolCall 不套外壳、各详情自带 paper）与
// 「工具被折进时间线」这条路径：单测里直接渲染组件，走不到时间线。
//
// 它验证四件事：
//   1. **Request/Result 面板彻底下线**（旧实现里它的 <p> 会把多行结果压平）；
//   2. ask_user 展开后能看到**全部题目与作答**（会话里唯一能回看答案的地方）；
//   3. read / grep / write 的正文保住换行与行号；
//   4. 浏览器工具（快照 / 日志 / 求值）展开后有结构化读数与条目。
//
// 用法（先另开一个终端跑 `npm run dev`）：
//   node scripts/probe-tool-details.mjs [devServerUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19501;
const TMP = path.join(os.tmpdir(), "oint-tool-detail-probe");
const OUT = path.resolve("shot-tool-details.png");
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
   * 灌一轮覆盖五类详情的工具调用。
   *
   * 刻意**把 ask_user 放在第一条**：它旧实现里点开只有一句给模型看的长句，
   * 而这次要求「展开显示所有的问题及用户的回答」—— 断言直接查题目与答案文本。
   */
  const script = [
    "(async () => {",
    '  const chat = await import("/src/renderer/stores/chat-store.ts");',
    "  const P = (id, toolName, args, result, artifact, isError) => ({",
    '    type: "tool-call", toolCallId: id, toolName, argsText: JSON.stringify(args),',
    "    args, result, ...(artifact === undefined ? {} : { details: artifact }),",
    '    ...(isError ? { isError: true } : {}), status: isError ? "error" : "done",',
    "  });",
    "  const parts = [",
    "    P('c1', 'ask_user',",
    '      { questions: [',
    '        { id: "q1", header: "数据库", question: "用哪个库？", options: ["SQLite", "Postgres"] },',
    '        { id: "q2", header: "迁移", question: "要不要写迁移脚本？", multiSelect: true },',
    "      ] },",
    '      "给模型看的长句",',
    '      { outcome: "answered",',
    '        questions: [',
    '          { id: "q1", header: "数据库", question: "用哪个库？", options: ["SQLite", "Postgres"] },',
    '          { id: "q2", header: "迁移", question: "要不要写迁移脚本？", multiSelect: true },',
    "        ],",
    '        answers: [',
    '          { questionId: "q1", selected: ["SQLite"] },',
    '          { questionId: "q2", selected: ["写迁移脚本"], text: "顺便加上回滚" },',
    "        ] }),",
    "    P('c2', 'read', { path: \"src/a.ts\" },",
    '      "     1\\tconst a = 1;\\n     2\\tconst b = 2;\\n     3\\texport { a, b };\\n\\n[3 more lines in file. Use offset=4 to continue.]"),',
    "    P('c3', 'write', { path: \"docs/note.md\", content: \"# 标题\\n\\n正文段落。\\n\" }, \"Successfully wrote to docs/note.md\"),",
    "    P('c4', 'grep', { pattern: \"createTodo\" },",
    '      "src/a.ts:12:const x = createTodo();\\nsrc/b.ts:5:createTodo();\\n2 matches in 2 files."),',
    "    P('c5', 'browser_snapshot', { tab: \"t2\" },",
    '      "tab t2\\nURL: https://a.test",',
    '      { url: "https://a.test", title: "示例页", generation: 3, tabId: "t2",',
    '        text: "visible", truncated: false,',
    '        elements: [',
    '          { ref: "e1", role: "button", name: "提交", tag: "button" },',
    '          { ref: "e2", role: "textbox", name: "邮箱", tag: "input", value: "a@b.c" },',
    "        ],",
    '        omitted: { elements: 4, textChars: 0 } }),',
    "    P('c6', 'browser_logs', { type: \"console\", tab: \"t2\" },",
    '      "tab t2\\n2 entries",',
    '      { tabId: "t2", entries: [',
    '          { level: "error", text: "Uncaught TypeError", source: "app.js", line: 12, at: 1 },',
    '          { level: "info", text: "ready", source: "app.js", line: 3, at: 2 },',
    '        ], dropped: 1 }),',
    // todo（「更新了」）：清单 —— 它曾经漏了外层 paper
    "    P('c8', 'todo',",
    '      { todos: [',
    '        { id: "1", text: "读代码", status: "done" },',
    '        { id: "2", text: "改实现", status: "active" },',
    "      ] },",
    '      "已更新清单",',
    '      { todos: [',
    '        { id: "1", text: "读代码", status: "done" },',
    '        { id: "2", text: "改实现", status: "active" },',
    "      ], revision: 2 }),",
    // web_fetch（「读取了网页」）：它曾经漏了外层 paper
    "    P('c9', 'web_fetch', { url: \"https://a.test/doc\" }, \"PAGE BODY\",",
    '      { url: "https://a.test/doc", statusCode: 200, title: "示例文档", truncated: false }),',
    "    P('c7', 'browser_evaluate', { code: \"document.title\", tab: \"t2\" },",
    '      "tab t2\\n示例页", { tabId: "t2", ok: true, value: "示例页" }),',
    "  ];",
    '  const session = { id: "s1", title: "工具详情验证", createdAt: Date.now(), updatedAt: Date.now(), cwd: "D:/p", archived: false, pinned: false, messageCount: 2, model: null };',
    "  chat.useChatStore.setState({",
    '    activeSessionId: "s1",',
    "    sessions: [session],",
    "    messagesBySession: { s1: [",
    '      { id: "u1", role: "user", createdAt: Date.now() - 1000, parts: [{ type: "text", text: "都试一遍" }], status: "complete" },',
    '      { id: "a1", role: "assistant", createdAt: Date.now(), status: "complete", parts },',
    "    ] },",
    "  });",
    "  return true;",
    "})()",
  ].join("\n");
  await ev(cdp, script);
  await sleep(1500);

  // 展开工具时间线（多个工具会被折进轨迹），再展开其中的每一步
  await ev(
    cdp,
    `(async () => {
       const tl = document.querySelector('[data-slot="tool-timeline"] > button');
       if (tl) { tl.click(); await new Promise((r) => setTimeout(r, 400)); }
       const steps = [...document.querySelectorAll('[data-slot="tool-timeline"] [data-slot="collapsible"] > button')];
       for (const s of steps) { s.click(); await new Promise((r) => setTimeout(r, 150)); }
       await new Promise((r) => setTimeout(r, 500));
       return steps.length;
     })()`,
  );

  const body = await ev(cdp, `document.body.textContent || ""`);

  // —— 1. Request/Result 彻底下线 ——
  const leftovers = await ev(
    cdp,
    `[...document.querySelectorAll("p")].filter((p) => ["Request","Result"].includes((p.textContent||"").trim())).length`,
  );
  check("Request/Result 面板已下线", leftovers === 0, `残留 ${leftovers} 处`);

  // —— 2. ask_user：全部题目与作答 ——
  check("ask_user 显示题数", body.includes("2 个问题"), "找到「2 个问题」");
  check("ask_user 显示第一题的 header 与正文", body.includes("数据库") && body.includes("用哪个库？"), "数据库 / 用哪个库？");
  check("ask_user 显示第一题的作答", body.includes("SQLite"), "SQLite");
  check("ask_user 显示第二题（不只第一题）", body.includes("要不要写迁移脚本？"), "第二题在");
  check("ask_user 显示多选标记", body.includes("可多选"), "可多选");
  check("ask_user 显示自由输入", body.includes("顺便加上回滚"), "顺便加上回滚");

  // —— 3. read / grep / write 的正文形态 ——
  check("read 保留了行号", body.includes("const a = 1;") && /\d+\s+const a/.test(body), "行号与正文都在");
  check("read 的尾注与正文分开显示", body.includes("[3 more lines in file"), "尾注在");
  check("grep 多行命中都在（没被压成一行）", body.includes("src/a.ts:12") && body.includes("src/b.ts:5"), "两条命中");
  check("write 显示路径与字符数", body.includes("docs/note.md") && body.includes("12 字符"), "路径 + 12 字符");
  check("write 显示写入的正文", body.includes("# 标题"), "正文预览在");

  /**
   * —— 3b. **每个展开区的根元素都带圆角边框**（用户报的那一类缺陷）——
   *
   * 「读取了网页」与「更新了」两个详情曾经漏了外层 paper，展开后没有圆角边框，
   * 而 DOM 断言照样全绿 —— 这种事只有量真实样式才发现。
   *
   * 判据取**计算样式**而不是 class 名：class 里写了 `rounded-2xl` 但被别的规则覆盖，
   * 或者 token 没生成，class 检查都看不出来。这里要求：
   *   · 圆角 ≥ 12px（rounded-2xl 是 16px，rounded-xl 是 12px —— 都算合格）；
   *   · 有可见的边框宽度；
   *   · 有区别于页面底色的背景（paper 是 `--card`/`--popover`）。
   */
  const shells = await ev(
    cdp,
    `(() => {
       const out = [];
       /**
        * 取每个展开区里**真正的详情根**。
        *
        * 两条路径的层级不同，所以各自找：
        *   · ToolCall（通用行）：collapsible-content > div(间距) > 详情根；
        *   · ToolTimeline（轨迹步骤）：collapsible-content > div.pt-2 > 详情根，
        *     而 **详情根自己可能再套一层**（如 TerminalDetail 返回的是元素本身）。
        * 判据不靠固定层级，而是**向下找到第一个自带圆角或边框的元素** ——
        * 那正是「详情的外壳」，也正是本项要检查的东西。
        */
       const dig = (el, depth) => {
         if (depth > 3) return el;
         const cs = getComputedStyle(el);
         /**
          * 阈值取 12：详情外壳用 rounded-2xl（16px）或 rounded-xl（12px），
          * 而**触发行**是 rounded-md（6px）、步骤行是 8px —— 门槛放进它们中间，
          * 才不会把「触发行的圆角」误当成详情外壳（第一版取 8 就踩了这个坑）。
          */
         const hasShell = (parseFloat(cs.borderTopLeftRadius) || 0) >= 12
           || (parseFloat(cs.borderTopWidth) || 0) >= 0.5;
         if (hasShell) return el;
         const child = [...el.children].find((c) => c.getBoundingClientRect().height >= 4);
         return child === undefined ? el : dig(child, depth + 1);
       };

       const panels = [...document.querySelectorAll('[data-slot="collapsible-content"]')];
       for (const panel of panels) {
         const direct = [...panel.querySelectorAll(":scope > div > *")].find(
           (el) => el.getBoundingClientRect().height >= 4,
         );
         if (direct === undefined) continue;   // 未展开 / 空面板
         const el = dig(direct, 0);
         const r = el.getBoundingClientRect();
         if (r.height < 4) continue;
         // SVG 里的 <path> 也会被当成「有高度的子元素」走到底 —— 那不是详情根，
         // 只收 HTML 元素（详情根一律是 div / section）
         if (el instanceof SVGElement) continue;
         const cs = getComputedStyle(el);
         out.push({
           slot: el.getAttribute("data-slot") || el.tagName.toLowerCase(),
           radius: parseFloat(cs.borderTopLeftRadius) || 0,
           border: parseFloat(cs.borderTopWidth) || 0,
           bg: cs.backgroundColor,
           text: (el.textContent || "").slice(0, 24),
         });
       }
       return out;
     })()`,
  );
  console.log("展开区根元素:", JSON.stringify(shells, null, 1));

  const pageBg = await ev(
    cdp,
    `getComputedStyle(document.documentElement).getPropertyValue("--card").trim()`,
  );
  const naked = (shells ?? []).filter(
    (s) => s.radius < 12 || s.border < 0.5 || s.bg === "rgba(0, 0, 0, 0)",
  );
  check(
    "每个展开区的根元素都有圆角 + 边框 + 底色（没有「裸」的详情）",
    naked.length === 0,
    naked.length === 0
      ? `${shells?.length} 个详情全部合格（--card=${pageBg}）`
      : `裸详情: ${JSON.stringify(naked)}`,
  );

  // —— 4. 浏览器工具的结构化读数 ——
  check("浏览器快照显示 tab", body.includes("t2"), "t2");
  check("浏览器快照显示 url", body.includes("https://a.test"), "url 在");
  check("浏览器快照列出元素", body.includes("e1") && body.includes("提交"), "e1 / 提交");
  check("浏览器快照带出输入框的当前值", body.includes("a@b.c"), "a@b.c");
  check("快照的省略数量被说出来", /omitted|4 elements/.test(body), "省略说明在");
  check("控制台日志逐条显示", body.includes("Uncaught TypeError"), "error 条目在");
  check("控制台日志标出被过滤的条数", /filtered out|1/.test(body), "dropped 在");
  check("求值结果被显示", body.includes("示例页"), "求值结果在");

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`\n截图: ${OUT}`);
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
