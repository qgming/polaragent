// 按键表达式解析：把 `"Control+A"` / `"ArrowDown"` 这类写法翻译成 Electron 的
// sendInputEvent 参数。**纯函数，不依赖 electron**，所以能在 node 测试里跑。
//
// 为什么值得单独一个文件：这里的错都是「静默不生效」——
//   · 名字写错（"Down" vs "ArrowDown"）时 Electron 不会报错，只是页面没反应；
//   · 可打印字符必须走 `char` 事件，只发 keyDown/keyUp 的话输入框里一个字都不会出现；
//   · 修饰键要用 Accelerator 的小写词汇表（"control" 而不是 "Control"）。
// 这三条在真机上表现为「按了没反应」，只能靠单测钉住。
//
// 词汇表取自 Electron Accelerator 文档：0-9、A-Z、F1-F24，以及下列命名键。
// 不在表里的名字一律返回 null，由调用方给出可读的拒绝理由 —— 猜一个近似键更糟：
// 模型会以为按成功了，而页面按的是另一个键。
/**
 * 修饰键：Electron Accelerator 的小写词汇表。
 *
 * 收窄成联合类型而不是 string[]，是为了让「写错一个修饰键名」在编译期就暴露 ——
 * 运行时错了不会报错，只会让组合键变成另一个键（最难查的那类）。
 */
export type BrowserModifier = "control" | "shift" | "alt" | "meta";

/** 一条待发送的按键 */
export interface BrowserKeyStroke {
  /** Electron keyCode（Accelerator 词汇表里的名字：写 "Down" 而不是 "ArrowDown"） */
  keyCode: string;
  /** 修饰键：小写词汇表（control / shift / alt / meta） */
  modifiers: BrowserModifier[];
  /**
   * 可打印字符。
   *
   * 非空时调用方要**额外**发一个 `{ type: "char" }` 事件：keyDown/keyUp 只表达「按了哪个键」，
   * 真正把文字送进输入框的是 char 事件。漏掉它的症状是「工具报成功、字段仍是空的」。
   */
  char?: string;
  /** 归一后的展示名（"control+a"），用于回给模型确认到底按了什么 */
  label: string;
}

/** 修饰键别名 → Electron 词汇表 */
const MODIFIER_ALIASES: Record<string, BrowserModifier> = {
  ctrl: "control",
  control: "control",
  cmd: "meta",
  command: "meta",
  super: "meta",
  meta: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * 命名键别名 → Electron keyCode。
 *
 * 左侧是**人/模型更可能写的名字**（ArrowDown、Esc、Return），右侧是 Electron 认的。
 * 两套名字都收，是为了不让模型因为一个同义词就卡住 —— 这类失败没有任何信息量。
 */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  capslock: "Capslock",
  numlock: "Numlock",
  scrolllock: "Scrolllock",
  printscreen: "PrintScreen",
};

/** 供错误文案使用的支持键名清单（与上面两张表保持一致，改一处不会漏改另一处） */
export const KEY_SPEC_EXAMPLES = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F5",
  "A",
  "1",
  "Control+A",
  "Shift+Tab",
  "Meta+Enter",
];

/**
 * 解析一次按键。返回 null 表示「这个名字我不认识」，由调用方给出可读理由。
 *
 * `"+"` 作为分隔符：`Control+Shift+A` 拆成三个部分、最后一个是键、前面都是修饰键。
 * 因此**无法表达「加号键本身」**（那是 `Plus`）；这个取舍是刻意的 ——
 * 组合键远比输入加号常见，而后者可以走 browser_type。
 */
