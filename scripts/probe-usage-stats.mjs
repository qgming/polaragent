// Deterministic native SQLite usage fixture → preload report → actual statistics UI and renderer reload.
// Does not read/copy user data or call a model. Run after npm run build.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(import.meta.dirname, "..");

const PORT = 19413;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oint-stats-probe-"));
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");
const SESSIONS = path.join(DATA_DIR, "sessions-v1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 两个本地日期键之间相差几天（to - from） */
function dayDiff(from, to) {
  return Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000,
  );
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
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

async function until(fn, { timeoutMs = 20_000, stepMs = 200 } = {}) {
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

async function seedDataDir() {
  const dependencies = Object.keys(require("../package.json").dependencies);
  await build({
    configFile: false, logLevel: "warn", resolve: { alias: { "@": path.join(ROOT, "src") } },
    build: { target: "node22", outDir: path.join(TMP, "compiled"), emptyOutDir: false,
      lib: { entry: path.join(ROOT, "scripts/probe-usage-stats-fixture.ts"), formats: ["es"], fileName: () => "fixture.js" },
      rolldownOptions: { external: (id) => id === "electron" || id.startsWith("node:") || builtinModules.includes(id) || dependencies.some((name) => id === name || id.startsWith(`${name}/`)) },
    },
  });
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ type: "module" }));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(TMP, "node_modules"), "junction");
  const fixture = await import(pathToFileURL(path.join(TMP, "compiled/fixture.js")).href);
  return fixture.seedUsageStats(DATA_DIR);
}

const seeded = await seedDataDir();
console.log(`[probe] synthetic native SQLite fixture: ${JSON.stringify(seeded)} in ${DATA_DIR}`);

const env = { ...process.env, OINT_HOME: DATA_DIR };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT,
  windowsHide: true,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));

let page = null;

/** 侧栏那颗按钮的可访问名（两种语言都认，避免探针依赖界面语言） */
const STATS_LABELS = ["数据统计", "Usage"];
const PLUGINS_LABELS = ["插件", "Plugins"];

const clickSidebarButton = (labels) => `(() => {
  const hit = [...document.querySelectorAll("aside button[aria-label]")].find(
    (node) => ${JSON.stringify(labels)}.includes(node.getAttribute("aria-label")),
  );
  if (!hit) return false;
  hit.click();
  return true;
})()`;

const DIALOG_OPEN = `document.querySelector('[data-slot="dialog-content"]') !== null`;
const DIALOG_TITLE = `document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-title"]')?.textContent ?? null`;
/** 搜索模态窗里输入关键词并选中第一条命令（Ctrl+K 那条真实路径） */
const searchFor = (keyword) => `(() => {
  const input = document.querySelector('[data-slot="command-palette"] input');
  if (!input) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(keyword)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
})()`;

const clickPaletteOption = (label) => `(() => {
  const options = [...document.querySelectorAll('[data-slot="command-palette"] [role="option"]')];
  const hit = options.find((node) => (node.textContent ?? "").includes(${JSON.stringify(label)}));
  if (!hit) return null;
  hit.click();
  return hit.textContent;
})()`;

const CLOSE_DIALOG = `(() => {
  const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
  if (!close) return false;
  close.click();
  return true;
})()`;

