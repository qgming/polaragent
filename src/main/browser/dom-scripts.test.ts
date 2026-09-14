// @vitest-environment jsdom
// 生成的注入脚本在**真 DOM** 上跑一遍。
//
// 为什么值得这么做：script.ts 里那几段代码是唯一「跑在别人家页面里」的 JS，
// 只验证「语法合法、转义正确」是不够的 —— 它能编译、能跑，但什么都不做（或者做错），
// 表现就是「工具报成功、页面没变」。所以这里把生成出来的表达式用 new Function 变成
// 真函数再调用，然后断言 DOM 上的真实状态：
//   · 下拉框选中后 element.value / selectedIndex 真的变了，并且**派发了 change**
//     （不派发的话 React / Vue 受控组件不认账，表单提交的还是旧值）；
//   · 读回值能拿到 input 与 contenteditable 的内容；
//   · 等待脚本等的是「可见」而不是「存在于 DOM」。
//   · ref 由快照发号并存进页面侧注册表（window.__ointEls / __ointUid），夹具用
//     refFor / registerRef 接入；给元素写 data-oint-ref 再 locate 的旧夹具已删除。
//
// jsdom 没有布局引擎，也没有 innerText / isContentEditable：下面按需装了最小桩，
// 每处都写清了「为什么必须装」，避免让测试变成自我安慰。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReadValueExpression,
  buildSelectExpression,
  buildSnapshotExpression,
  buildWaitExpression,
} from "./script";

/** 生成的表达式 → 可调用的函数：这里必须真跑，只解析不执行等于没测 */
function evaluate<T>(expression: string): T {
  const factory = new Function(`return (${expression});`) as () => T;
  return factory();
}

/** 从 fixture 里取元素；取不到就是测试自己的问题，直接抛比断言更清楚 */
function element<T extends Element>(selector: string): T {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`fixture 里没有 ${selector}`);
  return found as T;
}

// 夹具刻意不写 data-oint-ref：新模型里 ref 的权威只在页面侧注册表（快照发号），
// 给元素写属性再指望实现按属性找 —— 那条路径正是这次重构删掉的缺陷。
const SELECT_FIXTURE = `
  <select>
    <option value="us">United States</option>
    <option value="de">Germany</option>
    <option value="">-- none --</option>
  </select>
  <div role="button">不是下拉框</div>
`;

/**
 * jsdom 完全不实现 innerText（`"innerText" in HTMLElement.prototype` 是 false），
 * 而实现里读页面文本用的正是 innerText —— 在真实 Chromium 里那是正确的选择。
 * 不装这个桩的话，「等文本」永远走空文本分支，那几条测试就成了摆设。
 */
function installInnerText(): void {
  if ("innerText" in HTMLElement.prototype) return;
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent;
    },
  });
}

/** jsdom 同样没有 isContentEditable；按浏览器的语义用 contenteditable 属性模拟 */
function installIsContentEditable(): void {
  if ("isContentEditable" in HTMLElement.prototype) return;
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      const attr = this.getAttribute("contenteditable");
      return attr === "" || attr === "true";
    },
  });
}

/**
 * jsdom 没有布局：getBoundingClientRect 恒返回 0 尺寸，
 * 于是实现里的可见性判定会永远说「存在但不可见」。按需给元素一个真实尺寸。
 */
function stubRect(el: Element, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ width, height }) as DOMRect;
}

/**
 * 页面侧 ref 注册表的字段（与 script.ts 注入的代码同一套）：
 * 新模型里 ref 的权威位置是 `window.__ointEls`（Map<ref, Element>）与
 * `window.__ointUid`（WeakMap<Element, ref>），**不再**是 DOM 属性。
 */
interface OintPageGlobals {
  __ointEls?: Map<string, Element>;
  __ointUid?: WeakMap<Element, string>;
  __ointRefSeq?: number;
}

/** window 上那几个字段的带类型视图（注入脚本写的就是它们） */
function pageGlobals(): OintPageGlobals {
  return window as unknown as OintPageGlobals;
}

/**
 * 每个用例都从空的注册表开始：Map / WeakMap 挂在 window 上会跨用例存活，
 * 不重置的话上一个用例的节点会留在里面，「一个 ref 只对应一个节点」的断言就失去意义。
 */
beforeEach(() => {
  const globals = pageGlobals();
  delete globals.__ointEls;
  delete globals.__ointUid;
  delete globals.__ointRefSeq;
});

