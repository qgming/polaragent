// 设备视口（右侧浏览器面板的「手机 / 平板 / 桌面」菜单）的真实 Electron 验证。
//
// 为什么必须真机验：这条链上有两个假设，**单测与类型系统都看不出对错**——
//   A. 选某一档之后，**guest 自己的布局视口**确实变成了那个尺寸
//      （面板改的是 webview 元素的 CSS 尺寸，而布局视口是 guest 那边的读数）；
//   B. 装不下时用 CSS `transform: scale()` 缩小，**guest 的画面真的跟着缩小了**。
//      若 Electron 不对 guest 应用祖先的 transform，画面会被裁成设备中间的一条
//      而不是整台设备 —— 而 DOM 上一切正常（元素尺寸与 transform 都在），只有像素能戳破。
//
// ## 怎么在不能进 guest 的前提下验这两件事
//
// Electron 的 webview guest **不出现在 `/json/list`**（实测：只有渲染层一个 page 目标），
// 探针进不去 guest 求值。所以判据全部落在**屏幕上画出来的像素**上，探针页面被写成
// 「按视口宽度换底色」的样子：
//
//   · ≤420px  → 品红   （手机档 / 自适应档在默认 380px 侧栏下的宽度）
//   · 421–999 → 蓝     （平板档 834）
//   · ≥1000px → 绿     （桌面档 1440）
//
// 底色是品红还是绿，只取决于 **guest 自己的布局视口宽度** ——
// 这正是「适配不同设备」这件事的实质，而且是页面自己的 media query 做出的判断，
// 不是我们替它算的。另有角标红方块用来验缩放（见下）。
//
// 用法：node scripts/probe-browser-viewport.mjs

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = 19347;
const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), "oint-browser-viewport-probe");
const USER_DATA = path.join(TMP, "userdata");
const DATA_DIR = path.join(TMP, "data");

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

/**
 * 极简 PNG 解码：只认 Chromium 截图那种形态（8 位 RGBA、非隔行）。
 *
 * 为什么自己写而不是装库：这是一次性的探针，而本仓对新增依赖一贯谨慎；
 * PNG 的扫描线解码只有「反过滤」这一段，五种过滤器一共十来行。
 */
function decodePng(buffer) {
  let offset = 8; // 跳过 8 字节签名
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(
      `不支持的 PNG 形态：bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    );
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  // colorType 2 = RGB（截图常见），6 = RGBA；两者的反过滤逻辑相同，只是每像素字节数不同
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = x >= bpp && prev !== null ? prev[x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`未知的 PNG 过滤器 ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }

  return { width, height, data: out, bpp };
}

/**
 * 量一个颜色的分布：包围盒 + 像素数 + 该颜色在「页面左上角」与「右下角」附近的像素数。
 *
 * 两个角落各放了一个 20×20 的红方块（页面侧是 relative / fixed 定位）：
 *   · 缩放生效 → 整页都在，两个方块都看得见，边长约 20×scale；
 *   · 缩放没生效 → 元素被居中裁切，看到的是页面中间那一条，两个方块都不在画面里。
 * 所以「红方块还在不在」就是缩放是否作用于 guest 的判据。
 */
function measureColor(image, predicate) {
  const matches = [];
  const { bpp } = image;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * bpp;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) matches.push([x, y]);
    }
  }
  if (matches.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (const [x, y] of matches) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    count: matches.length,
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    matches,
  };
}

/** 某个矩形区域里的命中数（用来判断角落的红方块在不在） */
function countInRegion(color, region) {
  let hits = 0;
  for (const [x, y] of color.matches) {
    if (x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY) hits += 1;
  }
  return hits;
}

const isGreen = (r, g, b) => g > 180 && r < 90 && b < 90;
const isMagenta = (r, g, b) => r > 180 && b > 180 && g < 90;
const isBlue = (r, g, b) => b > 180 && r < 90 && g < 90;
const isRed = (r, g, b) => r > 180 && g < 90 && b < 90;

