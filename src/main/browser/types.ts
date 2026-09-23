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
  BrowserTabInfo,
  BrowserWaitResult,
} from "@/shared/contracts/browser";

/** 一次成功点击 / 输入的结果描述（回给模型与 UI 的文案由调用方组装） */
export interface BrowserActionOutcome {
  /** 命中的元素名（快照里的 name），用于让模型确认点对了东西 */
  name: string;
  /** 动作后页面是否发生了导航或加载 */
  navigated: boolean;
  /**
   * 动作是否**真的**落地：
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
 * 那正是 browser_act 里 select 动作想省掉的一步。
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
   * 读它走 browser_logs —— 那条路是低风险的只读工具，
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

/** 视口坐标系里的一个点（CSS 像素，与 getBoundingClientRect 同一套） */
export interface BrowserPoint {
  x: number;
  y: number;
}

/**
 * 坐标点击的参数。
 *
 * 为什么需要「按坐标点」这条路：ref 是**语义定位**（找元素中心、必要时滚动到位、
 * 还能校验落点是不是它），它覆盖不了三种页面 —— canvas / WebGL 画布（整块只有一个
 * 节点，里面的按钮页面自己画）、图片热区与地图、以及页面自己合成的浮层
 * （快照的选择器扫不到）。这些页面里模型唯一的把手就是像素坐标。
 *
 * 代价必须写清：坐标点击**不做落点语义校验**（没有人告诉它「这一点上本该是什么」），
 * 所以它只报「谁收到了事件」；点错地方不会失败，只会点到别的东西上。
 * 因此工具的用法是「先用 ref，ref 不行才用坐标」。
 */
export interface BrowserPointClickOptions {
  /** 按键；缺省左键 */
  button?: "left" | "right" | "middle";
  /** 连击次数：1 = 单击，2 = 双击；缺省 1 */
  clicks?: 1 | 2;
}

/**
 * 一个浏览器标签上的操作集合。
 *
 * 为什么按标签切一刀而不是在 BrowserAutomation 的每个方法上加一个 tabId 参数：
 * 一次工具调用总是要连续做几件事（先定位、再校验、再报效果），把「作用于哪个标签」
 * 在入口处解析一次、之后全部走同一个句柄，就不可能出现「定位用了 A 标签、点击落到 B 标签」
 * 这类跨标签串味的错。句柄由 BrowserAutomation.tab() 给出。
 */
export interface BrowserTabOperations {
  tabId: string;
  /** 标记「模型正在操作这个标签」（面板据此显示提示条）；按计数增减 */
  setAgentActive(active: boolean, note?: string): void;
  /** 后退 / 前进 / 刷新 */
  history(action: "back" | "forward" | "reload"): Promise<BrowserPageState>;
  /** 读页面：可见文本 + 可交互元素清单（element 的 ref 供 act 使用） */
  snapshot(): Promise<BrowserSnapshot>;
  /** 按 ref 点击（含链接跳转、表单提交按钮） */
  click(ref: string): Promise<BrowserActionOutcome>;
  /**
   * 按**视口坐标**点击（不依赖 ref / 快照）。
   *
   * 给 canvas、图片热区、地图、页面自绘浮层用 —— 那些地方快照给不出可点的 ref。
   * 坐标由模型从 snapshot 的 x/y 或截图上量出来；越界或超出视口会被拒（并回报当前视口），
   * 因为那几乎总是「页面已经滚过了」或「照着过期坐标点」。
   */
  clickPoint(
    x: number,
    y: number,
    options?: BrowserPointClickOptions,
  ): Promise<BrowserActionOutcome>;
  /**
   * 按住并拖到另一点（滑块、地图平移、画布绘制、拖放排序）。
   *
   * 走的是真实的 down → move×N → up（少一步拖拽都不成立），落点同样不依赖 ref。
   */
  drag(from: BrowserPoint, to: BrowserPoint): Promise<BrowserActionOutcome>;
  /** 按 ref 输入文本；submit 为 true 时再按一次回车 */
  type(ref: string, text: string, submit: boolean): Promise<BrowserActionOutcome>;
  /** 按键；给了 ref 就先点它一下把焦点放上去。key 支持 "Control+A" 这类组合键 */
  press(key: string, ref?: string): Promise<BrowserPressOutcome>;
  /** 把鼠标移到元素上（触发 hover 菜单、tooltip、下拉展开） */
  hover(ref: string): Promise<BrowserActionOutcome>;
  /** 把鼠标移到**视口坐标**上（不依赖 ref 的悬停，给 canvas 一类的自绘界面用） */
  hoverPoint(x: number, y: number): Promise<BrowserActionOutcome>;
  /** 选择下拉框的一项（按 value / label / index 匹配） */
  select(ref: string, match: BrowserOptionMatch): Promise<BrowserSelectOutcome>;
  /** 在视口中心滚动页面（deltaY > 0 向下）；返回滚动前后的位置以便如实回报 */
  scroll(deltaY: number, deltaX?: number): Promise<BrowserActionOutcome>;
  /** 等文本出现 / 等元素出现 / 等固定时长 */
  wait(options: BrowserWaitOptions): Promise<BrowserWaitResult>;
  /** 截图当前视口 */
  screenshot(): Promise<BrowserScreenshot>;
  /**
   * 取该标签控制台消息（增量读取：返回上次读取之后的新消息）。
   *
   * 与其它读方法一样是 async：guest 不在时它要等面板打开，
   * 而等待只能发生在异步方法里。返回值本身仍是同步就能取到的缓冲内容。
   */
  console(): Promise<BrowserConsoleReport>;
  /**
   * 读该标签的网络记录。
   *
   * 与 console **语义相反**：不做增量清空，每次都给当前窗口内的完整记录。
   * 理由是两者被使用的时机不同 —— 控制台是「边跑边看日志」，重复读会淹没上下文；
   * 网络是「出问题之后回头看刚才发了什么」，而那一刻通常没人知道该从哪一条开始看。
   * 需要「从现在开始量」时用 `clear: true` 显式清空。
   */
  network(query?: BrowserNetworkQuery): Promise<BrowserNetworkReport>;
  /** 改该标签 JS 弹窗（alert / confirm）的处理策略 */
  dialog(policy: BrowserDialogPolicy): Promise<BrowserDialogOutcome>;
  /** 在页面里执行一段 JS（逃生门：快照表达不了的检查） */
  evaluate(code: string): Promise<BrowserEvaluateResult>;
}

/**
 * 内置浏览器的自动化能力（主进程单例）。
 *
 * 实现是**全局单例**而不是按会话的：内置浏览器就是右侧栏那一组标签，
 * 用户只看得见一份。按会话建实例会让「A 会话打开的页面」与「用户眼前看到的页面」
 * 变成两份状态，而模型与用户看的必须是同一份。
 *
 * 多标签的边界：**标签的生命周期属于渲染层**（它创建 <webview>），主进程这边
 * 按渲染层登记的 tabId 记账。工具调用要操作某个标签时先 `tab()` 拿句柄 ——
 * 没有可用标签时报 UNAVAILABLE，提示模型先用 browser_open。
 */
export interface BrowserAutomation {
  /** 当前状态（打开了哪些标签、模型是否正在操作） */
  status(): BrowserStatus;
  /** 当前所有标签（按创建顺序） */
  listTabs(): BrowserTabInfo[];
  /**
   * 打开一个网址。
   *
   * 三种去向：给了 tabId → 在指定标签里导航；newTab=true → 请渲染层新建一个标签再导航；
   * 都没给 → 导航到模型的工作标签（还没有就请渲染层建一个）。
   * 无论哪种，这个标签都会成为模型后续调用的工作标签。
   */
  open(url: string, options?: { tabId?: string; newTab?: boolean }): Promise<BrowserPageState>;
  /**
   * 取某个标签的操作句柄。
   *
   * tabId 缺省 = 模型的工作标签 → 唯一打开的标签 → 用户正在看的标签；
   * 一个标签都没有时抛 UNAVAILABLE（提示先 browser_open）。
   */
  tab(tabId?: string): BrowserTabOperations;
}