/**
 * 执行一次快照，把当前 DOM 里可见元素的 ref 分配出来。
 * 新模型里 ref 由快照发号，测试必须走这条路（或下面的 registerRef）；**不能**再给元素写
 * `data-oint-ref` 然后指望实现按属性找 —— 那条路径正是这次重构删掉的缺陷。
 * jsdom 没有布局：先给每个元素一个真实尺寸，否则快照会把它们全判成不可见。
 */
function allocateRefs(): void {
  for (const el of Array.from(document.querySelectorAll("*"))) stubRect(el, 200, 20);
  evaluate(buildSnapshotExpression());
}

/** 从页面侧注册表里反查元素拿到的 ref；没发过号就是 fixture 写错了 */
function refOf(el: Element): string {
  const ref = pageGlobals().__ointUid?.get(el);
  if (typeof ref !== "string") throw new Error("fixture 元素没有被快照发号");
  return ref;
}

/** 分配并取回某个元素的 ref：已发过号的元素不会换号（DOM 稳定时不漂移） */
function refFor(el: Element): string {
  allocateRefs();
  return refOf(el);
}

/** 直接往注册表里放一个 ref：快照只会发 `e<数字>`，而「ref 是 Map 的键」要求任何字符串都精确命中 */
function registerRef(ref: string, el: Element): void {
  const globals = pageGlobals();
  const refs = globals.__ointEls instanceof Map ? globals.__ointEls : new Map<string, Element>();
  const uids =
    globals.__ointUid instanceof WeakMap ? globals.__ointUid : new WeakMap<Element, string>();
  refs.set(ref, el);
  uids.set(el, ref);
  globals.__ointEls = refs;
  globals.__ointUid = uids;
}

/** 下拉框脚本的返回形状（成功 / 失败是并集，字段按需取） */
interface SelectOutcome {
  ok: boolean;
  reason?: string;
  value?: string;
  label?: string;
  index?: number;
  count?: number;
  options?: string[];
  tag?: string;
}

/** 读回值脚本的返回形状 */
interface ReadOutcome {
  ok: boolean;
  reason?: string;
  value?: string;
  focused?: boolean;
  tag?: string;
}

/** 等待脚本的返回形状 */
interface WaitOutcome {
  found: boolean;
  invalid?: boolean;
  detail: string;
}

