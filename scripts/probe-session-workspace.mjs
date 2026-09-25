// 端到端验证：**没有绑定工作目录的会话，右侧「文件」面板要能打开**。
//
// 为什么需要它：用户报的故障是「模型写过的文件在右侧打不开，提示
// 读取失败：files:read-file：该会话未绑定工作目录」—— 这条链路上有三段，
// 单测各自只覆盖一段（store 建目录 / IPC 解析 root / 面板渲染），而用户看到的
// 是它们合起来的结果。这个探针跑的是**真的主进程 + 真的磁盘 + 真的渲染**。
//
// 只在 dev 模式下可用（要 import /src/... 的模块）：
//   终端 A: npm run dev
//   终端 B: node scripts/probe-session-workspace.mjs
//
// 它验证五件事：
//   1. 新建会话（不指定目录）会拿到一个临时工作目录，且目录真的建在磁盘上；
//   2. files:list-directory / write-file 在这个会话上可用（就是报错的那两条通道）；
//   3. 右侧「文件」面板点开后列得出内容，**没有「读取失败」**；
//   4. 历史会话（索引里没有 cwd）现补一个临时目录，而不是报错；
//   5. 删会话清掉临时目录，但用户指定保存到别处（显式绑定目录）的文件还在。

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19431;
const TMP = path.join(os.tmpdir(), "oint-session-workspace-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
/** 用户让模型「保存到这里」的目录：在工作区之外，删会话不该动它 */
const USER_DIR = path.join(TMP, "user-docs");

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

/**
 * 路径比较用的归一：主进程回的是归一化过的路径（Windows 盘符小写、分隔符统一），
 * 而探针手里的路径是原样拼的 —— 直接字符串比会在盘符大小写上假红。
 */
function normalize(value) {
  return path.resolve(String(value)).replace(/\\/g, "/").toLowerCase();
}
function samePath(left, right) {
  return normalize(left) === normalize(right);
}
function insidePath(child, parent) {
  return normalize(child).startsWith(`${normalize(parent)}/`);
}

/** 索引文件：用来把某个会话改回「历史会话」（没有 cwd）的样子 */
const INDEX_FILE = path.join(DATA_DIR, "sessions-index.json");
function stripCwdFromIndex(sessionId) {
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  delete index[sessionId].cwd;
  fs.writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(USER_DIR, { recursive: true });

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
   * —— 1. 新建会话：不指定工作目录 ——
   *
   * 走真 IPC 建会话（索引里才会有这个 id），并把它设成当前会话 ——
   * 文件面板就是按 activeSessionId 去主进程要目录的。
   */
  const created = await evaluate(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       const session = await window.oint.sessions.create({ title: "临时工作区探针" });
       chat.useChatStore.setState({ activeSessionId: session.id, sessions: [session] });
       window.__probeSessionId = session.id;
       return { id: session.id, cwd: session.cwd };
     })()`,
  );
  check(
    "新建会话就有一个工作目录（不是空串）",
    typeof created?.cwd === "string" && created.cwd.trim() !== "",
    `cwd=${created?.cwd}`,
  );

  const workspacesRoot = path.join(DATA_DIR, "workspaces");
  const sessionDir = created?.cwd ?? "";
  check(
    "目录落在数据根下的 workspaces/ 里",
    insidePath(sessionDir, workspacesRoot),
    `期望在 ${workspacesRoot} 下`,
  );
  check("目录在磁盘上真的建出来了", fs.existsSync(sessionDir), sessionDir);

  /**
   * —— 2. 报错的那两条通道现在可用 ——
   *
   * `files:list-directory` 与 `files:write-file` 都按 sessionId 解析 root，
   * 旧实现在这里抛「该会话未绑定工作目录，文件面板不可用」。
   */
  const io = await evaluate(
    cdp,
    `(async () => {
       const sessionId = window.__probeSessionId;
       const listing = await window.oint.files.listDirectory({ sessionId });
       const written = await window.oint.files.writeFile({
         sessionId,
         path: listing.root + "/probe.md",
         text: "探针写的文件\\n",
       });
       const read = await window.oint.files.readFile({ sessionId, path: written.path });
       const after = await window.oint.files.listDirectory({ sessionId });
       return {
         root: listing.root,
         path: written.path,
         bytes: written.bytes,
         text: read.text,
         names: after.entries.map((entry) => entry.name),
       };
     })()`,
  ).catch((error) => ({ error: String(error) }));
  check(
    "list-directory 不报「未绑定工作目录」",
    io?.root !== undefined && samePath(io.root, sessionDir),
    io?.error ?? `root=${io?.root}`,
  );
  check(
    "write-file 写进这个目录，读回来是同一份内容",
    io?.text === "探针写的文件\n" && (io?.names ?? []).includes("probe.md"),
    io?.error ?? `bytes=${io?.bytes} names=${JSON.stringify(io?.names)}`,
  );
  check(
    "磁盘上确实有这个文件",
    fs.existsSync(path.join(sessionDir, "probe.md")),
    path.join(sessionDir, "probe.md"),
  );

  /**
   * —— 3. 右侧「文件」面板 ——
   *
   * 用户看到故障的地方。开右栏并切到「文件」（走的是选择列表点那一项时同一条 action），
   * 再读面板里的正文 —— 断言「列得出文件」并且**没有「读取失败」**。
   *
   * 语言先钉成中文：文案断言（含「读取失败」这四个字）在英文界面下会假绿。
   */
  await evaluate(
    cdp,
    `(async () => {
       const i18n = await import("/src/renderer/i18n");
       await i18n.default.changeLanguage("zh-CN");
       const ui = await import("/src/renderer/stores/ui-store.ts");
       ui.useUiStore.getState().openRightPanel("files");
       return true;
     })()`,
  );

  let panel = null;
  const panelDeadline = Date.now() + 10_000;
  while (Date.now() < panelDeadline) {
    panel = await evaluate(
      cdp,
      `(() => {
         const aside = [...document.querySelectorAll("aside")].find(
           (a) => a.getAttribute("aria-label") === "右侧面板",
         );
         if (!aside) return null;
         const text = aside.textContent || "";
         return {
           hasFile: text.includes("probe.md"),
           failed: text.includes("读取失败") || text.includes("Failed to load"),
           text: text.slice(0, 120),
         };
       })()`,
    );
    if (panel?.hasFile || panel?.failed) break;
    await sleep(300);
  }
  check("文件面板列得出模型写过的文件", panel?.hasFile === true, JSON.stringify(panel));
  check("面板上没有「读取失败」", panel?.failed === false, JSON.stringify(panel));

  /**
   * —— 4. 历史会话（索引里没有 cwd）——
   *
   * 把索引里那条 cwd 抹掉、并把目录从磁盘上删掉，模拟这次改动之前建的会话：
   * 主进程必须**重新把目录建出来**并拿它当根，而不是回到「未绑定工作目录」那个错误上。
   * 目录名由会话 id 决定，所以补出来的路径与原来那个相同 —— 这正是幂等的证据。
   */
  const legacy = await evaluate(
    cdp,
    `(async () => {
       const session = await window.oint.sessions.create({ title: "历史会话探针" });
       return { id: session.id, cwd: session.cwd };
     })()`,
  );
  await sleep(200);
  stripCwdFromIndex(legacy.id);
  fs.rmSync(legacy.cwd, { recursive: true, force: true });

  const legacyAfter = await evaluate(
    cdp,
    `(async () => {
       const listing = await window.oint.files.listDirectory({ sessionId: ${JSON.stringify(legacy.id)} });
       return { root: listing.root };
     })()`,
  ).catch((error) => ({ error: String(error) }));
  check(
    "历史会话现补一个临时目录，而不是报错",
    typeof legacyAfter?.root === "string" && insidePath(legacyAfter.root, workspacesRoot),
    legacyAfter?.error ?? `root=${legacyAfter?.root}`,
  );
  check(
    "补出来的目录名仍由会话 id 决定（幂等，不是每次换一个）",
    legacyAfter?.root !== undefined &&
      samePath(legacyAfter.root, legacy.cwd) &&
      fs.existsSync(legacyAfter.root),
    `旧=${legacy.cwd} 新=${legacyAfter?.root}`,
  );

  /**
   * —— 5. 删除会话的清理边界 ——
   *
   * 显式绑定到工作区之外的会话：那里的文件是用户让模型保存的，删会话不该动。
   */
  const bound = await evaluate(
    cdp,
    `(async () => {
       const session = await window.oint.sessions.create({
         title: "用户目录探针",
         cwd: ${JSON.stringify(USER_DIR.split(path.sep).join("/"))},
       });
       await window.oint.files.writeFile({
         sessionId: session.id,
         path: ${JSON.stringify(path.join(USER_DIR, "keep.md").split(path.sep).join("/"))},
         text: "用户让保存到这里的\\n",
       });
       return { id: session.id, cwd: session.cwd };
     })()`,
  );
  const keepFile = path.join(USER_DIR, "keep.md");
  check("绑定目录里的文件写成功", fs.existsSync(keepFile), keepFile);

  await evaluate(
    cdp,
    `(async () => {
       await window.oint.sessions.remove(window.__probeSessionId);
       await window.oint.sessions.remove(${JSON.stringify(legacy.id)});
       await window.oint.sessions.remove(${JSON.stringify(bound.id)});
       return true;
     })()`,
  );
  await sleep(500);

  check("删会话后临时目录被清掉", !fs.existsSync(sessionDir), sessionDir);
  check(
    "历史会话补出来的目录同样被清掉",
    !fs.existsSync(legacyAfter?.root ?? ""),
    legacyAfter?.root,
  );
  check("用户指定保存到别处的文件还在", fs.existsSync(keepFile), keepFile);
  check(
    "workspaces 根目录本身还在（清理不会越过一层）",
    fs.existsSync(workspacesRoot),
    workspacesRoot,
  );

  const consoleErrors = cdp.consoleErrors.filter((line) => !line.includes("DevTools"));
  check("渲染进程没有控制台错误", consoleErrors.length === 0, consoleErrors.join(" | ") || "无");
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针自身出错 | ${String(error)}`);
  console.log(appLog.join("").split("\n").slice(-20).join("\n"));
} finally {
  cdp?.close();
  child.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n全部通过" : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
