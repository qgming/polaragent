// 浏览器自动化的能力面定义。
//
// 单独放一个**不依赖 electron** 的文件，是为了让工具层可以被测试：
// tools/browser.ts 只依赖这个接口，测试传一个假实现即可；真实的 WebContents
// 操作留在 browser/service.ts（它 import electron，只能在真 Electron 里跑）。

import type {
  BrowserConsoleReport,
  BrowserDialogPolicy,
  BrowserNetworkReport,
  BrowserPageState,
  BrowserSnapshot,
  BrowserStatus,
  BrowserWaitResult,
} from "@/shared/contracts/browser";

/** 一次成功点击 / 输入的结果描述（回给模型与 UI 的文案由调用方组装） */
export interface BrowserActionOutcome {
  /** 命中的元素名（快照里的 name），用于让模型确认点对了东西 */
  name: string;
  /** 动作后页面是否发生了导航或加载 */
  navigated: boolean;
  /**
   * 动作是否**真的**落地（见 docs/browser-automation-refactor.md §4）：
   *   hit —— 事件被目标元素收到，或读回值与输入一致；
   *   no-effect —— 发出去了但页面毫无反应（服务侧此时抛错，正常返回里不该出现）；
   *   unknown —— 页面侧探针不可用（注入失败等），此时不做任何断言。
   */
  effect: "hit" | "no-effect" | "unknown";
  /** 一次性的人可读说明（例如「命中者是 div.overlay，目标可能被遮挡」） */
  detail?: string;
  /** 非致命告警（例如输入被 maxlength 截断） */
  warnings?: string[];
}

/** 一次按键的结果：按键本身也要回报，否则模型无法确认组合键有没有被认出来 */
export interface BrowserPressOutcome extends BrowserActionOutcome {
  /** 归一后的按键名（"control+a"） */
  keys: string;
}

/**
 * 下拉框选项的定位方式。
 *
 * 三种都给，是因为「选中某一项」在页面上的表达方式本来就有三种：
 * value 是给程序看的（"us"）、label 是给人看的（"United States"）、
 * index 用于那些两者都空/重复的列表。只留一种会逼模型先写一段 evaluate 去查 ——
 * 那正是 browser_select 想省掉的一步。
 */
export type BrowserOptionMatch =
  | { kind: "value"; value: string }
  | { kind: "label"; label: string }
  | { kind: "index"; index: number };

/** 选择下拉框的结果：回报**实际**选中了什么，供模型核对有没有选错项 */
export interface BrowserSelectOutcome extends BrowserActionOutcome {
  value: string;
  label: string;
}

/**
 * 等待的目标：text / selector / ms 三者**互斥**（至少给一个）。
 *
 * 为什么必须有 selector 之外的 text 等待：SPA 里「等接口回来之后渲染出的那段文字」
 * 往往没有稳定的选择器（className 是构建哈希），而文本是稳定的。
 * Playwright MCP 的 browser_wait_for 同样以 text 为一等目标。
 */
export interface BrowserWaitOptions {
  /** 等这段文本出现在页面上（大小写不敏感的子串匹配） */
  text?: string;
  /** 等这个 CSS 选择器匹配到可见元素 */
  selector?: string;
  /** 固定等待毫秒数（页面在做没有可观察信号的动画 / 重试时用） */
  ms?: number;
  /** 上限（毫秒）；缺省 5000，服务侧会夹到一个上限内 */
  timeoutMs?: number;
}

/** 读网络记录的选项 */
export interface BrowserNetworkQuery {
  /** true = 只看失败与 4xx/5xx（调试白屏时的第一选择） */
  failuresOnly?: boolean;
  /** true = 读之前清空缓冲，用于「从现在开始量」 */
  clear?: boolean;
}

/** 设置弹窗策略的结果 */
export interface BrowserDialogOutcome {
  policy: BrowserDialogPolicy;
  /**
   * 上次调用本工具之后、被自动处理掉的弹窗数。
   *
   * 刻意不在这里回弹窗内容：内容已经进了控制台缓冲（level=warning），
   * 读它走 browser_console —— 那条路是低风险的只读工具，
   * 不该为了「看一眼刚才弹了什么」就要过一次审批。
   */
  handledSinceLastRead: number;
}