/** 面板的读数快照：全部从 DOM 上读，不碰内部状态 */
const PANEL_SNAPSHOT = `(() => {
  const all = [...document.querySelectorAll('[data-slot="heat-cell"]')];
  // 只看「今天及以前」的格子：本周剩余的那几格是占位（data-level 为 -1、值恒为 0），
  // 把它们算进单调性检查会让任何累计视图都判失败
  const cells = all.filter((node) => node.getAttribute("data-level") !== "-1");
  const values = cells.map((node) => Number(node.getAttribute("data-value") ?? "0"));
  const segments = [...document.querySelectorAll('[data-slot="donut-segment"]')];
  const legendRows = [...document.querySelectorAll('[data-slot="model-legend-row"]')];
  const lines = [...document.querySelectorAll('[data-slot="trend-line"]')];
  return {
    hasSummary: document.querySelector('[data-slot="stats-summary"]') !== null,
    summaryText: document.querySelector('[data-slot="stats-summary"]')?.textContent ?? "",
    cellCount: all.length,
    maxCellValue: values.length > 0 ? Math.max(...values) : 0,
    nonZeroCells: values.filter((value) => value > 0).length,
    monotone: values.every((value, index) => index === 0 || value >= values[index - 1]),
    sameWeekSpread: (() => {
      // 同一列（同一周）里的非零值应当完全一致 —— 每周口径的判据
      const columns = cells.reduce((acc, node, index) => {
        const value = Number(node.getAttribute("data-value") ?? "0");
        if (value <= 0) return acc;
        const column = Math.floor(index / 7);
        (acc[column] ??= new Set()).add(value);
        return acc;
      }, {});
      return Object.values(columns).every((set) => set.size === 1);
    })(),
    donutSegments: segments.length,
    legendRows: legendRows.length,
    legendText: legendRows.map((row) => row.textContent ?? "").join(" | "),
    trendLines: lines.length,
    trendSegments: lines.map((node) => ((node.getAttribute("d") ?? "").match(/C/g) ?? []).length),
    emptyTrend: (document.body.textContent ?? "").includes("这段时间还没有用量记录"),
    scanning: (document.body.textContent ?? "").includes("正在整理历史用量"),
    scopeText: document.querySelector('[data-slot="stats-scope"]')?.textContent ?? "",
    firstLegendRow: legendRows[0]?.textContent ?? null,
  };
})()`;