/** 底色 → 那一档的布局视口落在哪个宽度区间（判据来自探针页面自己的 media query） */
function describeBand(image) {
  const green = measureColor(image, isGreen);
  const magenta = measureColor(image, isMagenta);
  const blue = measureColor(image, isBlue);
  const candidates = [
    { band: "≥1000px", color: green },
    { band: "421–999px", color: blue },
    { band: "≤420px", color: magenta },
  ].filter((item) => item.color !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.color.count - a.color.count);
  return candidates[0];
}

/**
 * 在渲染层里挑一档设备。
 *
 * 两处都要容错，因为探针跑在一个**语言不确定**的应用里（界面语言跟应用设置走）：
 *   · 按钮用 aria-label 找，中英两种写法都认；
 *   · 菜单项按正则匹配（"平板" / "Tablet"）。
 * Radix 的菜单在 pointerdown 上展开（不是 click），item 上派发 click 才选中。
 */
async function pickDevice(cdp, labelPattern) {
  return evaluate(
    cdp,
    `(async () => {
      const trigger = Array.from(document.querySelectorAll("button[aria-label]")).find((node) =>
        /设备视口|Device viewport/i.test(node.getAttribute("aria-label") ?? ""),
      );
      if (trigger === undefined) {
        const labels = Array.from(document.querySelectorAll("button[aria-label]")).map((n) => n.getAttribute("aria-label"));
        return { ok: false, reason: "找不到设备菜单按钮，现有按钮：" + labels.join(" / ") };
      }
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
      await new Promise((r) => setTimeout(r, 300));
      const wanted = new RegExp(${JSON.stringify(labelPattern)});
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const item = items.find((node) => wanted.test(node.textContent ?? ""));
      if (item === undefined) {
        return { ok: false, reason: "菜单里没有匹配 " + wanted + " 的项，现有：" + items.map((n) => n.textContent).join(" / ") };
      }
      item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      item.click();
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true };
    })()`,
  );
}

/** 读设备框的 DOM 事实：档位、布局尺寸、缩放比、屏幕像素比 */
async function readFrame(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const frame = document.querySelector('[data-slot="browser-viewport-frame"]');
      if (frame === null) return null;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      const rect = frame.getBoundingClientRect();
      return {
        device: frame.dataset.device ?? null,
        width: frame.style.width,
        height: frame.style.height,
        scale: Number.isFinite(matrix.a) && matrix.a !== 0 ? matrix.a : 1,
        rect: { width: rect.width, height: rect.height },
        dpr: window.devicePixelRatio,
      };
    })()`,
  );
}

async function screenshot(cdp) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  return decodePng(Buffer.from(shot.data, "base64"));
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/**
 * 探针页面：底色随**自己的布局视口宽度**换，两个角上各放一个 20×20 的红方块。
 *
 * 为什么这样设计：探针进不去 guest（Electron 不把 webview guest 列进 /json/list），
 * 所以「guest 的视口到底多宽」只能由页面自己来判断、再由像素读回来 ——
 * media query 正是页面自己的判断，而底色是它的结论。
 */
const pageFile = path.join(TMP, "viewport.html");
fs.writeFileSync(
  pageFile,
  [
    "<!doctype html><title>VIEWPORT-PROBE</title>",
    "<style>",
    "html,body{margin:0;height:100%;background:#0000ff}",
    "@media (max-width:420px){html,body{background:#ff00ff}}",
    "@media (min-width:1000px){html,body{background:#00ff00}}",
    "#tl{position:absolute;top:0;left:0;width:20px;height:20px;background:#ff0000}",
    "#br{position:fixed;right:0;bottom:0;width:20px;height:20px;background:#ff0000}",
    "</style>",
    '<div id="tl"></div><div id="br"></div>',
  ].join("\n"),
);
const pageUrl = `file:///${pageFile.replace(/\\/g, "/")}`;

