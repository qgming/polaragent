// 页面侧脚本与 URL 归一：**纯函数，不依赖 electron**，因此可以在 node 测试里直接跑。
//
// 为什么要单独抽出脚本：注入到 guest 里的这段 JS 是本功能里唯一「跑在别人家页面里」
// 的代码，出错表现是「快照莫名其妙为空」，而它又没法在 Electron 之外调试。
// 抽出来之后至少能测：脚本是合法 JS、字符串转义正确、URL 归一符合预期，
// 以及（见 dom-scripts.test.ts）它在真 DOM 上确实做了该做的事。
//
// ref 的权威位置：页面侧持有
// `window.__ointRefSeq`（自增计数）、`window.__ointEls`（Map<ref, Element>）、
// `window.__ointUid`（WeakMap<Element, ref>）。脚本之间只靠这三个东西互相认人：
//   · 快照给元素发号（首次见到才发，DOM 稳时就复用同一个号）；
//   · 动作按 ref 从 Map 里取元素，再比对**签名**看它还是不是快照里那个语义。
// 刻意不再把 ref 写到 DOM 属性上：属性可以被页面抢占，也会随节点复用残留 ——
// 那正是「ref 静默错点」的源头（点到了快照描述之外的另一个元素上）。

import type { BrowserOptionMatch } from "./types";

/** 快照里返回的最大元素数：再多模型也读不完，只会挤掉别的上下文 */
export const SNAPSHOT_MAX_ELEMENTS = 120;
/** 快照里返回的最大文本字符数 */
export const SNAPSHOT_MAX_TEXT = 6000;
/** 单个元素名的最大字符数 */
const SNAPSHOT_MAX_NAME = 120;
/**
 * 元素被截断后，最多再扫多少个节点来数「还漏了多少可见元素」。
 *
 * 数出来的数字是给模型的「页面不止这些」信号，但极端页面（几千个可交互节点）上
 * 逐个量尺寸会把这个脚本变成一次主线程卡顿 —— 扫描有上限时给的是下限，
 * 比「一个都不报」有用得多。
 */
const SNAPSHOT_OMIT_SCAN_LIMIT = 2000;
/** evaluate 返回值转成 JSON 后的最大字符数 */
export const EVALUATE_MAX_CHARS = 20_000;
/** 探针最多记多少条事件：一次动作的正常事件量是个位数，超过就是页面自己在刷 */
const PROBE_MAX_EVENTS = 20;

/** 下拉框匹配失败时回给模型的选项上限：再多也只是把上下文挤满 */
const SELECT_MAX_OPTIONS = 40;
/** 等待超时时回给模型的当前文本片段长度（够判断页面渲染到哪一步就行） */
const WAIT_EXCERPT_CHARS = 200;