/** 点面板里的分段控件（每日 / 每周 / 累计 / 近 7 日 / 近 30 日），两种语言都认 */
const clickSegmented = (labels) => `(() => {
  const hit = [...document.querySelectorAll('[data-slot="dialog-content"] button[aria-pressed]')].find(
    (node) => ${JSON.stringify(labels)}.includes((node.textContent ?? "").trim()),
  );
  if (!hit) return false;
  hit.click();
  return true;
})()`;

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

  check(
    "界面已挂载",
    await until(async () => await evaluate(page, `document.querySelector("aside") !== null`), {
      timeoutMs: 30_000,
    }),
    "React 树已提交",
  );

  // 2) preload 真的暴露了统计通道（这一段断了界面只会永远转圈）
  check(
    "preload 暴露了 stats.report",
    (await evaluate(page, `typeof window.oint.stats?.report`)) === "function",
    "window.oint.stats.report 可用",
  );

  // 3) IPC 往返：报告的形状与内部自洽（占比之和为 1、每日合计等于总量）
  const report = await evaluate(page, `window.oint.stats.report()`);
  const shapeOk =
    typeof report?.generatedAt === "number" &&
    /^\d{4}-\d{2}-\d{2}$/.test(report?.today ?? "") &&
    Array.isArray(report?.days) &&
    Array.isArray(report?.models) &&
    typeof report?.streak?.current === "number" &&
    typeof report?.scanning?.active === "boolean";
  check("stats.report 返回形状正确的报告", shapeOk, `today=${report?.today} days=${report?.days?.length}`);

  const daySum = (report?.days ?? []).reduce((sum, day) => sum + day.tokens, 0);
  check(
    "dated + undated balances equal native total",
    daySum + (report?.undatedTokens ?? 0) === report?.totalTokens && daySum === seeded.datedTokens,
    `${daySum} + ${report?.undatedTokens} vs ${report?.totalTokens}`,
  );
  const shareSum = (report?.models ?? []).reduce((sum, model) => sum + model.share, 0);
  check(
    "模型占比之和为 1（没有漏算的模型）",
    (report?.models ?? []).length === 0 || Math.abs(shareSum - 1) < 1e-6,
    `Σshare=${shareSum}`,
  );
  check(
    "native UsageDoc/journal balances match the synthetic fixture",
    report?.totalTokens === seeded.totalTokens && report?.undatedTokens === seeded.undatedTokens,
    `total=${report?.totalTokens}, undated=${report?.undatedTokens}`,
  );

  // 4) 走用户真实路径：点侧栏底部的「数据统计」
  check("侧栏有数据统计入口", await evaluate(page, clickSidebarButton(STATS_LABELS)), "已点击");
  const opened = await until(async () => await evaluate(page, DIALOG_OPEN));
  check("点击后模态窗挂出来了", opened, opened ? "dialog-content 在 DOM 里" : "没有出现对话框");
  const title = await evaluate(page, DIALOG_TITLE);
  check(
    "标题是数据统计（按当前语言）",
    STATS_LABELS.includes((title ?? "").trim()),
    `「${title}」`,
  );

  // 5) 面板真的渲染出内容（而不是永远停在加载态）
  const rendered = await until(
    async () => (await evaluate(page, PANEL_SNAPSHOT))?.hasSummary === true,
    { timeoutMs: 30_000 },
  );
  check("面板渲染出概览卡（不是卡在加载态）", rendered, rendered ? "五个读数都在" : "30 秒内没有出数");

  // 6) 折叠进度走完（历史是分拍折叠的，界面靠轮询收敛）
  const converged = await until(
    async () => (await evaluate(page, PANEL_SNAPSHOT))?.scanning === false,
    { timeoutMs: 30_000 },
  );
  const finalReport = await evaluate(page, `window.oint.stats.report()`);
  check(
    "历史折叠收敛（进度行消失、scanning.active 为假）",
    converged && finalReport?.scanning?.active === false,
    `scanned=${finalReport?.scanning?.scanned}/${finalReport?.scanning?.total}`,
  );

  const snapshot = await evaluate(page, PANEL_SNAPSHOT);

  // 7) 热力图：一年网格；有数据时最高那格就是报告里的峰值
  check("热力图是一年网格（53 × 7）", snapshot.cellCount === 53 * 7, `${snapshot.cellCount} 格`);
  if ((finalReport?.totalTokens ?? 0) > 0) {
    check(
      "热力图最大格与报告的峰值一致（图表读的是同一份数据）",
      snapshot.maxCellValue === finalReport?.peak?.tokens,
      `${snapshot.maxCellValue} vs ${finalReport?.peak?.tokens}`,
    );
    check(
      "有记录的格子数 ≥ 有记录的天数",
      snapshot.nonZeroCells >= (finalReport?.days?.length ?? 0),
      `${snapshot.nonZeroCells} 格 / ${finalReport?.days?.length} 天`,
    );

    // 8) 口径切换：每周 → 同一列的值完全一致；累计 → 单调不减（含没有记录的那几天）
    check("切到「每周」", await evaluate(page, clickSegmented(["每周", "Weekly"])), "已点击");
    const weekly = await evaluate(page, PANEL_SNAPSHOT);
    check(
      "每周口径：同一周的格子共享同一个值",
      weekly.sameWeekSpread,
      `最大格 ${weekly.maxCellValue}`,
    );

    check("切到「累计」", await evaluate(page, clickSegmented(["累计", "Cumulative"])), "已点击");
    const cumulative = await evaluate(page, PANEL_SNAPSHOT);
    check(
      "累计口径：格子值单调不减（没有记录的日子延续前值，不回落到 0）",
      cumulative.monotone && cumulative.maxCellValue === seeded.datedTokens,
      `最大格 ${cumulative.maxCellValue} / dated ${seeded.datedTokens}`,
    );

    // 9) 时间范围：范围里有没有数据由**报告**决定，界面必须与之一致（不能凭感觉断言）
    const lastDay = finalReport?.days?.at(-1)?.date ?? null;
    const daysAgo = lastDay === null ? null : dayDiff(lastDay, finalReport.today);
    const wantsRange7 = daysAgo !== null && daysAgo <= 6;

    check("切到「近 30 日」", await evaluate(page, clickSegmented(["近 30 日", "Last 30 days"])), "已点击");
    const wide = await evaluate(page, PANEL_SNAPSHOT);
    check(
      "近 30 日：数据落在范围里就画线，且横轴是 30 个点（29 段曲线）",
      wide.trendLines === 0 || wide.trendSegments[0] === 29,
      `${wide.trendLines} 线 / ${wide.trendSegments[0]} 段`,
    );
    check(
      "近 7 日与近 30 日的取舍与数据一致（最近一条记录在不在窗口里）",
      wantsRange7
        ? snapshot.trendLines > 0 && (snapshot.trendSegments[0] ?? 0) === 6
        : snapshot.trendLines === 0 && snapshot.emptyTrend,
      `最近记录 ${lastDay ?? "无"}（${daysAgo ?? "-"} 天前）：7 日视图 ${snapshot.trendLines} 线 / ${snapshot.trendSegments[0]} 段`,
    );
    check(
      "趋势线与图例逐条对应（画了什么就列了什么）",
      wide.trendLines === wide.legendRows,
      `${wide.trendLines} 线 / ${wide.legendRows} 行`,
    );
    check(
      "环图分段数与图例一致",
      wide.donutSegments === wide.legendRows,
      `${wide.donutSegments} 段 / ${wide.legendRows} 行`,
    );
    check(
      "图例里给出了占比（用户能读到比例）",
      /%/.test(wide.legendText),
      wide.firstLegendRow?.replace(/\s+/g, " ") ?? "空",
    );
  } else {
    check(
      "没有用量时给出空态而不是空白图",
      snapshot.emptyTrend && snapshot.legendRows === 0,
      snapshot.emptyTrend ? "空态文案在" : "没有空态文案",
    );
  }

  // Native SQLite and the journal are the sole persisted usage authority.
  check("native sessions-v1 SQLite exists", fs.existsSync(path.join(SESSIONS, `${seeded.sessionId}.sqlite`)), seeded.sessionId);
  check("no derived usage ledger file is created", !fs.existsSync(path.join(DATA_DIR, "usage-stats.json")), "report reads native documents");
  check("undated balance is explicitly annotated", /75/.test(snapshot.scopeText) && /日期未保留|without a retained date/.test(snapshot.scopeText), snapshot.scopeText);
  check("undated-only model stays in total model accounting", finalReport.models.some((model) => model.modelId === "undated-only" && model.tokens === 75), JSON.stringify(finalReport.models));
  check("undated-only model is excluded from dated chart legend and donut", snapshot.legendRows === seeded.datedModelCount && snapshot.donutSegments === seeded.datedModelCount && !snapshot.legendText.includes("undated-only"), snapshot.legendText);

  // 11) 模态互斥：打开插件管理应当把统计收掉
  check("侧栏有插件入口", await evaluate(page, clickSidebarButton(PLUGINS_LABELS)), "已点击");
  const swapped = await until(
    async () => (await evaluate(page, DIALOG_TITLE)) !== null && !STATS_LABELS.includes((await evaluate(page, DIALOG_TITLE) ?? "").trim()),
    { timeoutMs: 8_000 },
  );
  check("打开插件管理后统计模态窗被换掉（互斥）", swapped, `当前标题：${await evaluate(page, DIALOG_TITLE)}`);

  // 12) 再打开一次：数据先在、刷新在后台（不回到加载态）
  await evaluate(page, CLOSE_DIALOG);
  await until(async () => !(await evaluate(page, DIALOG_OPEN)), { timeoutMs: 5_000 });
  check("关闭按钮能收起对话框", !(await evaluate(page, DIALOG_OPEN)), "已关闭");

  await evaluate(page, clickSidebarButton(STATS_LABELS));
  const reopened = await until(
    async () => (await evaluate(page, PANEL_SNAPSHOT))?.hasSummary === true,
    { timeoutMs: 10_000 },
  );
  const secondReport = await evaluate(page, `window.oint.stats.report()`);
  check(
    "再打开时立刻有数（用的是上一次的报告）",
    reopened,
    reopened ? "概览卡即时可见" : "没有立刻出数",
  );
  check(
    "第二次读取不再重新折叠（稳态零扫描）",
    secondReport?.scanning?.active === false && secondReport?.scanning?.scanned === secondReport?.scanning?.total,
    `${secondReport?.scanning?.scanned}/${secondReport?.scanning?.total}`,
  );

  // 13) 搜索入口：Ctrl+K → 搜「数据统计」→ 选中即打开（与设置分栏同一条路径）
  await evaluate(page, CLOSE_DIALOG);
  await until(async () => !(await evaluate(page, DIALOG_OPEN)), { timeoutMs: 5_000 });
  await evaluate(
    page,
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`,
  );
  const paletteOpen = await until(
    async () => await evaluate(page, `document.querySelector('[data-slot="command-palette"]') !== null`),
    { timeoutMs: 8_000 },
  );
  check("Ctrl+K 打开搜索模态窗", paletteOpen, paletteOpen ? "命令面板在" : "没有出现");
  if (paletteOpen) {
    await evaluate(page, searchFor(STATS_LABELS[0]));
    // 命令列表是异步过滤出来的：轮询到那条命令出现，再点它（并把点中的那一行读回来）
    let optionText = null;
    await until(
      async () => {
        optionText = await evaluate(page, clickPaletteOption(STATS_LABELS[0]));
        return optionText !== null;
      },
      { timeoutMs: 5_000 },
    );
    check(
      "搜「数据统计」能找到并打开它",
      optionText !== null,
      optionText === null ? "没有这条命令" : String(optionText).replace(/\s+/g, " ").trim(),
    );
    const viaSearch = await until(async () => await evaluate(page, DIALOG_OPEN), { timeoutMs: 8_000 });
    check("从搜索进入的也是同一个模态窗", viaSearch, viaSearch ? "已打开" : "没有打开");
  }

  await page.send("Page.reload");
  await until(async () => await evaluate(page, `typeof window.oint?.stats?.report === "function" && document.querySelector("aside") !== null`).catch(() => false), { timeoutMs: 15000 });
  const afterReload = await evaluate(page, `window.oint.stats.report()`);
  check("report → renderer reload preserves native totals and dated attribution", afterReload.totalTokens === seeded.totalTokens && afterReload.undatedTokens === seeded.undatedTokens && JSON.stringify(afterReload.days) === JSON.stringify(finalReport.days) && JSON.stringify(afterReload.models) === JSON.stringify(finalReport.models), `total=${afterReload.totalTokens}, undated=${afterReload.undatedTokens}`);
  await evaluate(page, clickSidebarButton(STATS_LABELS));
  const afterReloadUi = await until(async () => (await evaluate(page, PANEL_SNAPSHOT))?.hasSummary === true);
  check("statistics UI reopens after reload with its undated annotation", afterReloadUi && /日期未保留|without a retained date/.test((await evaluate(page, PANEL_SNAPSHOT)).scopeText), "native report survives remount");

  check(
    "渲染层没有报错",
    page.consoleErrors.length === 0,
    page.consoleErrors.length === 0 ? "无" : page.consoleErrors.slice(0, 3).join(" / "),
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (page) await evaluate(page, `window.oint.window.close()`).catch(() => undefined);
  page?.close();
  if (!(await until(async () => child.exitCode !== null, { timeoutMs: 5000 }))) child.kill();
  await sleep(300);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const cleanupTarget = fs.realpathSync(TMP);
  const relativeTarget = path.relative(temporaryRoot, cleanupTarget);
  if (path.isAbsolute(relativeTarget) || path.dirname(relativeTarget) !== "." || !path.basename(cleanupTarget).startsWith("oint-stats-probe-")) throw new Error("Unsafe stats probe cleanup target");
  fs.rmSync(cleanupTarget, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