export function parseKeySpec(input: string): BrowserKeyStroke | null {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;

  const keyPart = parts[parts.length - 1] ?? "";
  const modifiers: BrowserModifier[] = [];
  for (const raw of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[raw.toLowerCase()];
    // 修饰键写错也要拒：把 "Controll" 当成普通键会让整条按键变成别的意思
    if (modifier === undefined) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }

  const lower = keyPart.toLowerCase();

  // 单字符：字母 / 数字 / 标点。字母必须大写（Accelerator 认 A-Z）。
  //
  // char 只在**真的会产生文字**时才给：按住 control / alt / meta 时真实键盘不产生
  // 任何文本（Ctrl+A 是全选，不是输入 "A"），所以这些组合键绝不能带 char ——
  // 带上它的后果是把「全选之后覆盖输入」变成「先打一个 A 再追加」，
  // 字段里会多出几个莫名其妙的字符，而工具一路报成功。
  //
  // 反过来，**没有任何修饰键**时又必须给：keyDown/keyUp 只表达「按了哪个键」，
  // 真正把文字送进输入框的是 char 事件，漏掉它的症状是「按键成功但字段仍是空的」。
  // shift 是唯一会被折进文本的修饰键（Shift+a 就该输入 "A"）。
  if ([...keyPart].length === 1) {
    const char = keyPart;
    const suppressesText = modifiers.some(
      (modifier) => modifier === "control" || modifier === "alt" || modifier === "meta",
    );
    const shifted = modifiers.includes("shift") && /^[a-z]$/.test(char) ? char.toUpperCase() : char;
    return {
      keyCode: /^[a-z]$/.test(char) ? char.toUpperCase() : char,
      modifiers,
      ...(suppressesText ? {} : { char: shifted }),
      label: describeKey(modifiers, keyPart),
    };
  }

  const named =
    NAMED_KEYS[lower] ?? (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower) ? lower.toUpperCase() : undefined);
  if (named === undefined) return null;

  // 命名键一律不发 char：Enter / Down / Tab / Escape 这些是控制键，补 char 反而会把
  // "\n" 之类的字符塞进输入框（真实键盘不会这么干）。
  //
  // 两个显式例外都在别处处理，不在这里开口子：
  //   · "Space" 想在输入框里打字应该走 browser_type（它按的是整段文本）；
  //   · Enter 需要补 char 才能触发表单的隐式提交 —— 那是 Electron 的发送细节，
  //     留在 service.ts 的 sendKeyStroke 里（见那里的说明）。
  return {
    keyCode: named,
    modifiers,
    label: describeKey(modifiers, named),
  };
}

/** 归一后的展示名："control+shift+a"；回给模型确认按了什么 */
function describeKey(modifiers: BrowserModifier[], key: string): string {
  return [...modifiers, key].join("+").toLowerCase();
}

// ---------------------------------------------------------------------------
// 阶段 2：把同一条 BrowserKeyStroke 翻译成 CDP `Input.dispatchKeyEvent` 的参数
//（docs/browser-automation-refactor.md §9.3）。
//
// 为什么要另起一套：CDP 认的是**浏览器自己的**三件套（`KeyboardEvent.key` /
// `.code` / `windowsVirtualKeyCode`），而 Electron 那边收的只是 Accelerator 名字。
// 三者里任何一个对不上，页面上的表现都是「键按下去了但什么都没发生」——
// 与本文件顶部说的那类静默失效一模一样，所以这张表同样必须靠单测钉住。
//
// 事件类型的选择（Chromium 的口径，与 Puppeteer/Playwright 一致）：
//   · 会产生文本的键 → `keyDown` 且带 `text`：文本由浏览器按 `text` 插入，
//     于是**不再单独发 char 事件**（旧实现要自己拼 char，正是因为 Electron 拆得比协议细）；
//   · 纯控制键（方向键、Delete、以及带 control/alt/meta 的组合键）→ `rawKeyDown`：
//     没有 text 可带，也不会触发编辑行为 —— 这是「Control+A 不该在字段里打出一个 a」
//     在协议层的保证，而不是靠调用方记得别发 char；
//   · 一律补一个 `keyUp`：漏掉它的症状是页面上的 keyup 处理器永不触发（「按住了不松」）。
// ---------------------------------------------------------------------------

/** CDP `Input.dispatchKeyEvent` 的参数子集（`type` 由 toCdpKeyEvent 决定，调用方不覆盖） */
export interface CdpKeyEvent {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  /** 修饰键位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8 */
  modifiers: number;
  /** `KeyboardEvent.key`（"a" / "Enter" / "ArrowDown" / " "） */
  key: string;
  /** `KeyboardEvent.code`（"KeyA" / "Enter" / "ArrowDown" / "Space"） */
  code: string;
  /** 虚拟键码（`KeyboardEvent.keyCode`） */
  windowsVirtualKeyCode: number;
  /** 会被插入的文本；控制键与带 control/alt/meta 的组合键没有它 */
  text?: string;
  unmodifiedText?: string;
}