describe("buildSelectExpression 在真 DOM 上", () => {
  beforeEach(() => {
    document.body.innerHTML = SELECT_FIXTURE;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("按 value 选中：DOM 上的选中状态确实变了", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "us" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("us");
    expect(result.label).toBe("United States");
    expect(result.index).toBe(1);
    expect(result.count).toBe(3);
    // 关键：不只是返回值好看，DOM 上真的选中了那一项
    expect(element<HTMLSelectElement>("select").value).toBe("us");
    expect(element<HTMLSelectElement>("select").selectedIndex).toBe(0);
  });

  it("按 label（用户看到的文字）选中", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "label", label: "Germany" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("de");
    expect(result.label).toBe("Germany");
    expect(element<HTMLSelectElement>("select").value).toBe("de");
  });

  it("label 大小写不敏感：模型写的是用户口头说的那个名字", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "label", label: "united states" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("us");
  });

  it("value 与 label 互换回退：把可见文字当 value 传也能命中", () => {
    // 模型手里往往只有页面上那串文字，没有理由要求它猜对字段名
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "Germany" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("de");
    expect(result.label).toBe("Germany");
  });

  it("按 index 选中（列表里没有可读名字时才用序号）", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(buildSelectExpression(ref, { kind: "index", index: 3 }));

    expect(result.ok).toBe(true);
    expect(result.index).toBe(3);
    expect(result.label).toBe("-- none --");
    expect(element<HTMLSelectElement>("select").selectedIndex).toBe(2);
    // 第三项的 value 是空串（占位项就是这样），如实回报而不是当成失败
    expect(result.value).toBe("");
  });

  it("index 越界 → no-match，且不改动 DOM", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(buildSelectExpression(ref, { kind: "index", index: 9 }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-match");
    expect(result.count).toBe(3);
    expect(element<HTMLSelectElement>("select").selectedIndex).toBe(0);
  });

  it("选中时派发 input / change，事件目标就是那个 select", () => {
    // 只改 el.value 而不派发事件，React / Vue 的 onChange 不会触发，
    // 表单提交上去的还是旧值，而工具已经报了「已选择」—— 典型假成功。
    const seen: Array<{ type: string; value: string }> = [];
    for (const type of ["input", "change"]) {
      element<HTMLSelectElement>("select").addEventListener(type, (event) => {
        seen.push({ type, value: String((event.target as HTMLSelectElement).value) });
      });
    }

    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "de" }),
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      { type: "input", value: "de" },
      { type: "change", value: "de" },
    ]);
  });

  it("非 <select> 元素 → not-select（自定义下拉是一串 div，点它才是对的动作）", () => {
    const ref = refFor(element("div"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "us" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-select");
    expect(result.tag).toBe("div");
  });

  it("ref 不存在 → not-found", () => {
    const result = evaluate<SelectOutcome>(
      buildSelectExpression("e404", { kind: "value", value: "us" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });

  it("<select multiple> → multiple（刻意的拒绝：按单选处理会清掉用户已选的其它项）", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<select multiple><option value="a">A</option><option value="b">B</option></select>`,
    );
    const multi = element<HTMLSelectElement>("select[multiple]");
    let changes = 0;
    multi.addEventListener("change", () => {
      changes += 1;
    });
    const before = multi.selectedIndex;

    const ref = refFor(multi);
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "b" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("multiple");
    // 拒绝就要拒得干净：不留半个动作、也不派发事件
    expect(multi.selectedIndex).toBe(before);
    expect(changes).toBe(0);
  });

  it("被禁用的选项 → option-disabled，且选中状态不变", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<select id="with-disabled">
        <option value="a">A</option>
        <option value="b" disabled>B（不可选）</option>
      </select>`,
    );
    const disabled = element<HTMLSelectElement>("#with-disabled");
    let changes = 0;
    disabled.addEventListener("change", () => {
      changes += 1;
    });

    const ref = refFor(disabled);
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "b" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("option-disabled");
    expect(result.index).toBe(2);
    expect(result.label).toBe("B（不可选）");
    expect(disabled.value).toBe("a");
    expect(changes).toBe(0);
  });

  it("匹配不上时把选项清单回给模型（省掉一次 evaluate 去查）", () => {
    const ref = refFor(element("select"));
    const result = evaluate<SelectOutcome>(
      buildSelectExpression(ref, { kind: "value", value: "zz" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-match");
    expect(result.count).toBe(3);
    expect(result.options?.length).toBe(3);
    expect(result.options).toEqual(expect.arrayContaining(["us = United States", "de = Germany"]));
  });
});

describe("buildReadValueExpression 在真 DOM 上", () => {
  beforeEach(() => {
    installInnerText();
    installIsContentEditable();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("读回 input 的值，并如实报告焦点在哪", () => {
    document.body.innerHTML = `<input />`;
    const input = element<HTMLInputElement>("input");
    const ref = refFor(input);
    input.value = "hello";

    const before = evaluate<ReadOutcome>(buildReadValueExpression(ref));
    expect(before.ok).toBe(true);
    expect(before.value).toBe("hello");
    expect(before.tag).toBe("input");
    // 焦点没落上去时如实说 false —— 这正是「insertText 打到了 BODY 上」的信号
    expect(before.focused).toBe(false);

    input.focus();
    const after = evaluate<ReadOutcome>(buildReadValueExpression(ref));
    expect(after.value).toBe("hello");
    expect(after.focused).toBe(true);
  });

  it("ref 不存在 → not-found（读回值也必须能失败）", () => {
    const result = evaluate<ReadOutcome>(buildReadValueExpression("e404"));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });

  it("读回 contenteditable 的文本（innerText || textContent 的兜底是对的）", () => {
    document.body.innerHTML = `
      <div contenteditable="true">写在这里</div>
      <div contenteditable="true">兜底也能读到</div>
    `;
    const [withText, withoutInnerText] = Array.from(document.querySelectorAll("div"));
    if (!withText || !withoutInnerText) throw new Error("fixture 里缺 contenteditable");
    const withTextRef = refFor(withText);
    const fallbackRef = refFor(withoutInnerText);
    // 第二个显式把 innerText 变成 undefined（模拟 innerText 缺失 —— 本文件顶部的桩就是为它装的）：
    // 没有这层兜底，读回值在那种环境下会静默给出空串，于是「填对了」被判成「没填进去」。
    Object.defineProperty(withoutInnerText, "innerText", {
      value: undefined,
      configurable: true,
    });

    const withInnerText = evaluate<ReadOutcome>(buildReadValueExpression(withTextRef));
    expect(withInnerText.ok).toBe(true);
    expect(withInnerText.tag).toBe("div");
    expect(withInnerText.value).toBe("写在这里");

    const fallback = evaluate<ReadOutcome>(buildReadValueExpression(fallbackRef));
    expect(fallback.value).toBe("兜底也能读到");
  });

  it("不可编辑的普通元素读回空串（字段根本没内容，判定不会算成功）", () => {
    document.body.innerHTML = `<div role="button">只是文字</div>`;
    const ref = refFor(element("div"));

    const result = evaluate<ReadOutcome>(buildReadValueExpression(ref));

    expect(result.ok).toBe(true);
    expect(result.value).toBe("");
  });
});

describe("buildWaitExpression 在真 DOM 上", () => {
  beforeEach(() => {
    installInnerText();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("等文本：命中时 found: true，且大小写不敏感", () => {
    document.body.textContent = "Signed in successfully";

    const hit = evaluate<WaitOutcome>(buildWaitExpression({ kind: "text", text: "signed in" }));
    expect(hit.found).toBe(true);

    // 没给文字就当没事可等（调用方的其它等待形式已处理完）
    const empty = evaluate<WaitOutcome>(buildWaitExpression({ kind: "text", text: "" }));
    expect(empty.found).toBe(true);
  });

  it("等文本：不命中时 detail 里带上当前文本片段（模型据此判断渲染到哪一步）", () => {
    document.body.textContent = "正在加载，请稍候…";

    const result = evaluate<WaitOutcome>(buildWaitExpression({ kind: "text", text: "登录成功" }));

    expect(result.found).toBe(false);
    // 没有这段片段，模型只知道「没等到」，分不清「页面渲染成别的样子」与「页面根本没渲染」
    expect(result.detail).toContain("正在加载，请稍候");
    expect(result.detail).toContain("登录成功");
  });

  it("等文本：页面一个字都没有时如实说明（不要给一段空引号）", () => {
    document.body.textContent = "";

    const result = evaluate<WaitOutcome>(buildWaitExpression({ kind: "text", text: "登录成功" }));

    expect(result.found).toBe(false);
    expect(result.detail).toContain("no text at all");
  });

  it("等选择器：等的是「可见」而不是「存在于 DOM」", () => {
    document.body.innerHTML = `<div class="result">结果</div>`;
    const target = element(".result");

    // 有尺寸 = 看得见
    stubRect(target, 200, 40);
    const visible = evaluate<WaitOutcome>(
      buildWaitExpression({ kind: "selector", selector: ".result" }),
    );
    expect(visible.found).toBe(true);

    // 尺寸为 0 的加载占位符：存在于 DOM 但什么都不显示 —— 立刻返回会让模型
    // 接着抓快照，结果页面还是空的
    stubRect(target, 0, 0);
    const hidden = evaluate<WaitOutcome>(
      buildWaitExpression({ kind: "selector", selector: ".result" }),
    );
    expect(hidden.found).toBe(false);
    expect(hidden.detail).toContain("not visible");
  });

  it("等选择器：合法但没匹配到 → found: false 且说明没有元素", () => {
    const result = evaluate<WaitOutcome>(
      buildWaitExpression({ kind: "selector", selector: ".never-appears" }),
    );

    expect(result.found).toBe(false);
    expect(result.invalid).toBeUndefined();
    expect(result.detail).toContain("no element matches");
  });

  it("非法选择器 → invalid: true（给调用方快速失败的信号，不要白等满超时）", () => {
    const result = evaluate<WaitOutcome>(
      buildWaitExpression({ kind: "selector", selector: "div>>>" }),
    );

    expect(result.found).toBe(false);
    expect(result.invalid).toBe(true);
  });
});

describe("按 ref 找元素：ref 是页面侧注册表的键，不拼进选择器", () => {
  it("页面自己写的 data-oint-ref 不会被当成 ref（属性可以被页面抢占，权威只在注册表里）", () => {
    document.body.innerHTML = `
      <select data-oint-ref="e1"><option value="wrong">W</option><option value="right">R</option></select>
    `;
    const select = element<HTMLSelectElement>("select");

    // 注册表里没有 e1（ref 只能由快照发号）—— 按 DOM 属性找元素的旧路径已经删掉；
    // 如果它被加回来，这里会「成功」把 select 选成 right，这条断言就是回归哨兵。
    const result = evaluate<SelectOutcome>(
      buildSelectExpression("e1", { kind: "value", value: "right" }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
    expect(select.value).toBe("wrong"); // 页面元素没被碰过
  });

  it("ref 作为 Map 的键被精确匹配：含引号的字符串不会变成选择器、也不会命中别的元素", () => {
    // 旧实现把 ref 拼进 `[data-oint-ref="…"]`，含引号的 ref 会变成**选择器列表**，
    // querySelector 返回文档里第一个匹配者 —— 点击与输入落到快照描述之外的另一个元素上。
    // 新模型里 ref 只作 Map 的键，任何字符串都不会逃逸成选择器。
    const tricky = 'x"],[data-oint-ref="decoy';
    document.body.innerHTML = `
      <select id="decoy"><option value="wrong">不该被选中</option></select>
      <select id="target"><option value="right">该被选中</option></select>
    `;
    const decoy = element<HTMLSelectElement>("#decoy");
    registerRef(tricky, element("#target"));

    const result = evaluate<SelectOutcome>(
      buildSelectExpression(tricky, { kind: "value", value: "right" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("right");
    // 诱饵没有被碰过，这才是「精确命中」的证据
    expect(decoy.value).toBe("wrong");
  });

  it("含反斜杠与引号的 ref 也能被精确匹配", () => {
    const weird = 'e1\\"quoted"';
    document.body.innerHTML = `<input id="field" value="ok">`;
    registerRef(weird, element("#field"));

    const result = evaluate<ReadOutcome>(buildReadValueExpression(weird));

    expect(result.ok).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("找不到的 ref 仍然如实返回 not-found", () => {
    document.body.innerHTML = `<input value="ok">`;

    const result = evaluate<ReadOutcome>(buildReadValueExpression("e404"));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });
});

/**
 * ref 模型 v2 的关键不变式（docs/browser-automation-refactor.md §3）：一个 ref 只对应一个
 * 元素节点、永不复用。这里在真 DOM 上跑页面侧的注册表，把三条不变式钉住：
 *   · DOM 稳定时编号不漂移（长流程里模型手里的 ref 不会隔一步失效一次）；
 *   · 元素被移除后编号不会被新节点继承（否则就是静默错点）；
 *   · 元素被移除后 ref 明确失效（stale / not-found），绝不把残留节点的值读出来。
 */
describe("ref 模型 v2：页面侧发号的不变式", () => {
  it("DOM 稳定时 ref 不漂移：连续两次快照拿到同一批编号", () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
    const a = element("#a");
    const b = element("#b");
    const aRef = refFor(a);
    const bRef = refFor(b);

    allocateRefs();

    expect(refOf(a)).toBe(aRef);
    expect(refOf(b)).toBe(bRef);
  });

  it("新元素不会拿到旧 ref：被移除元素的编号不复用，新节点只能拿新号", () => {
    document.body.innerHTML = `<button id="a">A</button>`;
    const a = element("#a");
    const aRef = refFor(a);

    a.remove();
    allocateRefs(); // 快照顺带清理已移除节点的强引用（注册表防泄漏）
    document.body.insertAdjacentHTML("beforeend", `<button id="c">C</button>`);
    const cRef = refFor(element("#c"));

    expect(cRef).not.toBe(aRef);
    // 旧编号也不能再指回任何节点：它已经随元素一起失效
    const read = evaluate<ReadOutcome>(buildReadValueExpression(aRef));
    expect(read.ok).toBe(false);
    expect(read.reason).toBe("not-found");
  });

  it("元素被移除但还没被快照清理时：读回值返回 stale，而不是把残留节点的值读出来", () => {
    document.body.innerHTML = `<input id="field" />`;
    const field = element<HTMLInputElement>("#field");
    field.value = "旧值";
    const ref = refFor(field);

    field.remove();
    const result = evaluate<ReadOutcome>(buildReadValueExpression(ref));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale");
  });

  it("快照会清掉已移除元素的强引用（Map 防泄漏），清理后该 ref 变成 not-found", () => {
    document.body.innerHTML = `<button id="a">A</button>`;
    const a = element("#a");
    const aRef = refFor(a);

    a.remove();
    allocateRefs();

    expect(pageGlobals().__ointEls?.has(aRef)).toBe(false);
    const read = evaluate<ReadOutcome>(buildReadValueExpression(aRef));
    expect(read.ok).toBe(false);
    expect(read.reason).toBe("not-found");
  });
});