/**
 * 把用户 / 模型给的输入归一成可导航的 URL。
 *
 * 只允许 http(s)：`file:` 能读本地文件、`javascript:` 能执行脚本、`data:` 能带任意
 * 载荷 —— 这些都不是「浏览网页」，而是绕开其它工具的限制读本机数据，所以一律拒绝。
 * 没有 scheme 时按地址栏的习惯补全（`example.com` → `https://example.com`），
 * 但本机地址（localhost / 127.0.0.1）补 http —— 本地 dev server 基本不配 TLS，
 * 补 https 会让「打开我本地的 3000 端口」这种最常见的请求直接失败。
 *
 * 返回 null 表示「不该导航」，由调用方给出可读的拒绝理由。
 */
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;

  // 形如 `scheme://…`：只有 http / https 放行
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme !== "http" && scheme !== "https") return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  // 形如 `scheme:…`（没有 `//`）：`javascript:` / `data:` / `mailto:` / `about:` /
  // `file:/…` 都在这里被挡掉。**例外是 `主机:端口`** —— `localhost:3000` 长得就跟
  // scheme 一模一样，而它是最常见的开发场景。判据是冒号后恰好只有数字。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isHostWithPort(value)) return null;

  // 无 scheme：按「主机名 + 可选端口 + 路径」处理
  const host = hostPart(value);
  // 比较本机名 / 含点判定时必须**去掉端口**：`localhost:3000` 的主机名是 localhost，
  // 带着端口比会判成 false，于是这个最常见的开发场景会被当成搜索词拒掉。
  const hostname = hostnameOf(host);
  // hostname 必须含点、或就是本机名：否则 "hello" 会变成 https://hello 这种死地址，
  // 而那种输入的真实意图是搜索词（模型该用搜索工具，不该把词丢给地址栏）
  if (!hostname.includes(".") && !isLoopbackHost(hostname)) return null;

  try {
    // 本机地址走 http：本地 dev server 基本不配 TLS，补 https 会让
    // 「打开我本地的 3000 端口」这种最常见的请求直接失败。
    const schemeForInput = isLoopbackHost(hostname) ? "http" : "https";
    const parsed = new URL(`${schemeForInput}://${value}`);
    // 再挡一层：拼出来的字符串解析后协议必须仍是 http(s)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 输入里到第一个 `/ ? #` 为止的那一段（就是主机+端口那部分） */
function hostPart(value: string): string {
  return value.split(/[/?#]/, 1)[0] ?? "";
}

/** 去掉 `:端口`：`localhost:3000` → `localhost`（没有端口时原样返回） */
function hostnameOf(host: string): string {
  const colon = host.lastIndexOf(":");
  if (colon <= 0) return host;
  return /^\d+$/.test(host.slice(colon + 1)) ? host.slice(0, colon) : host;
}

/** 形如 `host:1234`（冒号后恰好全是数字）—— 用来把「端口」与「scheme」区分开 */
function isHostWithPort(value: string): boolean {
  const head = hostPart(value);
  const colon = head.lastIndexOf(":");
  if (colon <= 0) return false;
  return /^\d+$/.test(head.slice(colon + 1));
}

/** 本机地址：localhost / 127.0.0.1 / ::1（这些走 http，其余走 https） */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * 页面侧 ref 注册表的接入代码：`window.__ointEls` 是**唯一权威**。
 *
 * 为什么不再按 DOM 属性找元素：旧实现写的是
 * `querySelector('[data-oint-ref="' + ref + '"]')`，而 ref 的值当时由页面上的属性决定 ——
 * 属性可以被页面自己占用，含引号的 ref 更会把属性选择器变成**选择器列表**
 *（`[data-oint-ref="x"],[data-oint-ref="y"]`），`querySelector` 返回文档里第一个匹配者，
 * 于是点击与输入落到快照描述之外的另一个元素上（**ref 静默错点**：
 * 工具报成功，模型以为点的是 A，页面发生的是 B 的事）。现在 ref 只作 Map 的键：
 * 没有字符串拼接、没有转义问题、也不受页面属性影响。
 */
function refRegistryLines(): string[] {
  return [
    "  const __ointRefs = (() => {",
    "    if (!(window.__ointEls instanceof Map)) window.__ointEls = new Map();",
    "    if (!(window.__ointUid instanceof WeakMap)) window.__ointUid = new WeakMap();",
    "    return window.__ointEls;",
    "  })();",
    "  const __ointUid = window.__ointUid;",
    "  const findRef = (ref) => {",
    "    const node = __ointRefs.get(ref);",
    "    return node && node.nodeType === 1 ? node : null;",
    "  };",
    "  const refOf = (node) => {",
    "    let current = node;",
    "    while (current && current.nodeType === 1) {",
    "      const hit = __ointUid.get(current);",
    "      if (typeof hit === 'string') return hit;",
    "      current = current.parentElement;",
    "    }",
    "    return null;",
    "  };",
  ];
}

/**
 * 元素的 role / type / 名字 / 签名：快照、定位、探针三处都必须用**同一套口径**，
 * 否则「快照里是 A、动作时算出 B」会变成一堆假的 REF_DRIFT。
 *
 * `nameOf(el, true)` 是回给模型的元素名（含当前值：模型据此知道输入框里现在是什么），
 * `nameOf(el, false)` 是**签名**用的稳定标签 —— 刻意不含当前值，因为值会随输入变化：
 * 把它算进签名的话，「输入完再点一次同一个字段」这种最常走的序列会立刻被判成
 * 「节点被复用」（REF_DRIFT），而模型学到的会是「这条报错可以忽略」。
 */
function metaLines(): string[] {
  return [
    `  const MAX_NAME = ${SNAPSHOT_MAX_NAME};`,
    "  const part = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();",
    "  const tagOf = (el) => (el.tagName ? String(el.tagName).toLowerCase() : '');",
    "  const typeOf = (el) => (tagOf(el) === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '');",
    "  const textOf = (el) => part(el.innerText || el.textContent || '');",
    "  const roleOf = (el) => {",
    "    const explicit = el.getAttribute('role');",
    "    if (explicit) return explicit;",
    "    const tag = tagOf(el);",
    "    if (tag === 'a') return 'link';",
    "    if (tag === 'button' || tag === 'summary') return 'button';",
    "    if (tag === 'select') return 'combobox';",
    "    if (tag === 'textarea') return 'textbox';",
    "    if (tag === 'input') {",
    "      const type = typeOf(el);",
    "      if (type === 'checkbox') return 'checkbox';",
    "      if (type === 'radio') return 'radio';",
    "      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';",
    "      return 'textbox';",
    "    }",
    "    if (el.isContentEditable === true) return 'textbox';",
    "    return tag;",
    "  };",
    "  const labelFor = (el) => {",
    "    const id = el.getAttribute('id');",
    "    if (!id) return '';",
    "    try {",
    "      const label = document.querySelector('label[for=\"' + CSS.escape(id) + '\"]');",
    "      return label ? part(label.textContent || '') : '';",
    "    } catch (error) {",
    "      return '';",
    "    }",
    "  };",
    "  const nameOf = (el, withValue) => {",
    "    const aria = el.getAttribute('aria-label');",
    "    if (aria && part(aria)) return part(aria).slice(0, MAX_NAME);",
    "    const labelledBy = el.getAttribute('aria-labelledby');",
    "    if (labelledBy) {",
    "      const joined = labelledBy.split(/\\s+/).map((id) => {",
    "        const node = document.getElementById(id);",
    "        return node ? (node.textContent || '') : '';",
    "      }).join(' ');",
    "      if (part(joined)) return part(joined).slice(0, MAX_NAME);",
    "    }",
    "    const tag = tagOf(el);",
    "    if (tag === 'input' || tag === 'textarea' || tag === 'select') {",
    "      const placeholder = el.getAttribute('placeholder');",
    "      if (placeholder && part(placeholder)) return part(placeholder).slice(0, MAX_NAME);",
    "      if (withValue && typeof el.value === 'string' && el.value) return part(el.value).slice(0, MAX_NAME);",
    "      const byLabel = labelFor(el);",
    "      if (byLabel) return byLabel.slice(0, MAX_NAME);",
    "      const title = el.getAttribute('title');",
    "      if (title && part(title)) return part(title).slice(0, MAX_NAME);",
    "      return '';",
    "    }",
    "    const text = textOf(el);",
    "    if (text) return text.slice(0, MAX_NAME);",
    "    const title = el.getAttribute('title');",
    "    if (title && part(title)) return part(title).slice(0, MAX_NAME);",
    "    const alt = el.getAttribute('alt');",
    "    if (alt && part(alt)) return part(alt).slice(0, MAX_NAME);",
    "    return '';",
    "  };",
    "  const signatureOf = (el) => [roleOf(el), tagOf(el), typeOf(el), nameOf(el, false)].map(part).join('|');",
  ];
}

/**
 * 在页面里求一段 JS（browser_evaluate 的逃生门）。
 *
 * 序列化刻意做了**降级**而不是静默丢内容：
 * `JSON.stringify(document.querySelector('h1'))` 会得到 `{}` —— DOM 节点没有可枚举的自有属性，
 * 于是模型看到「{}」，既不知道拿到的是什么，也不知道为什么是空的。旧实现还有第二个坑：
 * 一旦 JSON.stringify 抛错（循环引用），它只回一句 `<unserializable: …>`，
 * 连「拿到的是个函数还是循环引用」都分不出来。这里给每种怪东西一个 `__kind` 标记：
 *   Node → `{__kind:"Node", tag, text}`；Function → `{__kind:"Function", name}`；
 *   undefined / Symbol / BigInt / Map / Set / Promise / RegExp / 循环引用 同理。
 * 于是「模型写了段错代码」与「页面真的给出一个空对象」不再长得一样。
 */
export function buildEvaluateExpression(code: string): string {
  return [
    "(async () => {",
    "  try {",
    // 内层用 eval 而不是 new Function：模型写 `document.title` 这种表达式时，
    // eval 直接给值；写多语句块时也能跑。await 由外层 async 提供。
    `    const __value = await eval(${JSON.stringify(code)});`,
    "    const __seen = [];",
    "    const __replacer = function (key, value) {",
    // 维护「当前所在的容器」栈：JSON.stringify 是深度优先的，replacer 的 this
    // 就是持有当前值的对象 —— 靠它把循环引用与递归深度分开判。
    "      while (__seen.length > 0 && __seen[__seen.length - 1] !== this) __seen.pop();",
    "      if (typeof value === 'function') {",
    "        return { __kind: 'Function', name: String(value.name || ''), text: String(value).slice(0, 200) };",
    "      }",
    "      if (typeof value === 'symbol') return { __kind: 'Symbol', text: String(value) };",
    "      if (typeof value === 'bigint') return { __kind: 'BigInt', value: String(value) };",
    "      if (typeof value === 'undefined') return { __kind: 'undefined' };",
    "      if (value === null || typeof value !== 'object') return value;",
    "      if (typeof Node !== 'undefined' && value instanceof Node) {",
    "        return {",
    "          __kind: 'Node',",
    "          nodeType: value.nodeType,",
    "          tag: value.tagName ? String(value.tagName).toLowerCase() : '',",
    "          text: String(value.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),",
    "        };",
    "      }",
    "      if (typeof Window !== 'undefined' && value === Window.prototype.window) return { __kind: 'Window' };",
    "      if (value instanceof RegExp) return { __kind: 'RegExp', text: String(value) };",
    "      if (value instanceof Promise) return { __kind: 'Promise' };",
    "      if (value instanceof Map) {",
    // 只回键名与大小：把键值原样塞回去会让循环引用与深度控制彻底失效
    "        return { __kind: 'Map', size: value.size, keys: Array.from(value.keys()).slice(0, 10).map(function (k) { return String(k); }) };",
    "      }",
    "      if (value instanceof Set) {",
    "        return { __kind: 'Set', size: value.size, values: Array.from(value).slice(0, 10).map(function (v) { return String(v); }) };",
    "      }",
    "      if (__seen.indexOf(value) >= 0) return { __kind: 'Circular' };",
    "      if (__seen.length >= 6) return { __kind: 'Deep' };",
    "      __seen.push(value);",
    "      return value;",
    "    };",
    "    let __json;",
    "    try {",
    "      __json = JSON.stringify(__value, __replacer);",
    "    } catch (error) {",
    "      __json = JSON.stringify({ __kind: 'Unserializable', error: String(error) });",
    "    }",
    "    if (typeof __json !== 'string') __json = 'null';",
    `    if (__json.length > ${EVALUATE_MAX_CHARS}) {`,
    `      __json = __json.slice(0, ${EVALUATE_MAX_CHARS}) + '...[truncated]';`,
    "    }",
    "    return { ok: true, value: __json };",
    "  } catch (error) {",
    "    return { ok: false, error: error && error.message ? String(error.message) : String(error) };",
    "  }",
    "})()",
  ].join("\n");
}

/**
 * 定位一个 ref 并做通用校验前的取样：滚进视口、量坐标、判断能不能操作、核对坐标上是谁，
 * 外加**这个 ref 现在指向的元素的签名**（服务侧据此判定 STALE_REF / REF_DRIFT）。
 *
 * 三个都是实测踩出来的坑：
 *
 * 1. **滚动必须用 behavior:'instant'**。站点的 `html { scroll-behavior: smooth }` 会让
 *    `scrollIntoView` 变成动画滚动，而下一行就读 `getBoundingClientRect()` —— 拿到的是
 *    滚动前的坐标，鼠标事件被发到视口外，点击静默落空（工具还报「did not navigate」）。
 *    实测对照：不带 behavior 时 scrollY=0、y=6071（视口只有 420）、elementFromPoint
 *    命中 null；带 instant 时 scrollY=5862、y=210、命中目标元素。这一行是整个修复的关键。
 *
 * 2. **必须用 elementFromPoint 复核**。坐标算得对不代表那个点上就是它：被浮层/固定头部
 *    盖住、被父元素裁剪、`pointer-events:none` 都会让事件落到别处。不核对就只能靠
 *    「点了没反应」这种事后现象去猜。核对结果一并返回（hitOk 与命中的那个元素是谁），
 *    调用方据此重试或给出可读的失败说明。
 *
 * 3. 元素**已经从 DOM 移除**时（`isConnected === false`）提前返回：它没有布局，
 *    滚动与量坐标都没有意义，而「被移除了」是服务侧要判成 STALE_REF 的事实 ——
 *    文案必须说「页面重渲染了，请重新 snapshot」，而不是「坐标算不出来」。
 *
 * `hidden` 用「盒子里没有面积」判定，与快照的可见性口径一致。
 */
export function buildLocateExpression(ref: string): string {
  return [
    "(() => {",
    `  const __ref = ${JSON.stringify(ref)};`,
    ...refRegistryLines(),
    ...metaLines(),
    "  const el = findRef(__ref);",
    "  if (!el) return { ok: false, reason: 'not-found' };",
    "  const signature = signatureOf(el);",
    "  const tag = tagOf(el);",
    "  const inputType = typeOf(el);",
    "  if (el.isConnected !== true) {",
    "    return {",
    "      ok: true,",
    "      connected: false,",
    "      signature: signature,",
    "      x: 0,",
    "      y: 0,",
    "      width: 0,",
    "      height: 0,",
    "      tag: tag,",
    "      role: roleOf(el),",
    "      name: nameOf(el, true),",
    "      inputType: inputType,",
    "      hidden: true,",
    "      disabled: false,",
    "      editable: false,",
    "      select: tag === 'select',",
    "      maxLength: 0,",
    "      hitOk: false,",
    "      hitTag: '',",
    "    };",
    "  }",
    "  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });",
    "  const rect = el.getBoundingClientRect();",
    "  const x = rect.left + rect.width / 2;",
    "  const y = rect.top + rect.height / 2;",
    // 非文本类 input 一律不算「可输入」。这不是洁癖：对它们 insertText 不会生效，而
    // **聚焦那一下是真实点击** —— file 会弹出原生文件选择框、submit 会提交表单、
    // checkbox 会翻转选中态。把这类元素当可输入字段的后果不是「什么都没发生」，
    // 而是「发生了别的事」，而工具最后报的却是「输入没有落进去」。
    "  const NON_TEXT = ['file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color'];",
    "  const style = window.getComputedStyle(el);",
    "  const hidden = style.visibility === 'hidden' || style.display === 'none' || (rect.width <= 0 && rect.height <= 0);",
    "  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';",
    // 复核：这个点上到底是谁。命中自己或自己的后代都算通过（点击事件会冒泡到 el）
    "  let hitTag = '';",
    "  let hitOk = false;",
    "  try {",
    "    const hit = document.elementFromPoint(x, y);",
    "    if (hit) {",
    "      hitTag = tagOf(hit);",
    "      hitOk = hit === el || el.contains(hit) === true;",
    "    }",
    "  } catch (error) { /* 坐标在视口外时 elementFromPoint 返回 null */ }",
    // maxlength 取**属性**而不是 DOM 属性 `.maxLength`：后者在没设上限时返回 524288，
    // 拿它当判据会让「被截断」这条口径永远成立。没有属性就是没有上限（0）。
    "  const maxLengthAttr = el.getAttribute('maxlength');",
    "  const maxLength = maxLengthAttr && /^\\d+$/.test(maxLengthAttr) ? Number(maxLengthAttr) : 0;",
    "  return {",
    "    ok: true,",
    "    connected: true,",
    "    signature: signature,",
    "    x: x,",
    "    y: y,",
    "    width: rect.width,",
    "    height: rect.height,",
    "    tag: tag,",
    "    role: roleOf(el),",
    "    name: nameOf(el, true),",
    "    hidden: hidden,",
    "    disabled: disabled,",
    "    inputType: inputType,",
    "    editable: el.isContentEditable === true || tag === 'textarea' || (tag === 'input' && NON_TEXT.indexOf(inputType) < 0),",
    "    select: tag === 'select',",
    "    maxLength: maxLength,",
    "    hitOk: hitOk,",
    "    hitTag: hitTag,",
    "  };",
    "})()",
  ].join("\n");
}

/**
 * 读回一个字段当前的值，用于**校验输入真的落进去了**。
 *
 * 为什么必须回读：点一下聚焦那一步是真实鼠标事件，偶发会没落到元素上（浮层、动画、
 * 元素刚好重渲染），此时 `insertText` 打到 BODY 上、什么都没发生，而工具若只报
 * 「已输入」模型就会以为填好了、接着去提交。回读是唯一能戳破这种假成功的办法。
 *
 * 元素已被移除时如实返回 `stale`（而不是把残留节点的值读出来）：页面重渲染掉 ref
 * 往往正是这次输入的结果，调用方据此把它当成「读不回来」而不是「值不对」。
 */
export function buildReadValueExpression(ref: string): string {
  return [
    "(() => {",
    `  const __ref = ${JSON.stringify(ref)};`,
    ...refRegistryLines(),
    "  const el = findRef(__ref);",
    "  if (!el) return { ok: false, reason: 'not-found' };",
    "  if (el.isConnected !== true) return { ok: false, reason: 'stale' };",
    "  const tag = el.tagName ? el.tagName.toLowerCase() : '';",
    "  let value = '';",
    "  if (tag === 'input' || tag === 'textarea' || tag === 'select') {",
    "    value = typeof el.value === 'string' ? el.value : '';",
    "  } else if (el.isContentEditable === true) {",
    "    value = (el.innerText || el.textContent || '').trim();",
    "  }",
    "  const active = document.activeElement;",
    "  const focused = active === el || (active !== null && el.contains(active) === true);",
    "  const maxLengthAttr = el.getAttribute('maxlength');",
    "  const maxLength = maxLengthAttr && /^\\d+$/.test(maxLengthAttr) ? Number(maxLengthAttr) : 0;",
    "  return { ok: true, value: value, focused: focused, tag: tag, maxLength: maxLength };",
    "})()",
  ].join("\n");
}

/**
 * 选择下拉框里的一项。
 *
 * 为什么不能靠「点开下拉框 → 再点选项」：原生 `<select>` 展开的是**操作系统级的弹层**，
 * 它不在页面里，没有可点的 DOM 节点 —— 合成鼠标事件只能让它展开，之后就没有下手的地方。
 * 所以这里改走「设 selectedIndex + 派发 input / change」，这也是唯一能让 React / Vue
 * 那类受控组件认账的方式：只改 `el.value` 而不派发事件，框架的 onChange 不会触发，
 * 表单提交上去的还是旧值（工具却会报「已选择」，是典型假成功）。
 *
 * 匹配顺序刻意做成一条回退链（精确 → 去空白 → 忽略大小写 → value 与 label 互换），
 * 因为模型手里通常只有「用户看到的那个名字」，而它可能是 value 也可能是 label。
 * 全都匹配不上时把选项清单一并返回：模型据此一次就能改对，不必先 evaluate 去查。
 */
export function buildSelectExpression(ref: string, match: BrowserOptionMatch): string {
  return [
    "(() => {",
    `  const __ref = ${JSON.stringify(ref)};`,
    `  const __match = ${JSON.stringify(match)};`,
    ...refRegistryLines(),
    "  const el = findRef(__ref);",
    "  if (!el) return { ok: false, reason: 'not-found' };",
    "  if (el.isConnected !== true) return { ok: false, reason: 'stale' };",
    "  const tag = el.tagName ? el.tagName.toLowerCase() : '';",
    // 非 <select>（自定义下拉组件就是一串 div）时如实拒绝：点它才是对的动作，
    // 而「选择」的语义在这里落不到实处，硬设属性只会静默什么都不发生。
    "  if (tag !== 'select') return { ok: false, reason: 'not-select', tag: tag };",
    "  if (el.disabled === true) return { ok: false, reason: 'disabled' };",
    // 多选下拉框的语义是「切换一项」，与本工具的「选定一项」不同：按单选处理会把
    // 用户已经选好的其它项悄悄清掉。宁可如实说不支持，也不做半个动作。
    "  if (el.multiple === true) return { ok: false, reason: 'multiple' };",
    "  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();",
    "  const options = [];",
    "  for (const option of el.options) {",
    "    options.push({ value: String(option.value), label: norm(option.textContent), disabled: option.disabled === true });",
    "  }",
    `  const summary = options.slice(0, ${SELECT_MAX_OPTIONS}).map((option) => {`,
    "    return option.value === option.label ? option.value : option.value + ' = ' + option.label;",
    "  });",
    "  const fail = (reason, extra) => {",
    "    const result = { ok: false, reason: reason, count: options.length, options: summary };",
    "    if (extra) { for (const key in extra) { result[key] = extra[key]; } }",
    "    return result;",
    "  };",
    "  let index = -1;",
    "  if (__match.kind === 'index') {",
    "    index = Number(__match.index) - 1;",
    "    if (!(index >= 0 && index < options.length)) return fail('no-match', { index: __match.index });",
    "  } else {",
    "    const field = __match.kind === 'label' ? 'label' : 'value';",
    "    const other = field === 'value' ? 'label' : 'value';",
    "    const needle = norm(__match[field]);",
    "    index = options.findIndex((option) => option[field] === __match[field]);",
    "    if (index < 0) index = options.findIndex((option) => norm(option[field]) === needle);",
    "    if (index < 0) index = options.findIndex((option) => norm(option[field]).toLowerCase() === needle.toLowerCase());",
    // 互换字段再试一次：模型很可能把可见文字当成 value 传进来（或反过来），
    // 而这两者在这个页面上恰好都能对上同一个选项 —— 没有理由要求它猜对字段名。
    "    if (index < 0) index = options.findIndex((option) => norm(option[other]).toLowerCase() === needle.toLowerCase());",
    "    if (index < 0) return fail('no-match', { needle: needle });",
    "  }",
    "  const chosen = options[index];",
    "  if (chosen.disabled === true) return fail('option-disabled', { index: index + 1, label: chosen.label });",
    "  try { el.focus(); } catch (error) { /* 不可聚焦不影响选中本身 */ }",
    "  el.selectedIndex = index;",
    "  el.dispatchEvent(new Event('input', { bubbles: true }));",
    "  el.dispatchEvent(new Event('change', { bubbles: true }));",
    "  return { ok: true, value: String(el.value), label: chosen.label, index: index + 1, count: options.length };",
    "})()",
  ].join("\n");
}

/**
 * 等一个条件成立（供 browser_wait 反复求值）。
 *
 * 为什么等待要进页面里做而不是在主进程里隔一会儿抓一次快照：抓快照会注入一大段脚本、
 * 遍历整个 DOM 并收集文本（每次几十到几百毫秒），而等待是每秒轮询数次的操作 ——
 * 用快照当探针会把页面拖慢一个数量级，还会因为「快照本身很慢」而错过短暂出现的元素。
 * 这里的探针只做一次 querySelector 或一次文本包含判断。
 *
 * `invalid: true` 是给调用方的**快速失败**信号：选择器写错时继续轮询没有意义，
 * 只会让模型白等满一个超时，然后收到「没等到」这种毫无信息量的结论。
 */
export function buildWaitExpression(
  target: { kind: "text"; text: string } | { kind: "selector"; selector: string },
): string {
  return [
    "(() => {",
    `  const __target = ${JSON.stringify(target)};`,
    "  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();",
    "  if (__target.kind === 'selector') {",
    "    let el = null;",
    "    try { el = document.querySelector(__target.selector); }",
    "    catch (error) {",
    "      return { found: false, invalid: true, detail: 'not a valid CSS selector: ' + String(error && error.message ? error.message : error) };",
    "    }",
    "    if (!el) return { found: false, detail: 'no element matches \"' + __target.selector + '\"' };",
    "    const rect = el.getBoundingClientRect();",
    "    const style = window.getComputedStyle(el);",
    "    const boxed = rect.width > 1 || rect.height > 1;",
    "    const shown = style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';",
    // 等的是「能被看到」，不是「存在于 DOM」：加载占位符常常是一个尺寸为 0 的空 div，
    // 只判断存在会让等待立刻返回，模型接着抓快照却发现页面还是空的。
    "    if (!boxed || !shown) return { found: false, detail: 'the element matching \"' + __target.selector + '\" exists but is not visible' };",
    "    return { found: true, detail: 'the element matching \"' + __target.selector + '\" is visible' };",
    "  }",
    "  const needle = norm(__target.text).toLowerCase();",
    "  if (needle === '') return { found: true, detail: 'no text was given, so there was nothing to wait for' };",
    "  const text = norm(document.body ? document.body.innerText : '');",
    "  if (text.toLowerCase().indexOf(needle) >= 0) {",
    "    return { found: true, detail: 'the page now contains \"' + __target.text + '\"' };",
    "  }",
    // 超时那一刻的当前文本片段：模型据此能分清「页面渲染成别的样子了」与「页面根本没渲染」，
    // 而这两种情况的下一步动作完全不同（前者改等别的文本，后者去看控制台 / 网络）。
    `  const excerpt = text.slice(0, ${WAIT_EXCERPT_CHARS});`,
    "  return {",
    "    found: false,",
    "    detail: 'the page text does not contain \"' + __target.text + '\"' + (excerpt === '' ? ' (the page shows no text at all)' : ' (current text starts with: \"' + excerpt + '\")'),",
    "  };",
    "})()",
  ].join("\n");
}

/**
 * 页面快照脚本：可见文本 + 可交互元素清单。
 *
 * 几个刻意的选择：
 * - **不限定视口**。页面常常比一屏长，只报视口内的元素会逼模型先学会滚动；
 *   点击时反正会 scrollIntoView（见 buildLocateExpression），所以离开视口的元素照样可取。
 * - **ref 由我们发号、存在页面侧的 Map 里**（`__ointRefSeq` / `__ointEls` / `__ointUid`），
 *   同一个节点拿回同一个编号，于是「快照 → 点 → 再快照 → 再点」里没变的那部分编号
 *   不会整体漂移（否则模型手里那个 ref 每隔一步就失效一次，长流程必然点错），
 *   而页面**移除**的元素也不会把编号让给新节点（一个 ref 只对应一个节点、永不复用）。
 * - 每个元素都带上**签名**（role|tag|type|name），动作时服务侧拿它比对：
 *   元素还在但语义变了 = 编号被框架复用到了别的节点上，必须报 REF_DRIFT 而不是照点。
 * - 判定可见用「盒子有尺寸 + 不是 display:none/visibility:hidden/opacity:0」。
 *   只看 offsetParent 会把 position:fixed 的元素误判成不可见。
 * - 返回 `omitted` 与 `viewport`：不说「还有多少没列出来」，模型会以为页面就这么多；
 *   不说视口尺寸，它也不知道自己正处在一个 0×0 的面板里（那时一切坐标动作都会失败）。
 */
export function buildSnapshotExpression(): string {
  return [
    "(() => {",
    `  const MAX_ELEMENTS = ${SNAPSHOT_MAX_ELEMENTS};`,
    `  const MAX_TEXT = ${SNAPSHOT_MAX_TEXT};`,
    `  const OMIT_SCAN_LIMIT = ${SNAPSHOT_OMIT_SCAN_LIMIT};`,
    "  const SELECTOR = [",
    "    'a[href]', 'button', 'input:not([type=\"hidden\"])', 'select', 'textarea',",
    "    '[role=\"button\"]', '[role=\"link\"]', '[role=\"checkbox\"]', '[role=\"radio\"]',",
    "    '[role=\"tab\"]', '[role=\"menuitem\"]', '[role=\"combobox\"]', '[role=\"switch\"]',",
    "    '[contenteditable=\"true\"]', '[contenteditable=\"\"]', '[onclick]', 'summary'",
    "  ].join(',');",
    "",
    "  const visible = (el) => {",
    "    const rect = el.getBoundingClientRect();",
    "    if (rect.width <= 1 && rect.height <= 1) return false;",
    "    const style = window.getComputedStyle(el);",
    "    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';",
    "  };",
    "",
    ...metaLines(),
    ...refRegistryLines(),
    "",
    // 发号函数刻意不叫 refOf：注册表里已经有一个 refOf（沿祖先链找 ref，探针在用），
    // 两者在同一段脚本里同名会让 const 重复声明 —— 整个快照表达式直接变成语法错误。
    "  const allocRef = (el) => {",
    "    const known = __ointUid.get(el);",
    "    if (typeof known === 'string') return known;",
    "    window.__ointRefSeq = (typeof window.__ointRefSeq === 'number' ? window.__ointRefSeq : 0) + 1;",
    "    const ref = 'e' + window.__ointRefSeq;",
    "    __ointUid.set(el, ref);",
    "    __ointRefs.set(ref, el);",
    "    return ref;",
    "  };",
    "",
    "  const elements = [];",
    "  let omittedElements = 0;",
    "  let scanned = 0;",
    // querySelectorAll 用逗号选择器时每个元素只返回一次（按文档顺序），所以不必去重
    "  const nodes = document.querySelectorAll(SELECTOR);",
    "  for (const el of nodes) {",
    "    if (elements.length >= MAX_ELEMENTS) {",
    "      scanned += 1;",
    "      if (scanned > OMIT_SCAN_LIMIT) break;",
    "      if (visible(el)) omittedElements += 1;",
    "      continue;",
    "    }",
    "    if (!visible(el)) continue;",
    "    const tag = tagOf(el);",
    "    const type = typeOf(el);",
    "    const item = { ref: allocRef(el), role: roleOf(el), name: nameOf(el, true), tag: tag, signature: signatureOf(el) };",
    "    if (type && type !== 'text') item.type = type;",
    "    if (typeof el.value === 'string' && el.value !== '' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {",
    "      item.value = part(el.value).slice(0, MAX_NAME);",
    "    }",
    "    if (tag === 'a' && el.href) item.href = String(el.href);",
    "    if (el.disabled === true) item.disabled = true;",
    "    if (typeof el.checked === 'boolean' && (type === 'checkbox' || type === 'radio')) item.checked = el.checked;",
    // 选中态 / 展开态：优先用 ARIA（自定义组件唯一的真实状态），其次用原生属性
    "    const ariaSelected = el.getAttribute('aria-selected');",
    "    if (ariaSelected === 'true' || ariaSelected === 'false') item.selected = ariaSelected === 'true';",
    "    else if (typeof el.selected === 'boolean') item.selected = el.selected;",
    "    const ariaExpanded = el.getAttribute('aria-expanded');",
    "    if (ariaExpanded === 'true' || ariaExpanded === 'false') item.expanded = ariaExpanded === 'true';",
    "    else if (typeof el.open === 'boolean') item.expanded = el.open === true;",
    "    elements.push(item);",
    "  }",
    "",
    // 防泄漏：__ointEls 是强引用，已移除的节点不清掉会把整棵子树留在页面内存里
    //（长命 SPA 上每重渲染一次就多一份）。这一步不做的话，探针与快照本身就会成为性能问题。
    "  for (const entry of Array.from(__ointRefs.entries())) {",
    "    const node = entry[1];",
    "    if (!node || node.isConnected !== true) __ointRefs.delete(entry[0]);",
    "  }",
    "",
    "  let text = document.body ? (document.body.innerText || '') : '';",
    "  text = text.replace(/\\n{3,}/g, '\\n\\n').trim();",
    "  let omittedTextChars = 0;",
    "  if (text.length > MAX_TEXT) {",
    "    omittedTextChars = text.length - MAX_TEXT;",
    "    text = text.slice(0, MAX_TEXT);",
    "  }",
    "",
    "  return {",
    "    url: location.href,",
    "    title: document.title,",
    "    text: text,",
    "    elements: elements,",
    "    truncated: omittedElements > 0 || omittedTextChars > 0,",
    "    omitted: { elements: omittedElements, textChars: omittedTextChars },",
    "    viewport: { width: window.innerWidth, height: window.innerHeight },",
    "  };",
    "})()",
  ].join("\n");
}

/** 探针盯的动作类型：arm 时按它挂监听，判定时按它挑事件 */
export type ProbeKind = "click" | "input" | "key" | "hover";

/**
 * 每种动作要盯的事件。
 *
 * 只盯**与这次动作同类**的事件：全都挂上会让「点击」探针把 mousemove 也算成反应，
 * 于是「鼠标动了但点击没落地」被判成命中 —— 那正是探针要消灭的假成功。
 * `mouseenter` 不冒泡，但捕获阶段照样会经过祖先节点，所以挂在 document 上收得到。
 */
const PROBE_EVENT_TYPES: Record<ProbeKind, readonly string[]> = {
  click: ["mousedown", "mouseup", "click", "auxclick", "pointerdown", "pointerup"],
  input: ["beforeinput", "input", "change", "paste", "compositionend", "keydown", "keyup"],
  key: ["keydown", "keypress", "keyup"],
  hover: ["mouseover", "mouseenter", "pointerover"],
};

/** 探针盯的事件清单（导出给测试：改了清单必须让测试看得见） */
export function probeEventTypes(kind: ProbeKind): readonly string[] {
  return PROBE_EVENT_TYPES[kind];
}

/**
 * 装上「谁收到了事件」的探针（动作**之前**调用），返回 `'armed'`。
 *
 * 为什么需要它：`sendInputEvent` 没有回执。视口没布局、目标被浮层盖住、元素在按下与
 * 抬起之间被重渲染，这三种情况它都同样静默地什么都不做，而工具在旧实现里会报
 * 「已点击（页面没有跳转）」，模型于是原样重试 —— 实测复现的正是这条路径。
 * 捕获阶段记录 `event.target`（并往上找到它属于哪个 ref），读的时候就能分清
 * 「谁都没收到」（NO_EFFECT）与「被别的元素收走了」（WRONG_TARGET）。
 *
 * 探针是**一次性**的：arm 会先拆掉上一轮遗留的监听（否则每次动作都会多挂一组，
 * 事件被记两遍、三遍），read 读走之后也立刻拆掉。
 */
export function buildArmProbeExpression(kind: ProbeKind, ref: string): string {
  return [
    "(() => {",
    `  const __kind = ${JSON.stringify(kind)};`,
    `  const __ref = ${JSON.stringify(ref)};`,
    `  const __types = ${JSON.stringify(PROBE_EVENT_TYPES[kind])};`,
    ...refRegistryLines(),
    "  if (typeof window.__ointProbeTeardown === 'function') {",
    "    try { window.__ointProbeTeardown(); } catch (error) { /* 上一轮已经拆过 */ }",
    "  }",
    "  const __probe = { kind: __kind, ref: __ref, events: [], point: null, armedAt: Date.now() };",
    "  const __handlers = [];",
    "  const __record = (type, event) => {",
    `    if (__probe.events.length >= ${PROBE_MAX_EVENTS}) return;`,
    "    const target = event.target && event.target.nodeType === 1 ? event.target : null;",
    "    __probe.events.push({",
    "      type: type,",
    "      targetRef: refOf(target),",
    "      targetTag: target && target.tagName ? String(target.tagName).toLowerCase() : '',",
    "      targetRole: target ? (target.getAttribute('role') || '') : '',",
    "      trusted: event.isTrusted === true,",
    "      at: Date.now(),",
    "    });",
    "  };",
    "  const __attach = (type, record) => {",
    "    const handler = (event) => {",
    // 坐标只用来在 read 时回答「那个点上现在是谁」——遮挡诊断全靠它
    "      if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {",
    "        __probe.point = { x: event.clientX, y: event.clientY };",
    "      }",
    "      if (record) __record(type, event);",
    "    };",
    // 捕获阶段挂在 document 上：事件还没到目标就能看到，也不受 stopPropagation 影响
    "    document.addEventListener(type, handler, true);",
    "    __handlers.push([type, handler]);",
    "  };",
    "  for (const type of __types) __attach(type, true);",
    // mousemove 只用来定位鼠标，不算「有反应」：真正的反应由上面那组事件判定
    "  __attach('mousemove', false);",
    "  const __teardown = () => {",
    "    for (const entry of __handlers) document.removeEventListener(entry[0], entry[1], true);",
    "    __handlers.length = 0;",
    "    if (window.__ointProbeTeardown === __teardown) window.__ointProbeTeardown = null;",
    "  };",
    "  window.__ointProbeTeardown = __teardown;",
    "  window.__ointProbe = __probe;",
    "  return 'armed';",
    "})()",
  ].join("\n");
}

/**
 * 读走探针记录。
 *
 * 返回 `{ kind, ref, events, elementAtPoint, activeRef, activeTag, viewport }`：
 *   · `events[].targetRef` —— 事件按 ref 归属到哪个元素上（内层 span 会归到它的 ref 祖先）；
 *   · `elementAtPoint`    —— 记录下来的坐标上**现在**是谁，用来判断「被浮层盖住」；
 *   · `activeRef`         —— 读的时刻焦点在哪（press 的焦点校验用）；
 *   · `viewport`          —— 0×0 时这一轮的失败基本都能由它解释。
 * 没装过探针（页面刚导航走 / 注入失败）时返回 `armed: false`，服务侧据此报 `effect: unknown`
 * 而不是硬说成功或失败。
 */
export function buildReadProbeExpression(): string {
  return [
    "(() => {",
    "  const __probe = window.__ointProbe;",
    "  if (!__probe || typeof __probe !== 'object') {",
    "    return { armed: false, kind: null, ref: null, events: [], elementAtPoint: null, activeRef: null, activeTag: null, viewport: null };",
    "  }",
    "  if (typeof window.__ointProbeTeardown === 'function') {",
    "    try { window.__ointProbeTeardown(); } catch (error) { /* 已经拆过 */ }",
    "  }",
    "  window.__ointProbe = null;",
    "  const __uid = window.__ointUid instanceof WeakMap ? window.__ointUid : null;",
    "  const __tagOf = (node) => (node && node.tagName ? String(node.tagName).toLowerCase() : '');",
    "  const __refOf = (node) => {",
    "    if (!__uid) return null;",
    "    let current = node;",
    "    while (current && current.nodeType === 1) {",
    "      const hit = __uid.get(current);",
    "      if (typeof hit === 'string') return hit;",
    "      current = current.parentElement;",
    "    }",
    "    return null;",
    "  };",
    "  let __at = null;",
    "  const __point = __probe.point;",
    "  if (__point) {",
    "    try {",
    "      const hit = document.elementFromPoint(__point.x, __point.y);",
    "      if (hit) {",
    "        __at = {",
    "          tag: __tagOf(hit),",
    "          id: hit.id ? String(hit.id) : '',",
    "          cls: typeof hit.className === 'string' ? hit.className.slice(0, 80) : '',",
    "        };",
    "      }",
    "    } catch (error) { /* 坐标在视口外时 elementFromPoint 返回 null */ }",
    "  }",
    "  const __active = document.activeElement;",
    "  return {",
    "    armed: true,",
    "    kind: __probe.kind,",
    "    ref: __probe.ref,",
    "    events: Array.isArray(__probe.events) ? __probe.events : [],",
    "    elementAtPoint: __at,",
    "    activeRef: __active && __active.nodeType === 1 ? __refOf(__active) : null,",
    "    activeTag: __active && __active.nodeType === 1 ? __tagOf(__active) : null,",
    "    viewport: { width: window.innerWidth, height: window.innerHeight },",
    "  };",
    "})()",
  ].join("\n");
}

/**
 * 读视口尺寸：坐标型动作执行前的守卫。
 *
 * 实测（Electron 探针）：零尺寸视口下 `sendInputEvent` 与 CDP 的
 * `Input.dispatchMouseEvent` 都会**静默打空**，而 JS 通道（snapshot / evaluate / fill）
 * 照常工作 —— 也就是「读得到、点不到」。面板收起时正是这个形态：
 * 工具如果照常派发，就会报「已点击（页面没有跳转）」，而真相是这一次点击从未存在过。
 */
export function buildViewportExpression(): string {
  return "({ w: window.innerWidth, h: window.innerHeight })";
}