/** 一次按键要发的两个事件：keyDown（可能带 text）+ keyUp */
export interface CdpKeyEventPair {
  keyDown: CdpKeyEvent;
  keyUp: CdpKeyEvent;
}

/** 修饰键位掩码（CDP Input 的固定口径） */
const CDP_MODIFIER_BITS: Record<BrowserModifier, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
};

/** 一个键在 CDP 里的三件套 + 它自己产生的文本 */
interface CdpKeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  /** 这个字符在真实键盘上必须按住 shift 才打得出来（"!" / "?" / "{"） */
  impliedShift?: boolean;
}

/**
 * 命名键 → CDP 三件套。
 *
 * 左侧是 keys.ts 归一后的 keyCode（Accelerator 词汇表：写 "Down" 而不是 "ArrowDown"），
 * 右侧是协议要的值 —— 两套词汇表在这里**必须**重新对一遍，这是本段存在的主要理由。
 *
 * `text` 只给**确信**的三种：Enter（`\r`，表单的隐式提交就挂在它上面）、
 * Tab（`\t`）、Space（" "）。其余控制键一律不给 text：
 * Backspace / Delete / 方向键的默认行为（删除、移动插入点、滚动）由 keydown 的
 * default action 完成，不经过文本插入 —— 硬塞一个 text 反而会把控制字符打进字段里。
 */
const CDP_NAMED_KEYS: Record<string, CdpKeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  Capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  Numlock: { key: "NumLock", code: "NumLock", keyCode: 144 },
  Scrolllock: { key: "ScrollLock", code: "ScrollLock", keyCode: 145 },
  PrintScreen: { key: "PrintScreen", code: "PrintScreen", keyCode: 44 },
};

/**
 * 标点 → CDP 三件套（US 布局）。
 *
 * keys.ts 认任何单个字符，所以标点也必须能映射：给不出 code 与键码时，页面上
 * `event.code` 会是空的，而快捷键库读的正是 code。
 * `impliedShift` 标记那些**必须按住 shift 才打得出**的字符：模型写 "!" 时不会自己
 * 声明 shift，这里要把 shift 位补上，否则 Chromium 收到的是「没按 shift 的数字 1」。
 */
const CDP_PUNCTUATION_KEYS: Record<string, CdpKeyDefinition> = {
  "`": { key: "`", code: "Backquote", keyCode: 192 },
  "-": { key: "-", code: "Minus", keyCode: 189 },
  "=": { key: "=", code: "Equal", keyCode: 187 },
  "[": { key: "[", code: "BracketLeft", keyCode: 219 },
  "]": { key: "]", code: "BracketRight", keyCode: 221 },
  "\\": { key: "\\", code: "Backslash", keyCode: 220 },
  ";": { key: ";", code: "Semicolon", keyCode: 186 },
  "'": { key: "'", code: "Quote", keyCode: 222 },
  ",": { key: ",", code: "Comma", keyCode: 188 },
  ".": { key: ".", code: "Period", keyCode: 190 },
  "/": { key: "/", code: "Slash", keyCode: 191 },
  "~": { key: "~", code: "Backquote", keyCode: 192, impliedShift: true },
  "!": { key: "!", code: "Digit1", keyCode: 49, impliedShift: true },
  "@": { key: "@", code: "Digit2", keyCode: 50, impliedShift: true },
  "#": { key: "#", code: "Digit3", keyCode: 51, impliedShift: true },
  "$": { key: "$", code: "Digit4", keyCode: 52, impliedShift: true },
  "%": { key: "%", code: "Digit5", keyCode: 53, impliedShift: true },
  "^": { key: "^", code: "Digit6", keyCode: 54, impliedShift: true },
  "&": { key: "&", code: "Digit7", keyCode: 55, impliedShift: true },
  "*": { key: "*", code: "Digit8", keyCode: 56, impliedShift: true },
  "(": { key: "(", code: "Digit9", keyCode: 57, impliedShift: true },
  ")": { key: ")", code: "Digit0", keyCode: 48, impliedShift: true },
  _: { key: "_", code: "Minus", keyCode: 189, impliedShift: true },
  // "+" 走不到这里：parseKeySpec 把它当分隔符（见那里的说明），留着只是补齐布局表
  "+": { key: "+", code: "Equal", keyCode: 187, impliedShift: true },
  "{": { key: "{", code: "BracketLeft", keyCode: 219, impliedShift: true },
  "}": { key: "}", code: "BracketRight", keyCode: 221, impliedShift: true },
  "|": { key: "|", code: "Backslash", keyCode: 220, impliedShift: true },
  ":": { key: ":", code: "Semicolon", keyCode: 186, impliedShift: true },
  '"': { key: '"', code: "Quote", keyCode: 222, impliedShift: true },
  "<": { key: "<", code: "Comma", keyCode: 188, impliedShift: true },
  ">": { key: ">", code: "Period", keyCode: 190, impliedShift: true },
  "?": { key: "?", code: "Slash", keyCode: 191, impliedShift: true },
};

