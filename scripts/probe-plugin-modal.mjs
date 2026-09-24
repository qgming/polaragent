// 插件模态窗的端到端验证：清单 → 打开 → guest 附着 → 桥可用 → 自己关掉。
//
// 为什么需要它：这条路**每一步都有单测覆盖不到的一段**。
//  · 单测能验清单解析、能验纯函数挑界面的规则，但验不了"渲染层真的把对话框挂出来了"；
//  · 能验归属表的读写，但验不了"Electron 真的把 guest 附着上了、preload 真的注入了"；
//  · 尤其验不了 `plugins:surfaceClosed` 这条**回程**：页面说"我关了"，对话框有没有收掉。
//
// 而其中最容易静默失效的一段（实测踩过）是**归属登记**：主进程曾经写死按
// `kind === "panel"` 找界面，于是只有模态窗的插件连归属都登记不上 —— 症状是
// "页面能显示、点了没反应"，没有任何一处会报错。本探针第 5 步专门钉它。
//
// 用法：先 `npm run build`（探针跑的是 dist 里的渲染层产物），然后
//   npm run probe:plugin-modal
//
// 它用**隔离的 user-data-dir 与数据目录**启动 Electron，不碰用户自己的安装与数据。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(import.meta.dirname, "..");

const PORT = 19411;
const TMP = path.join(os.tmpdir(), "oint-plugin-modal-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
const PLUGIN_ID = "dev.oint.scratchpad";
const SURFACE_ID = "scratchpad";

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
      /* 已断开 */
    }
  }
}

/** 在某个 CDP 目标里求值并取回 JSON */
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

/** 轮询直到条件成立，返回是否成立 */
async function until(fn, { timeoutMs = 15_000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
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

const env = { ...process.env, OINT_HOME: DATA_DIR };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));

let page = null;
let guest = null;