const env = { ...process.env, OINT_HOME: DATA_DIR };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));

let cdp = null;
let failed = 0;
let skipped = 0;

function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

function skip(label, detail) {
  skipped += 1;
  console.log(`SKIP | ${label} | ${detail}`);
}

/** 等页面把底色画出来（导航 + 首帧之间有真实延迟） */
async function captureUntil(cdp, wantBand, tries = 20) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    await sleep(400);
    const image = await screenshot(cdp);
    last = { image, band: describeBand(image) };
    if (last.band !== null && (wantBand === null || last.band.band === wantBand)) return last;
  }
  return last;
}

try {
  // 1) 等调试目标与界面挂载（同 probe-browser-guest.mjs 的口径）
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

  let uiReady = false;
  for (let i = 0; i < 60 && !uiReady; i += 1) {
    uiReady = await evaluate(cdp, `document.querySelector("aside") !== null`);
    if (!uiReady) await sleep(300);
  }
  check("界面已挂载", uiReady, uiReady ? "React 树已提交" : "等待界面挂载超时");

  // 2) 开浏览器面板并等 guest 附着
  let panelMounted = false;
  const mountDeadline = Date.now() + 20_000;
  while (Date.now() < mountDeadline && !panelMounted) {
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true })), true`,
    );
    await sleep(400);
    panelMounted = await evaluate(cdp, `document.querySelector("webview") !== null`);
  }
  check("浏览器面板已打开", panelMounted, panelMounted ? "webview 元素已出现" : "20 秒内没有出现 webview");

  // 3) 导航到探针页面（走地址栏 —— 与用户走的是同一条路）
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector("input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(pageUrl)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    })()`,
  );

  const fitCapture = await captureUntil(cdp, null);
  const fitFrame = await readFrame(cdp);
  if (fitCapture.band === null) {
    skip(
      "像素级验证（布局视口 / 缩放）",
      "窗口截图里没有找到探针页面的底色 —— 渲染层截图不含 guest 的画面，这两项只能目视确认",
    );
  } else {
    check(
      "自适应档：页面按**面板可用宽度**渲染（探针页面的 media query 判定为窄视口）",
      fitCapture.band.band === "≤420px",
      `底色判定 band=${fitCapture.band.band}，画出来的绿/品红区域 ${fitCapture.band.color.width}×${fitCapture.band.color.height}px`,
    );
  }

  // 4) 平板档 834：底色应换成蓝（421–999 区间）
  const tablet = await pickDevice(cdp, "平板|Tablet");
  check("能从菜单里选中「平板」档", tablet.ok === true, tablet.ok ? "已选中" : tablet.reason);
  const tabletFrame = await readFrame(cdp);
  check(
    "设备框按设备尺寸布局（DOM 上是 834×1112）",
    tabletFrame.width === "834px" && tabletFrame.height === "1112px",
    `width=${tabletFrame.width} height=${tabletFrame.height} device=${tabletFrame.device}`,
  );
  const tabletCapture = await captureUntil(cdp, "421–999px");
  check(
    "平板档：guest 的布局视口确实落进 421–999（页面自己按 media query 换了底色）",
    tabletCapture.band?.band === "421–999px",
    `底色判定 band=${tabletCapture.band?.band ?? "无"}`,
  );

  // 5) 桌面档 1440×900：底色换绿，并验证缩放真的作用于 guest 画面
  const picked = await pickDevice(cdp, "桌面|Desktop");
  check("能从菜单里选中「桌面」档", picked.ok === true, picked.ok ? "已选中" : picked.reason);
  await sleep(400);
  const desktopFrame = await readFrame(cdp);
  check(
    "设备框按设备尺寸布局（DOM 上是 1440×900）",
    desktopFrame.width === "1440px" && desktopFrame.height === "900px",
    `width=${desktopFrame.width} height=${desktopFrame.height} device=${desktopFrame.device}`,
  );
  check(
    "装不下时整台设备被缩小（transform scale < 1）",
    desktopFrame.scale > 0 && desktopFrame.scale < 1,
    `scale=${desktopFrame.scale.toFixed(3)}`,
  );

  const desktopCapture = await captureUntil(cdp, "≥1000px");
  const desktopBand = desktopCapture.band;
  check(
    "桌面档：guest 的布局视口变成 ≥1000（页面换成了桌面宽度那一档底色）",
    desktopBand?.band === "≥1000px",
    `底色判定 band=${desktopBand?.band ?? "无"}`,
  );

  if (desktopBand === null || desktopBand.band !== "≥1000px") {
    skip("像素级验证缩放是否作用于 guest", "底色没有换成桌面档，缩放断言失去前提");
  } else {
    const dpr = desktopFrame.dpr ?? 1;
    const expectedWidth = 1440 * desktopFrame.scale * dpr;
    const expectedHeight = 900 * desktopFrame.scale * dpr;
    const within = (actual, expected) =>
      Math.abs(actual - expected) <= Math.max(8, expected * 0.08);

    check(
      "页面按缩放后的尺寸画出来（底色包围盒 = 1440×900 × scale × dpr）",
      within(desktopBand.color.width, expectedWidth) &&
        within(desktopBand.color.height, expectedHeight),
      `实测 ${desktopBand.color.width}×${desktopBand.color.height}，期望约 ` +
        `${Math.round(expectedWidth)}×${Math.round(expectedHeight)}` +
        `（scale=${desktopFrame.scale.toFixed(3)} dpr=${dpr}）`,
    );

    /**
     * 两个角落的红方块是**缩放是否真的作用于 guest** 的决定性证据：
     * 不缩放时元素被居中裁切，看到的是 1440 宽页面的中间那一条，
     * 页面左上角与右下角都不在可见范围内 —— 两个方块一个都不会出现。
     */
    const red = measureColor(desktopCapture.image, isRed);
    const mark = 20 * desktopFrame.scale * dpr;
    const box = Math.max(4, Math.round(mark * 1.6));
    const colour = desktopBand.color;
    const topLeftHits =
      red === null
        ? 0
        : countInRegion(red, {
            minX: colour.minX - 4,
            maxX: colour.minX + box,
            minY: colour.minY - 4,
            maxY: colour.minY + box,
          });
    const bottomRightHits =
      red === null
        ? 0
        : countInRegion(red, {
            minX: colour.maxX - box,
            maxX: colour.maxX + 4,
            minY: colour.maxY - box,
            maxY: colour.maxY + 4,
          });

    check(
      "页面左上角的红方块可见 → 缩放真的作用到了 guest 画面上（不是被裁掉左上角）",
      topLeftHits >= mark * mark * 0.3,
      `左上角红像素 ${topLeftHits}，期望约 ${Math.round(mark * mark)}（红方块边长应为 ${mark.toFixed(1)}px）`,
    );
    check(
      "页面右下角的红方块也可见 → 整台设备都在画面里（不是只看到中间一条）",
      bottomRightHits >= mark * mark * 0.3,
      `右下角红像素 ${bottomRightHits}，期望约 ${Math.round(mark * mark)}`,
    );
  }

  // 6) 换回自适应档：视口回到面板尺寸（不留一个「半设备」状态）
  const backToFit = await pickDevice(cdp, "自适应面板|Fit the panel");
  check("能换回自适应档", backToFit.ok === true, backToFit.ok ? "已切回" : backToFit.reason);
  const restored = await captureUntil(cdp, "≤420px");
  check(
    "自适应档恢复后页面又按窄视口渲染（布局视口跟着元素尺寸回去了）",
    restored.band?.band === "≤420px",
    `底色判定 band=${restored.band?.band ?? "无"}`,
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
} finally {
  cdp?.close();
  if (child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? `\n结果：全部通过${skipped > 0 ? `（${skipped} 项跳过，见上面的 SKIP）` : ""}`
    : `\n结果：${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
