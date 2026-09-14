// 按键解析（parseKeySpec）的单测。
//
// 为什么值得单独测：这段逻辑的错全是**静默失效** —— 不抛异常、不留日志，
// 在真机上只表现为「按了没反应」：
//   · 人和模型都会写 "ArrowDown"，而 Electron 只认 "Down"（Accelerator 词汇表）。
//     别名表少一格，按键就石沉大海；
//   · 可打印字符必须带 char：调用方据此**额外**发一个 char 事件。少了它输入框里
//     一个字都不会出现，而工具已经报了成功（这是「按键成功但什么都没输入」的根因）；
//   · 认不出来的名字一律返回 null、由调用方给出可读理由：猜一个近似键更糟 ——
//     模型以为按成功了，页面按的却是另一个键。
// 下面每条断言都对着 keys.ts 里的一个具体决定，改坏任何一格都会变红。

import { describe, expect, it } from "vitest";
import {
  type BrowserKeyStroke,
  type CdpKeyEventPair,
  KEY_SPEC_EXAMPLES,
  parseKeySpec,
  toCdpKeyEvent,
} from "./keys";

/** 命名键表：左侧是人和模型更可能写的名字，右侧是 Electron 认的 */
const NAMED_KEY_CASES: ReadonlyArray<readonly [input: string, keyCode: string]> = [
  ["ArrowDown", "Down"],
  ["ArrowUp", "Up"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["Esc", "Escape"],
  ["Escape", "Escape"],
  ["Return", "Enter"],
  ["Enter", "Enter"],
  ["Tab", "Tab"],
  ["Space", "Space"],
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
];

/**
 * 一律必须被拒的输入。
 * 这些名字要么拼错、要么超出词汇表：返回一个「近似的键」会让模型彻底走错方向，
 * 所以逐条都要 toBeNull()。
 */
const REJECTED: readonly string[] = [
  // 修饰键拼错：当成普通键发出去，整条按键就变成别的意思
  "Controll+A",
  // 不认识的键名
  "Frobnicate",
  // 两位数既不是单字符也不是 F 键
  "25",
  // 空输入 / 只有分隔符
  "",
  "+",
  // 只给了修饰键，没有真正的键
  "Control+",
];

describe("parseKeySpec", () => {
  it.each(NAMED_KEY_CASES)(
    "命名键 %s 归一成 Electron 的 %s（别名表删一格就红）",
    (input, keyCode) => {
      const stroke = parseKeySpec(input);
      expect(stroke?.keyCode).toBe(keyCode);
      expect(stroke?.modifiers).toEqual([]);
    },
  );

  it("命名键一律不发 char —— 补 char 会把换行之类的字符塞进输入框", () => {
    for (const [input] of NAMED_KEY_CASES) {
      expect(parseKeySpec(input)?.char, `${input} 不该带 char`).toBeUndefined();
    }
    // Enter 是最典型的一条：带上 char 就会往字段里插一个换行，真键盘不会
    expect(parseKeySpec("Enter")?.char).toBeUndefined();
  });

  it("单字符必须带 char（少了它输入框里不会出现文字）", () => {
    const lower = parseKeySpec("a");
    expect(lower?.keyCode).toBe("A");
    expect(lower?.char).toBe("a");
    expect(lower?.modifiers).toEqual([]);

    const digit = parseKeySpec("1");
    expect(digit?.keyCode).toBe("1");
    expect(digit?.char).toBe("1");

    // 大写输入照模型写的保留（不要擅自改成小写）
    const upper = parseKeySpec("A");
    expect(upper?.keyCode).toBe("A");
    expect(upper?.char).toBe("A");
  });

  it("组合键：修饰键走 Accelerator 的小写词汇表，且不重复", () => {
    const control = parseKeySpec("Control+A");
    expect(control?.modifiers).toEqual(["control"]);
    expect(control?.keyCode).toBe("A");
    // control / alt / meta 会**抑制文本**：真实键盘上 Ctrl+A 是全选，不产生任何字符。
    // 这里若给出 char，调用方就会多按出一个字母 —— 于是「全选后覆盖输入」变成
    // 「先打一个 A 再追加」，字段里凭空多出字符而工具一路报成功。
    expect(control?.char).toBeUndefined();
    expect(parseKeySpec("Alt+a")?.char).toBeUndefined();
    // Ctrl 是同一个修饰键的常见写法，结果必须完全一致
    expect(parseKeySpec("Ctrl+A")).toEqual(control);

    for (const input of ["Cmd+Enter", "Command+Enter", "Meta+Enter"]) {
      const meta = parseKeySpec(input);
      expect(meta?.modifiers, input).toEqual(["meta"]);
      expect(meta?.keyCode, input).toBe("Enter");
      expect(meta?.char, input).toBeUndefined();
    }

    // Shift+字母：char 大写化（真键盘上 shift 决定的就是这个）
    const shifted = parseKeySpec("Shift+a");
    expect(shifted?.modifiers).toEqual(["shift"]);
    expect(shifted?.keyCode).toBe("A");
    expect(shifted?.char).toBe("A");

    // 多个修饰键：既不丢，也不因为写重复而重复
    const both = parseKeySpec("Control+Shift+A");
    expect(both?.modifiers).toEqual(["control", "shift"]);
    expect(both?.keyCode).toBe("A");
    expect(parseKeySpec("Control+Control+A")?.modifiers).toEqual(["control"]);
  });

  it("F 键按 F1-F24 归一，超出词汇表必须拒", () => {
    expect(parseKeySpec("F5")?.keyCode).toBe("F5");
    expect(parseKeySpec("f12")?.keyCode).toBe("F12");
    expect(parseKeySpec("F1")?.keyCode).toBe("F1");
    expect(parseKeySpec("F24")?.keyCode).toBe("F24");
    // F 键是控制键，同样不发 char
    expect(parseKeySpec("F5")?.char).toBeUndefined();
    // 0 与 25 都不在 Accelerator 词汇表里
    expect(parseKeySpec("F0")).toBeNull();
    expect(parseKeySpec("F25")).toBeNull();
  });

  it.each(REJECTED)("拒绝 %j：返回 null 而不是猜一个近似的键", (input) => {
    expect(parseKeySpec(input)).toBeNull();
  });

  it("label 是归一后的展示名，用来向模型确认到底按了什么", () => {
    expect(parseKeySpec("Control+A")?.label).toBe("control+a");
    expect(parseKeySpec("Shift+Tab")?.label).toBe("shift+tab");
    expect(parseKeySpec("Meta+Enter")?.label).toBe("meta+enter");
    // 命名键用 Electron 归一后的名字（模型看到的与真正按下去的是同一个词）
    expect(parseKeySpec("ArrowDown")?.label).toBe("down");
    expect(parseKeySpec("Esc")?.label).toBe("escape");
    // 单字符形态统一小写，便于比对
    expect(parseKeySpec("A")?.label).toBe("a");
  });

  it("KEY_SPEC_EXAMPLES 里每个例子都能解析 —— 文案与解析表脱节就是骗模型", () => {
    // 这份清单出现在报错提示里。改了实现没改文案（或反过来）时，模型照着「支持的键名」
    // 写一遍还是被拒 —— 那种失败没有任何信息量，这条断言就是拦它的。
    expect(KEY_SPEC_EXAMPLES.length).toBeGreaterThan(0);
    for (const example of KEY_SPEC_EXAMPLES) {
      expect(parseKeySpec(example), `KEY_SPEC_EXAMPLES 里的 ${example} 解析不了`).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 阶段 2：CDP 按键映射（toCdpKeyEvent）。
//
// 与上面那份 Electron 映射一样，错了都是**静默失效**：键按下去了，页面却没反应，
// 或者更糟 —— 「Control+A」变成了「打一个 a」。CDP 比 Electron 多两个必须对的字段
//（`KeyboardEvent.key` / `.code`），任何一个给错，读 `event.code` 的快捷键库就直接不认。
//
// 下面按「键的种类」分组钉住：命名键、字母、数字、组合键的修饰键位、以及 text 的有无。
// ---------------------------------------------------------------------------

/** 从一条按键规格解析 + 翻译；解析不出来时直接失败，免得后面报一堆 undefined 的错 */
function cdp(spec: string) {
  const stroke = parseKeySpec(spec);
  expect(stroke, `parseKeySpec(${spec}) 应该解析得出来`).not.toBeNull();
  const events = toCdpKeyEvent(stroke as BrowserKeyStroke);
  expect(events, `toCdpKeyEvent(${spec}) 应该映射得出来`).not.toBeNull();
  return events as CdpKeyEventPair;
}

describe("toCdpKeyEvent", () => {
  /**
   * 命名键的三件套。
   *
   * 左边是模型的写法，中间是 `KeyboardEvent.key`、右边是 `.code` —— key 是「哪个字符」，
   * code 是「键盘上哪个物理键」，两者在方向上正好相反（ArrowUp vs 上箭头）。
   */
  const NAMED: ReadonlyArray<readonly [spec: string, key: string, code: string]> = [
    ["Enter", "Enter", "Enter"],
    ["Tab", "Tab", "Tab"],
    ["Escape", "Escape", "Escape"],
    ["Space", " ", "Space"],
    ["Backspace", "Backspace", "Backspace"],
    ["Delete", "Delete", "Delete"],
    ["ArrowUp", "ArrowUp", "ArrowUp"],
    ["ArrowDown", "ArrowDown", "ArrowDown"],
    ["ArrowLeft", "ArrowLeft", "ArrowLeft"],
    ["ArrowRight", "ArrowRight", "ArrowRight"],
    ["Home", "Home", "Home"],
    ["End", "End", "End"],
    ["PageUp", "PageUp", "PageUp"],
    ["PageDown", "PageDown", "PageDown"],
    ["F5", "F5", "F5"],
  ];

  it.each(NAMED)("%s → key=%j code=%s（协议要的是浏览器自己的词汇表）", (spec, key, code) => {
    const { keyDown, keyUp } = cdp(spec);
    expect(keyDown.key).toBe(key);
    expect(keyDown.code).toBe(code);
    expect(keyDown.modifiers).toBe(0);
    // keyUp 必须存在且不带 text：漏掉它的症状是页面的 keyup 处理器永不触发
    expect(keyUp.type).toBe("keyUp");
    expect(keyUp.key).toBe(key);
    expect(keyUp.text).toBeUndefined();
  });

  it("方向键的 code 是 ArrowUp 而不是 Up（keys.ts 里的 Up 是 Electron 的名字）", () => {
    expect(cdp("ArrowDown").keyDown.code).toBe("ArrowDown");
    expect(cdp("ArrowDown").keyDown.windowsVirtualKeyCode).toBe(40);
    expect(cdp("Enter").keyDown.windowsVirtualKeyCode).toBe(13);
    expect(cdp("Escape").keyDown.windowsVirtualKeyCode).toBe(27);
  });

  it("字母：key 是字符、code 是 KeyX、键码是 ASCII 大写（三者缺一都点不动）", () => {
    const lower = cdp("a");
    expect(lower.keyDown.key).toBe("a");
    expect(lower.keyDown.code).toBe("KeyA");
    expect(lower.keyDown.windowsVirtualKeyCode).toBe(65);
    // 会产生文本的键走 keyDown + text：Chromium 按 text 插入字符，不再单独发 char
    expect(lower.keyDown.type).toBe("keyDown");
    expect(lower.keyDown.text).toBe("a");

    const upper = cdp("A");
    expect(upper.keyDown.key).toBe("A");
    expect(upper.keyDown.text).toBe("A");

    const shifted = cdp("Shift+a");
    expect(shifted.keyDown.modifiers).toBe(8);
    expect(shifted.keyDown.key).toBe("A");
    expect(shifted.keyDown.text).toBe("A");
  });

  it("数字：code 是 DigitN，且窗口虚拟键码就是它的 ASCII", () => {
    const one = cdp("1");
    expect(one.keyDown.key).toBe("1");
    expect(one.keyDown.code).toBe("Digit1");
    expect(one.keyDown.windowsVirtualKeyCode).toBe(49);
    expect(one.keyDown.text).toBe("1");

    expect(cdp("0").keyDown.code).toBe("Digit0");
  });

  it("组合键：修饰键位（Alt=1/Ctrl=2/Meta=4/Shift=8）与「不发文本」两条都要对", () => {
    const control = cdp("Control+A");
    expect(control.keyDown.modifiers).toBe(2);
    expect(control.keyDown.code).toBe("KeyA");
    expect(control.keyDown.windowsVirtualKeyCode).toBe(65);
    // 关键的一条：Ctrl+A 不该插入任何字符（真键盘上是全选）——
    // 现在的保证在协议层：没有 text 就只能走 rawKeyDown，Chromium 不会插入文本
    expect(control.keyDown.type).toBe("rawKeyDown");
    expect(control.keyDown.text).toBeUndefined();
    expect(control.keyDown.key).toBe("a");

    expect(cdp("Alt+A").keyDown.modifiers).toBe(1);
    expect(cdp("Meta+Enter").keyDown.modifiers).toBe(4);
    // Meta+Enter 同样不发文本：真实键盘上 Command+Enter 不产生任何字符
    expect(cdp("Meta+Enter").keyDown.text).toBeUndefined();
    expect(cdp("Meta+Enter").keyDown.type).toBe("rawKeyDown");
    // 多个修饰键按位或；重复声明不重复计
    expect(cdp("Control+Shift+A").keyDown.modifiers).toBe(10);
    expect(cdp("Control+Control+A").keyDown.modifiers).toBe(2);
  });

  it("会产生文本的键只有三种控制键：Enter(\\r) / Tab(\\t) / Space(空格)", () => {
    // Enter 的 text 是表单隐式提交所依赖的那一个 keypress（旧实现要手动补 char 事件）
    expect(cdp("Enter").keyDown.text).toBe("\r");
    expect(cdp("Enter").keyDown.type).toBe("keyDown");
    expect(cdp("Tab").keyDown.text).toBe("\t");
    expect(cdp("Space").keyDown.text).toBe(" ");
    // 其余控制键不带 text：它们的默认行为（删除、移动插入点）由 keydown 的 default action 完成
    for (const spec of ["Backspace", "Delete", "ArrowUp", "Home", "End", "Escape", "F5"]) {
      expect(cdp(spec).keyDown.text, spec).toBeUndefined();
      expect(cdp(spec).keyDown.type, spec).toBe("rawKeyDown");
    }
  });

  it("标点也能映射出 code（快捷键库读的是 code，给空就会静默失效）", () => {
    const slash = cdp("/");
    expect(slash.keyDown.code).toBe("Slash");
    expect(slash.keyDown.windowsVirtualKeyCode).toBe(191);
    expect(slash.keyDown.text).toBe("/");

    // "!" 在真实键盘上必须按住 shift：模型不会自己声明 shift，映射要把这一位补上
    const bang = cdp("!");
    expect(bang.keyDown.modifiers).toBe(8);
    expect(bang.keyDown.code).toBe("Digit1");
    expect(bang.keyDown.text).toBe("!");
  });

  it("认不出来的键返回 null（宁可失败，也不要发一次无声的空按键）", () => {
    expect(
      toCdpKeyEvent({ keyCode: "Frobnicate", modifiers: [], char: "x", label: "frobnicate" }),
    ).toBeNull();
  });
});