/**
 * 截图结果：PNG 的 base64 与像素尺寸。
 *
 * `warning` 是**非致命**的如实告警：截图拿到了、但内容可疑（例如刚挂载时那张全白的图，
 * 见 cdp.ts 的 looksLikeBlankPng）。不给这个字段的话，模型只能把「纯白」当成页面本来的样子。
 */
export interface BrowserScreenshot {
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  warning?: string;
}

/** 页面内求值结果：成功带值，失败带错误文本 */
export type BrowserEvaluateResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * 内置浏览器的自动化能力。
 *
 * 实现是**全局单例**而不是按会话的：内置浏览器只有一个（右侧面板那一份，共用
 * `persist:oint-browser` 分区），同一时刻也只可能有一个页面。按会话建实例会让
 * 「A 会话打开的页面」与「用户眼前看到的页面」变成两份状态，而用户只看得见一份。
 */
export interface BrowserAutomation {
  /**
   * 标记「模型正在操作页面」（工具调用进行中），面板据此显示提示条。
   *
   * 放进这个接口而不是让工具直接 import service：service 依赖 electron，
   * 而工具层要能在 node 里测试（见本文件顶部说明）。
   */
  setAgentActive(active: boolean, note?: string): void;
  /** 当前状态（面板是否已挂载、页面在哪、模型是否在操作） */
  status(): BrowserStatus;
  /** 导航到 URL（缺 scheme 补 https）；返回导航后的页面状态 */
  open(url: string): Promise<BrowserPageState>;
  /** 后退 / 前进 / 刷新 */
  history(action: "back" | "forward" | "reload"): Promise<BrowserPageState>;
  /** 读页面：可见文本 + 可交互元素清单（element 的 ref 供 click / type 使用） */
  snapshot(): Promise<BrowserSnapshot>;
  /** 按 ref 点击（含链接跳转、表单提交按钮） */
  click(ref: string): Promise<BrowserActionOutcome>;
  /** 按 ref 输入文本；submit 为 true 时再按一次回车 */
  type(ref: string, text: string, submit: boolean): Promise<BrowserActionOutcome>;
  /** 按键；给了 ref 就先点它一下把焦点放上去。key 支持 "Control+A" 这类组合键 */
  press(key: string, ref?: string): Promise<BrowserPressOutcome>;
  /** 把鼠标移到元素上（触发 hover 菜单、tooltip、下拉展开） */
  hover(ref: string): Promise<BrowserActionOutcome>;
  /** 选择下拉框的一项（按 value / label / index 匹配） */
  select(ref: string, match: BrowserOptionMatch): Promise<BrowserSelectOutcome>;
  /** 等文本出现 / 等元素出现 / 等固定时长 */
  wait(options: BrowserWaitOptions): Promise<BrowserWaitResult>;
  /** 截图当前视口 */
  screenshot(): Promise<BrowserScreenshot>;
  /**
   * 取页面控制台消息（增量读取：返回上次读取之后的新消息）。
   *
   * 与其它读方法一样是 async：guest 不在时它要等面板打开（见 §等面板挂载的说明），
   * 而等待只能发生在异步方法里。返回值本身仍是同步就能取到的缓冲内容。
   */
  console(): Promise<BrowserConsoleReport>;
  /**
   * 读网络记录。
   *
   * 与 console **语义相反**：不做增量清空，每次都给当前窗口内的完整记录。
   * 理由是两者被使用的时机不同 —— 控制台是「边跑边看日志」，重复读会淹没上下文；
   * 网络是「出问题之后回头看刚才发了什么」，而那一刻通常没人知道该从哪一条开始看。
   * 需要「从现在开始量」时用 `clear: true` 显式清空。
   */
  network(query?: BrowserNetworkQuery): Promise<BrowserNetworkReport>;
  /** 改 JS 弹窗（alert / confirm / prompt）的处理策略 */
  dialog(policy: BrowserDialogPolicy): Promise<BrowserDialogOutcome>;
  /** 在页面里执行一段 JS（逃生门：快照表达不了的检查） */
  evaluate(code: string): Promise<BrowserEvaluateResult>;
}