try {
  // 1) 等主窗口的调试目标
  const target = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`应用提前退出，exitCode=${child.exitCode}`);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const hit = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (hit !== undefined) return hit;
      } catch {
        /* 端口未就绪 */
      }
      await sleep(400);
    }
    throw new Error("等待调试目标超时");
  })();

  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Log.enable");

  // 2) 等界面挂载（aside 是 RightSidebar 的根节点，它出现即说明 React 树已提交）
  check(
    "界面已挂载",
    await until(async () => await evaluate(page, `document.querySelector("aside") !== null`), {
      timeoutMs: 30_000,
    }),
    "React 树已提交",
  );

  // 3) 插件列表里能看到示例插件，且它的界面形态是 modal
  const view = await (async () => {
    let found = null;
    await until(async () => {
      found = await evaluate(
        page,
        `window.oint.plugins.list().then((views) => views.find((v) => v.id === ${JSON.stringify(PLUGIN_ID)}) ?? null)`,
      );
      return found !== null;
    });
    return found;
  })();
  check("内置示例插件出现在列表里", view !== null, view === null ? "没找到" : `${view.name}`);
  check(
    "它的界面被标成 modal（不是面板、也不是窗口）",
    view?.surfaces?.[0]?.kind === "modal",
    `kind=${view?.surfaces?.[0]?.kind}`,
  );
  check(
    "清单里的尺寸透传到了渲染层",
    view?.surfaces?.[0]?.width === 760 && view?.surfaces?.[0]?.height === 560,
    `${view?.surfaces?.[0]?.width}×${view?.surfaces?.[0]?.height}`,
  );
  check(
    "它的权限里没有高危项（无 net / fs / shell）",
    Array.isArray(view?.permissions) &&
      view.permissions.length > 0 &&
      view.permissions.every((p) => p.risk !== "high"),
    (view?.permissions ?? []).map((p) => `${p.id}=${p.risk}`).join(", "),
  );

  // 4) 打开它：走**用户真实的那条路**（Ctrl+Shift+X 打开插件管理 → 点界面按钮）。
  //
  //    刻意不直接调 `window.oint.plugins.openSurface`：那条 IPC 只回答"该开在哪里"，
  //    真正把对话框挂出来的是渲染层的 store 动作。直接调 IPC 会让这一整段（也就是
  //    最可能断掉的一段）根本不经过 —— 实测走过一次弯路。
  const ipcAnswer = await evaluate(
    page,
    `window.oint.plugins.openSurface(${JSON.stringify(PLUGIN_ID)}, ${JSON.stringify(SURFACE_ID)})`,
  );
  check("openSurface 这条 IPC 回答 kind=modal", ipcAnswer?.kind === "modal", JSON.stringify(ipcAnswer));

  // 打开插件管理（Ctrl+Shift+X，与 VS Code 的扩展面板同键）
  const pluginsOpen = await until(async () => {
    await evaluate(
      page,
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "X", ctrlKey: true, shiftKey: true, bubbles: true })), true`,
    );
    await sleep(300);
    return await evaluate(page, `document.querySelector('[data-slot="dialog-content"]') !== null`);
  });
  check("Ctrl+Shift+X 打开了插件管理", pluginsOpen, pluginsOpen ? "列表已出现" : "没打开");

  const clicked = await (async () => {
    let result = { clicked: false, buttons: [], views: [], text: "" };
    await until(async () => {
      result = await evaluate(
        page,
        `(async () => {
          const texts = (nodes) => [...nodes].map((b) => (b.textContent ?? "").trim());
          const buttons = [...document.querySelectorAll('[data-slot="dialog-content"] button')];
          /*
            内置插件在**「系统」页签**里；「用户」页签只列用户装进来的。
            探针第一次跑到这里时停在用户页签上，看到"还没有安装任何插件"，
            差点当成功能坏了 —— 所以这一步先切页签。
          */
          const systemTab = buttons.find((b) => (b.textContent ?? "").trim() === "系统");
          systemTab?.click();
          await new Promise((r) => setTimeout(r, 200));

          const after = [...document.querySelectorAll('[data-slot="dialog-content"] button')];
          const hit = after.find((b) => {
            const text = (b.textContent ?? "").trim();
            return text === "速记本" || text === "Scratchpad";
          });
          const views = await window.oint.plugins.list();
          if (hit === undefined) {
            const dialog = document.querySelector('[data-slot="dialog-content"]');
            return {
              clicked: false,
              buttons: texts(after).slice(0, 12),
              views: views.map((v) => v.id + ":" + v.source),
              text: (dialog?.textContent ?? "").trim().slice(0, 200),
            };
          }
          hit.click();
          return { clicked: true, buttons: [], views: views.map((v) => v.id), text: "" };
        })()`,
      );
      return result.clicked;
    });
    return result;
  })();
  check(
    "在插件管理里点开了它的界面按钮",
    clicked.clicked,
    clicked.clicked ? "已点击" : JSON.stringify(clicked),
  );

  const dialogTitle = await (async () => {
    let title = null;
    await until(async () => {
      title = await evaluate(
        page,
        `(() => {
          const contents = [...document.querySelectorAll('[data-slot="dialog-content"]')];
          for (const content of contents) {
            const webview = content.querySelector("webview");
            if (webview === null) continue;
            const heading = content.querySelector('[data-slot="dialog-title"]');
            return { text: heading?.textContent ?? "", hasWebview: true };
          }
          return null;
        })()`,
      );
      return title !== null;
    });
    return title;
  })();
  check(
    "对话框挂出来了，而且里面是 webview 宿主",
    dialogTitle?.hasWebview === true,
    JSON.stringify(dialogTitle),
  );
  check(
    "标题用的是清单里那份双语标题（按当前语言取）",
    dialogTitle?.text === "速记本" || dialogTitle?.text === "Scratchpad",
    `「${dialogTitle?.text}」`,
  );

  // 5) guest 存在且**归属登记上了** —— 只有模态窗的插件曾经在这里整个失效
  const guestTarget = await (async () => {
    let hit = null;
    await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      hit = list.find((item) => item.type === "webview" && item.webSocketDebuggerUrl) ?? null;
      return hit !== null;
    });
    return hit;
  })();
  check("webview 的 guest 真的附着上了", guestTarget !== null, guestTarget?.url ?? "没有 guest 目标");

  if (guestTarget !== null) {
    guest = await Cdp.connect(guestTarget.webSocketDebuggerUrl);
    await guest.send("Runtime.enable");

    const info = await evaluate(guest, `window.oint.info`);
    check(
      "guest 里的桥认得自己是谁（归属登记成功）",
      info?.pluginId === PLUGIN_ID && info?.kind === "modal" && info?.surfaceId === SURFACE_ID,
      JSON.stringify(info),
    );
    check("宿主把当前主题下发了", info?.theme === "light" || info?.theme === "dark", `${info?.theme}`);

    const ready = await evaluate(
      guest,
      `(() => document.querySelector("#list") !== null && document.querySelector("#text") !== null)()`,
    );
    check("插件页面自己渲染完成了", ready === true, ready ? "列表与编辑器都在" : "DOM 不完整");

    // 走一次私有存储的往返：证明 storage 权限真的被授予、值真的落盘
    const roundTrip = await evaluate(
      guest,
      `window.oint.storage.set("probe", { n: 1 }).then(() => window.oint.storage.get("probe"))`,
    );
    check("私有存储能写能读", roundTrip?.n === 1, JSON.stringify(roundTrip));
    const stored = fs.existsSync(path.join(DATA_DIR, "plugins", "data", PLUGIN_ID, "storage.json"));
    check("存储文件落在了插件自己的数据目录里", stored, `storage.json @ ${PLUGIN_ID}`);

    // 6) 回程：页面说"我关了"，对话框要收掉
    await evaluate(guest, `window.oint.close()`);
    const closed = await until(
      async () =>
        await evaluate(page, `document.querySelector('[data-slot="dialog-content"]') === null`),
      { timeoutMs: 8_000 },
    );
    check("页面调 close() 之后对话框自己收掉了（plugins:surfaceClosed 打通）", closed, closed ? "已关闭" : "8 秒内没有关闭");
  }

  check(
    "渲染层没有报错",
    page.consoleErrors.length === 0,
    page.consoleErrors.length === 0 ? "无" : page.consoleErrors.slice(0, 3).join(" / "),
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  guest?.close();
  page?.close();
  child.kill();
  await sleep(500);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
