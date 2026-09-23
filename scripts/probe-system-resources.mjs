// 系统资源探针：在**真实 Electron 主进程**里验证「系统魔法提示 + 系统 MCP 预设」这两层。
//
// 为什么不能用单测代替：这两层的路径全都依赖 `app.getAppPath()`（开发期是仓库根，打包后是
// asar 根），而单测只能喂假的 appPath；「内置目录到底扫到了没有」「预设到底连上了没有」
// 只有在真实进程里问才算数。jsdom 测试覆盖的是面板渲染，测不到这条链。
//
// 它启动的是**已构建**的应用（dist / dist-electron），因此不需要 dev server：
//   1. npm run build
//   2. node scripts/probe-system-resources.mjs
//
// 全程使用独立的 user-data-dir 与 OINT_HOME（临时目录），**不碰你本机的真实配置与数据**。
// 唯一的真实外部副作用：会像应用本身一样去连那三个默认开启的 MCP 预设（只读工具，不发消息）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = 19401;
const TMP = path.join(os.tmpdir(), "oint-system-resources-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
/** 探针自己放进去的用户资源（用来验证「同名用户覆盖内置」） */
const USER_PROMPT_OVERRIDE = "plan";

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
 * 用 **CDP 的真实鼠标事件**点一个元素。
 *
 * 不能用页面内的 `element.click()`：Radix 的 Tabs / Select 这类组件监听的是 `mousedown`
 *（为了支持「按下即激活」与键盘走位），合成 click 事件不会让它们切换 —— 实测页签点完
 * 还是 `data-state="inactive"`，而探针会误报成「面板里没有内容」。真实鼠标事件没有这个问题。
 */
async function clickByExpression(cdp, expression) {
  const point = await evaluate(
    cdp,
    `(() => {
       const element = ${expression};
       if (!element) return null;
       const rect = element.getBoundingClientRect();
       if (rect.width === 0 || rect.height === 0) return null;
       return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
     })()`,
  );
  if (point === null) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
  return true;
}

/** 轮询等待页面上出现某段文字（真实渲染是异步的：面板要等 IPC 回来） */
async function waitForText(cdp, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(needle)})`);
    if (found) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/** 按无障碍属性找元素并点击（不依赖 class：界面改版时选择器仍然成立） */
const BUTTON_BY_LABEL = (label) =>
  `[...document.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? "") === ${JSON.stringify(label)})`;
const TAB_BY_TEXT = (label) =>
  `[...document.querySelectorAll('[role="tab"]')].find((item) => (item.textContent ?? "").trim() === ${JSON.stringify(label)})`;
const SEGMENT_BY_TEXT = (label) =>
  `[...document.querySelectorAll("button[aria-pressed]")].find((item) => (item.textContent ?? "").trim() === ${JSON.stringify(label)})`;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA_DIR, "prompts"), { recursive: true });
// 与内置 `plan` 同名：生效的应当是这一份（同名用户覆盖内置）
fs.writeFileSync(
  path.join(DATA_DIR, "prompts", `${USER_PROMPT_OVERRIDE}.md`),
  '---\ndescription: "探针写的同名提示"\n---\n\n这是探针写的正文\n',
  "utf8",
);

const env = { ...process.env, OINT_HOME: DATA_DIR };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;

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

  // 等 preload 把桥挂上（挂上前 window.oint 是 undefined）
  let bridge = false;
  for (let i = 0; i < 60 && !bridge; i += 1) {
    bridge = await evaluate(cdp, `typeof window.oint?.prompts?.list === "function"`);
    if (!bridge) await sleep(300);
  }
  check("渲染进程桥已就绪", bridge, bridge ? "window.oint 可用" : "window.oint 未挂载");
  if (!bridge) throw new Error("桥没准备好，后面的检查无法进行");

  // --- 1. 系统魔法提示 -------------------------------------------------------
  const prompts = await evaluate(cdp, `window.oint.prompts.list()`);
  const builtin = prompts.filter((item) => item.source === "builtin");
  const user = prompts.filter((item) => item.source === "user");

  check(
    "内置魔法提示被扫到（14 个里 13 个，plan 被上面那份用户同名提示顶掉）",
    builtin.length === 13 && user.length === 1,
    `${builtin.length} 个内置 + ${user.length} 个用户：${builtin.map((item) => item.name).join(", ")}`,
  );
  check(
    "内置提示来自 appPath 下的 resources/prompts",
    builtin.length > 0 && builtin.every((item) => /resources[\\/]prompts$/.test(item.dir)),
    builtin[0]?.dir ?? "(空)",
  );
  check(
    "每条内置提示都有描述与正文",
    builtin.every((item) => item.description.trim() !== "" && item.content.trim().length > 60),
    `描述示例：${builtin[0]?.description?.slice(0, 30) ?? ""}…`,
  );
  check(
    "用户同名提示覆盖内置：列表里只剩用户那一份",
    user.filter((item) => item.name === USER_PROMPT_OVERRIDE).length === 1 &&
      builtin.every((item) => item.name !== USER_PROMPT_OVERRIDE),
    `plan → ${user.find((item) => item.name === USER_PROMPT_OVERRIDE)?.description ?? "(缺失)"}`,
  );

  // 注意签名：渲染层的 remove 收的是**名字字符串**（preload 负责包成 { name }）
  const removeBuiltin = await evaluate(
    cdp,
    `window.oint.prompts.remove("tdd").then(() => "ok", (error) => String(error.message))`,
  );
  check(
    "内置提示不可删除，并给出「新建同名覆盖」的指引",
    removeBuiltin.includes("内置魔法提示不可删除"),
    removeBuiltin.slice(0, 80),
  );

  // --- 2. 系统 MCP 预设 -----------------------------------------------------
  const views = await evaluate(cdp, `window.oint.mcp.list()`);
  const system = views.filter((item) => item.source === "system");
  const enabledDefaults = system.filter((item) => item.config.enabled).map((item) => item.config.id);

  check(
    "系统 MCP 预设全部就位（通用 + 全球那一批）",
    system.length >= 30,
    `${system.length} 条：${system.map((item) => item.config.id).join(", ")}`,
  );
  check(
    "默认全部启用（上下文预算由聚合策略兜住，不靠少开几个来省）",
    enabledDefaults.length === system.length,
    `${enabledDefaults.length}/${system.length} 启用`,
  );
  check(
    "系统预设都是免配置的 http 端点（无命令 / 无 env / 无 header）",
    system.every(
      (item) =>
        item.config.transport === "http" &&
        item.config.command === "" &&
        Object.keys(item.config.env).length === 0 &&
        Object.keys(item.config.headers).length === 0,
    ),
    system[0]?.config.url ?? "(空)",
  );

  // 真实重连：这一步会真的去连全部远端端点（并发）
  const reloaded = await evaluate(
    cdp,
    `window.oint.mcp.reload().then((v) => v.map((item) => ({
       id: item.config.id,
       source: item.source,
       status: item.state.status,
       tools: item.state.tools.length,
       error: item.state.error ?? "",
     })))`,
  );
  const ready = reloaded.filter((item) => item.source === "system" && item.status === "ready");
  check(
    "绝大多数预设真的连上了（真实网络握手）",
    ready.length >= reloaded.filter((item) => item.source === "system").length - 2,
    `${ready.length}/${reloaded.filter((item) => item.source === "system").length} 就绪：` +
      ready
        .slice(0, 8)
        .map((item) => `${item.id}(${item.tools})`)
        .join(", ") +
      (ready.length > 8 ? ` …` : ""),
  );
  const failed = reloaded.filter((item) => item.source === "system" && item.status !== "ready");
  check(
    "连不上的会带失败原因（面板能解释「为什么这台没工具」）",
    failed.every((item) => item.error !== ""),
    failed.map((item) => `${item.id}: ${item.error.slice(0, 60)}`).join(" ｜ ") || "全部就绪",
  );
  const toolTotal = ready.reduce((sum, item) => sum + item.tools, 0);
  check(
    "工具总数远超旧上限（这正是需要聚合工具的原因）",
    toolTotal > 64,
    `远端工具合计 ${toolTotal} 个`,
  );

  // --- 3. 用户同 id 覆盖系统预设 --------------------------------------------
  const shadowed = await evaluate(
    cdp,
    `(async () => {
       const settings = await window.oint.settings.read();
       await window.oint.settings.write({
         ...settings,
         mcpServers: [{
           id: "context7", name: "我的 Context7", enabled: true, transport: "http",
           command: "", args: [], env: {}, cwd: "",
           url: "https://mcp.context7.com/mcp", headers: {}, createdAt: Date.now(),
         }],
       });
       const next = await window.oint.mcp.reload();
       const systemRow = next.find((item) => item.source === "system" && item.config.id === "context7");
       const userRow = next.find((item) => item.source === "user" && item.config.id === "context7");
       return {
         systemOverridden: systemRow?.overridden ?? null,
         systemStatus: systemRow?.state.status ?? null,
         userOverridden: userRow?.overridden ?? null,
         userStatus: userRow?.state.status ?? null,
         occurrences: next.filter((item) => item.config.id === "context7").length,
       };
     })()`,
  );
  check(
    "同 id 时用户在系统与用户两侧都被标成覆盖关系",
    shadowed.systemOverridden === true && shadowed.userOverridden === true,
    JSON.stringify(shadowed),
  );
  check(
    "被覆盖的系统行不再报「已连接」（连接属于用户那一份）",
    shadowed.systemStatus === "idle",
    `system=${shadowed.systemStatus}`,
  );

  // --- 4. 系统预设的启停 -----------------------------------------------------
  const toggled = await evaluate(
    cdp,
    `(async () => {
       const settings = await window.oint.settings.read();
       await window.oint.settings.write({
         ...settings,
         mcpServers: [],
         systemMcpServerEnabled: { deepwiki: false, arxiv: false },
       });
       const reread = await window.oint.settings.read();
       const next = await window.oint.mcp.reload();
       return {
         persisted: reread.systemMcpServerEnabled,
         hasTrustField: Object.prototype.hasOwnProperty.call(reread, "systemMcpServerTrusted"),
         hasExposureField: Object.prototype.hasOwnProperty.call(reread, "mcpToolExposure"),
         enabled: next.filter((item) => item.source === "system" && item.config.enabled).map((item) => item.config.id),
       };
     })()`,
  );
  check(
    "启停选择落盘为布尔值（非法值会被归一化丢掉）",
    toggled.persisted?.deepwiki === false && toggled.persisted?.arxiv === false,
    `enabled=${JSON.stringify(toggled.persisted)}`,
  );
  check(
    "启停生效：关掉的没连、其余照常",
    !toggled.enabled.includes("deepwiki") &&
      !toggled.enabled.includes("arxiv") &&
      toggled.enabled.includes("wikipedia"),
    `${toggled.enabled.length} 条仍启用`,
  );
  check(
    "「信任」与「暴露策略」两个设置字段已彻底移除（不是只在界面上藏起来）",
    toggled.hasTrustField === false && toggled.hasExposureField === false,
    `systemMcpServerTrusted=${toggled.hasTrustField} mcpToolExposure=${toggled.hasExposureField}`,
  );

  const stillThere = await evaluate(cdp, `window.oint.mcp.list().then((v) => v.length)`);
  check(
    "停用的预设仍留在列表里（否则用户没法重新打开）",
    stillThere === system.length,
    `${stillThere} 行`,
  );

  // --- 5. 单台重连（卡片右上角那个按钮的数据层） ------------------------------
  const seeded = await evaluate(
    cdp,
    `(async () => {
       const settings = await window.oint.settings.read();
       await window.oint.settings.write({
         ...settings,
         mcpServers: [{
           id: "mcp-probe-user", name: "探针的 server", enabled: true, transport: "http",
           command: "", args: [], env: {}, cwd: "",
           url: "https://mcp.grep.app", headers: {}, createdAt: Date.now(),
         }],
       });
       const views = await window.oint.mcp.reload();
       const user = views.find((item) => item.config.id === "mcp-probe-user");
       return { status: user?.state.status ?? null, tools: user?.state.tools.length ?? 0 };
     })()`,
  );
  check(
    "用户自加的 server 能接上（下面用它验证卡片上的操作）",
    seeded.status === "ready" && seeded.tools > 0,
    `status=${seeded.status}，工具=${seeded.tools}`,
  );

  const reconnected = await evaluate(
    cdp,
    `(async () => {
       const views = await window.oint.mcp.reconnect("grep-app");
       const target = views.find((item) => item.source === "system" && item.config.id === "grep-app");
       const others = views.filter(
         (item) => item.source === "system" && item.config.id !== "grep-app" &&
           item.config.enabled && item.state.status === "ready",
       );
       return { status: target?.state.status ?? null, othersReady: others.length };
     })()`,
  );
  check(
    "reconnect 只重连指定那一台，其余保持已连接（不按设置对账整张表）",
    reconnected.status === "ready" && reconnected.othersReady > 20,
    `目标=${reconnected.status}，其余仍就绪=${reconnected.othersReady}`,
  );

  const reconnectDisabled = await evaluate(
    cdp,
    `window.oint.mcp.reconnect("deepwiki").then((views) => {
       const row = views.find((item) => item.source === "system" && item.config.id === "deepwiki");
       return row?.state.status ?? null;
     })`,
  );
  check(
    "停用的 server 点重连不会连上（配置不在生效列表里）",
    reconnectDisabled === "idle",
    `status=${reconnectDisabled}`,
  );

  // --- 5. 设置面板 UI（真实渲染层，不是 jsdom） ------------------------------
  //
  // 前面四组验的是数据链，这一组验的是「用户真的看得到」：打开设置 → MCP 与魔法提示两个
  // 分栏 → 系统 / 用户页签各自的内容。要点有两个：
  //   · 点击一律走 CDP 的真实鼠标事件（见 clickByExpression 的注释：Radix 的页签不吃合成 click）；
  //   · 选择器只用无障碍属性（aria-label / role / aria-pressed），不依赖 class。
  const settingsOpened = await clickByExpression(cdp, BUTTON_BY_LABEL("设置"));
  check("设置面板能打开", settingsOpened, settingsOpened ? "已点击侧栏「设置」" : "没找到设置按钮");
  await waitForText(cdp, "MCP", 8000);

  const mcpTabClicked = await clickByExpression(cdp, TAB_BY_TEXT("MCP"));
  const mcpLoaded = mcpTabClicked && (await waitForText(cdp, "Context7", 20_000));
  const mcpText = await evaluate(cdp, "document.body.innerText");
  check(
    "MCP 系统页签在真实界面里列出预设（默认落在系统页签）",
    mcpLoaded && mcpText.includes("系统预设") && mcpText.includes("Wikipedia"),
    mcpLoaded
      ? `系统预设=${mcpText.includes("系统预设")}，Context7/Wikipedia=${mcpText.includes("Context7")}/${mcpText.includes("Wikipedia")}`
      : "面板没出现预设内容",
  );
  check(
    "预设按领域分组显示（三十多台平铺的话根本找不到东西）",
    ["知识与百科", "学术与科学", "地球与气候"].every((label) => mcpText.includes(label)),
    `分组标题可见=${["知识与百科", "学术与科学", "地球与气候"].filter((label) => mcpText.includes(label)).join(" / ")}`,
  );
  check(
    "面板上既没有「已聚合」标签，也没有工具暴露策略选项（一律聚合，不给选择）",
    !mcpText.includes("已聚合") && !mcpText.includes("工具暴露策略"),
    `含「已聚合」=${mcpText.includes("已聚合")}，含「工具暴露策略」=${mcpText.includes("工具暴露策略")}`,
  );
  const systemSwitchCount = await evaluate(
    cdp,
    `(() => {
       // 先按标题精确定位，再向上找卡片 —— 直接找含 "Context7" 的 div 会命中外层容器，
       // 把整页所有卡片的开关都数进去（实测数到 34 个）
       const title = [...document.querySelectorAll("span")].find(
         (item) => (item.textContent ?? "").trim() === "Context7",
       );
       const card = title?.closest("div.rounded-xl") ?? null;
       return card === null ? -1 : card.querySelectorAll('[role="switch"]').length;
     })()`,
  );
  check(
    "系统预设卡片上只有「启用」一个开关（信任一律允许，没有开关）",
    systemSwitchCount === 1,
    `卡片上的开关数=${systemSwitchCount}`,
  );

  const userSegmentClicked = await clickByExpression(cdp, SEGMENT_BY_TEXT("用户"));
  await sleep(400);
  const userText = await evaluate(cdp, "document.body.innerText");
  const hasAddButton = await evaluate(
    cdp,
    `[...document.querySelectorAll("button")].some((item) => (item.textContent ?? "").includes("添加服务器"))`,
  );
  check(
    "切到「用户」页签后才有「添加服务器」（系统预设不可编辑）",
    userSegmentClicked && hasAddButton && !userText.includes("系统预设"),
    `有添加按钮=${hasAddButton}，系统区块已隐藏=${!userText.includes("系统预设")}`,
  );
  check(
    "用户卡片上也有独立的重新连接按钮",
    (await evaluate(cdp, `document.querySelectorAll('button[aria-label="重新连接"]').length`)) === 1,
    `用户页签上的重连按钮数=${await evaluate(cdp, `document.querySelectorAll('button[aria-label="重新连接"]').length`)}`,
  );

  // 「更多操作」菜单：删除收进菜单里（不再是一个裸的删除图标）
  const systemReconnectCount = await evaluate(
    cdp,
    `(async () => {
       const userTab = [...document.querySelectorAll("button[aria-pressed]")].find(
         (item) => (item.textContent ?? "").trim() === "系统",
       );
       userTab?.click();
       await new Promise((r) => setTimeout(r, 300));
       return document.querySelectorAll('button[aria-label="重新连接"]').length;
     })()`,
  );
  check(
    "系统页签每张卡片都有重新连接按钮（34 台 → 34 个）",
    systemReconnectCount === system.length,
    `${systemReconnectCount} 个 / ${system.length} 台`,
  );

  await clickByExpression(cdp, SEGMENT_BY_TEXT("用户"));
  await sleep(300);
  const moreOpened = await clickByExpression(cdp, BUTTON_BY_LABEL("更多操作"));
  await sleep(300);
  const menuText = await evaluate(
    cdp,
    `(() => {
       const menu = document.querySelector('[role="menu"]');
       return menu === null ? "" : menu.innerText;
     })()`,
  );
  check(
    "用户卡片的「更多操作」菜单里有编辑与删除",
    moreOpened && menuText.includes("删除") && menuText.includes("编辑"),
    `菜单内容=${menuText.replace(/\n/g, " / ") || "(没打开)"}`,
  );
  const menuDeleteCount = await evaluate(
    cdp,
    `document.querySelectorAll('[role="menuitem"]').length`,
  );
  check("菜单项数量正确（编辑 + 删除）", menuDeleteCount === 2, `${menuDeleteCount} 项`);
  // 关掉菜单，别影响后面的检查
  await evaluate(
    cdp,
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(200);

  const promptsTabClicked = await clickByExpression(cdp, TAB_BY_TEXT("魔法提示"));
  await sleep(500);
  // 魔法提示面板默认落在「用户」页签，先切到「系统」
  await clickByExpression(cdp, SEGMENT_BY_TEXT("系统"));
  const promptsLoaded = await waitForText(cdp, "tdd", 15_000);
  const promptsText = await evaluate(cdp, "document.body.innerText");
  const hasNewButton = await evaluate(
    cdp,
    `[...document.querySelectorAll("button")].some((item) => (item.textContent ?? "").includes("新建魔法提示"))`,
  );
  check(
    "魔法提示系统页签列出内置提示，且没有「新建」入口（只读）",
    promptsTabClicked && promptsLoaded && !hasNewButton,
    `内置项可见=${promptsLoaded}，无新建按钮=${!hasNewButton}，含 review/commit=${promptsText.includes("review")}/${promptsText.includes("commit")}`,
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
  if (appLog.length > 0) {
    console.log("---- 应用日志尾部 ----");
    console.log(appLog.join("").slice(-2000));
  }
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n系统资源：全部通过" : `\n系统资源：失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