/** 字母 / 数字 / 标点 / F 键 / 命名键 → CDP 三件套；认不出来返回 null（不该发生） */
function cdpKeyDefinition(keyCode: string): CdpKeyDefinition | null {
  if (/^[A-Z]$/.test(keyCode)) {
    return { key: keyCode.toLowerCase(), code: `Key${keyCode}`, keyCode: keyCode.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(keyCode)) {
    return { key: keyCode, code: `Digit${keyCode}`, keyCode: keyCode.charCodeAt(0) };
  }
  const named =
    CDP_NAMED_KEYS[keyCode] ??
    CDP_PUNCTUATION_KEYS[keyCode] ??
    (/^F([1-9]|1[0-9]|2[0-4])$/.test(keyCode)
      ? { key: keyCode, code: keyCode, keyCode: 111 + Number(keyCode.slice(1)) }
      : undefined);
  return named ?? null;
}

/** control / alt / meta 会抑制文本（真实键盘上 Ctrl+A 不产生任何字符） */
function suppressesText(modifiers: readonly BrowserModifier[]): boolean {
  return modifiers.some(
    (modifier) => modifier === "control" || modifier === "alt" || modifier === "meta",
  );
}

/**
 * 把一条按键翻译成 CDP 的 keyDown / keyUp。
 *
 * 返回 null 表示这条按键无法映射（理论上不会：parseKeySpec 只产出它认识的形态）。
 * 调用方应把它当成 INVALID_ARGUMENT，而不是「发一个空的 keyEvent」—— 后者在页面上
 * 表现为一次无声的空按键，最难查。
 */
export function toCdpKeyEvent(stroke: BrowserKeyStroke): CdpKeyEventPair | null {
  const def = cdpKeyDefinition(stroke.keyCode);
  if (def === null) return null;

  let modifiers = 0;
  for (const modifier of stroke.modifiers) modifiers |= CDP_MODIFIER_BITS[modifier];
  if (def.impliedShift === true) modifiers |= CDP_MODIFIER_BITS.shift;
  const shifted = (modifiers & CDP_MODIFIER_BITS.shift) !== 0;

  // key 优先用真正的字符：keys.ts 已经把 shift 折进 char 了（Shift+a → "A"），
  // 直接写回 "A" 才能让页面的 event.key 与它收到的文本一致。
  // 组合键（Ctrl+A）没有 char，此时按 DOM 口径给未 shift 的小写形态 —— 真键盘就是这样。
  const key = stroke.char ?? (shifted && /^[A-Z]$/.test(stroke.keyCode) ? stroke.keyCode : def.key);
  const text = suppressesText(stroke.modifiers) ? undefined : (stroke.char ?? def.text);
  const shared = {
    modifiers,
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
  };

  return {
    keyDown: {
      type: text === undefined ? "rawKeyDown" : "keyDown",
      ...shared,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    },
    keyUp: { type: "keyUp", ...shared },
  };
}
