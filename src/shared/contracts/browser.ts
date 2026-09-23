// 内置浏览器（右侧面板的 <webview>）的共享契约。
//
// **事实来源在主进程**：guest 的 WebContents 由 main/app/window.ts 的 did-attach-webview
// 事件拿到，之后所有自动化（导航 / 读页面 / 点击 / 输入 / 截图 / 控制台日志）都在主进程
// 对那份 WebContents 完成。渲染层的面板只负责两件事：
//   1. 把 <webview> 元素创建出来 —— 没有元素就没有 guest，这是自动化能存在的前提；
//   2. 订阅事件，把「模型正在操作页面」显示给人看，并让地址栏跟上模型的导航。
//
// 这么分层是为了**不新增渲染层 → 主进程的自动化通道**：如果让模型经渲染层调
// webview.executeJavaScript，就得在 IPC 上开一个「任意页面代码执行」的入口，
// 而主进程本来就已经安全地持有 guest，没有必要把这份能力再暴露一次。

/** 当前页面的状态快照；空串 url 表示还没有打开任何页面 */
export interface BrowserPageState {
  /** 主框架当前 URL；about:blank 归一为空串 */
  url: string;
  title: string;
  /** 主框架是否还在加载 */
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 最近一次主框架加载失败的原因；成功导航后清空 */
  error?: string;
}

/**
 * 页面上的一个可交互元素。
 *
 * `ref`（"e12"）是模型点击 / 输入的把手：**只在最近一次 snapshot 里有效**。
 * 为让「快照 → 点击 → 再快照」这条最常见的循环稳定，元素上已有的 data-oint-ref
 * 会被复用，DOM 没变的部分编号就不会漂移；但页面重新渲染后不要沿用旧编号。
 */
export interface BrowserElement {
  /** 形如 "e12"；仅在最新一次 snapshot 内有效 */
  ref: string;
  /** 语义角色：button / link / textbox / checkbox / combobox / tab … */
  role: string;
  /** 人可读的名字：aria-label、可见文本、placeholder、当前值，取第一个非空 */
  name: string;
  /** 标签名（小写） */
  tag: string;
  /** input 的 type（button / checkbox / radio / …） */
  type?: string;
  /** 输入框或下拉框的当前值 */
  value?: string;
  /** 链接目标（相对地址已解析为绝对地址） */
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  /** 下拉框/选项的选中态（快照来自 AX 树时为浏览器真实状态） */
  selected?: boolean;
  /** aria-expanded 或展开态（下拉、菜单、折叠面板） */
  expanded?: boolean;
  /** 该元素首次出现的快照代次；越小说明这个 ref 越老 */
  since?: number;
  /**
   * 元素中心在**视口坐标系**里的位置（快照那一刻的 `getBoundingClientRect` 中心，四舍五入）。
   *
   * 存在的理由：**坐标点击**。canvas、图片热区、地图、可视化图表这些元素在快照里
   * 只有一个 ref 甚至没有 ref，模型只能给出像素坐标；而它无法凭空知道坐标 ——
   * 让它可以量、可以点，是这一类页面唯一的自动化通路。
   *
   * 两个必须知道的限制（工具描述里也写着）：
   *   · **只对快照那一刻成立**：页面滚动或被重排后这些数字就过期了；
   *   · 视口外的元素照样给出坐标（快照不限视口），那些值可能是负数或大于视口尺寸 ——
   *     ref 动作会自己 scrollIntoView，坐标动作不会，所以点之前得先滚到看得见。
   */
  x?: number;
  y?: number;
}

/** 一次页面快照：可见文本 + 可交互元素清单 */
export interface BrowserSnapshot {
  url: string;
  title: string;
  /** 快照代次：每次 snapshot 自增；元素上的 since 说明它属于哪一代 */
  generation: number;
  /** 视口内可见文本，按块换行；过长时截断（truncated 为 true） */
  text: string;
  elements: BrowserElement[];
  /** 文本或元素清单被截断时为 true */
  truncated: boolean;
  /** 因上限被省略的数量：不给出会让模型以为「页面就这么多」 */
  omitted?: { elements: number; textChars: number };
  /** 快照时刻的视口尺寸；0×0 表示面板未布局，坐标动作会失败 */
  viewport?: { width: number; height: number };
}

/** 页面控制台的一条消息（含未捕获错误） */
export interface BrowserConsoleEntry {
  level: "debug" | "info" | "warning" | "error";
  text: string;
  /** 消息来源 URL（脚本 / 页面） */
  source: string;
  line: number;
  at: number;
}

/**
 * 浏览器工具的失败分类。
 * 工具层把 code 一起回给模型，让它能据此决策：重快照 / 重试 / 换目标。
 */
export type BrowserErrorCode =
  | "UNKNOWN_REF"
  | "STALE_REF"
  | "REF_DRIFT"
  | "NO_EFFECT"
  | "WRONG_TARGET"
  | "BLOCKED"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "TOOL_FAILED";

/** 控制台读取结果：消息 + 被过滤掉的噪音条数 */
export interface BrowserConsoleReport {
  entries: BrowserConsoleEntry[];
  /** 被过滤掉的消息数（Electron 自身的安全警告等，不属于页面） */
  dropped: number;
}

/**
 * 网络读取结果。
 *
 * 区分「缓冲里一条都没有」与「有记录但没失败」是必须的：旧实现在后者会回
 * “还没有记录”，与事实相反 —— 而模型正是靠这句话决定要不要继续等接口。
 */
export interface BrowserNetworkReport {
  entries: BrowserNetworkEntry[];
  /** 过滤前的总条数 */
  total: number;
  /** 因展示上限而未列出的条数 */
  omitted: number;
  /** 缓冲里一条记录都没有 */
  bufferEmpty: boolean;
  /** 有记录但没有失败请求 */
  noFailures: boolean;
}

/**
 * 一个浏览器标签的对外身份。
 *
 * 右侧栏可以同时开着多个浏览器标签（各自一个 <webview> guest），主进程按 tabId 记账，
 * 模型的每个浏览器工具都能用 `tab` 参数指定作用于哪一个；缺省是「模型的工作标签」。
 */
export interface BrowserTabInfo {
  /** 形如 "t3"；由渲染层分配，全局唯一 */
  tabId: string;
  /** 用户此刻在看的那个标签 */
  active: boolean;
  url: string;
  title: string;
}

/** 触摸过一次「模型正在操作页面」的状态视图；面板重挂载后用它重新同步 */
export interface BrowserStatus {
  /** 是否至少有一个浏览器标签已就绪 */
  open: boolean;
  /** 当前所有浏览器标签（按创建顺序） */
  tabs: BrowserTabInfo[];
  /** 模型正在操作页面（工具调用进行中） */
  agentActive: boolean;
}

/**
 * 模型在页面上做的一次鼠标动作（给界面画「可见光标」用）。
 *
 * 为什么要有它：自动化是**看不见的** —— 页面自己滚动、自己点击，用户只看到结果变了，
 * 分不清「模型点了哪里」与「页面自己跳了」。把落点报出来，面板就能画一个光标与涟漪，
 * 让人在几秒内看懂模型在做什么（也是出错时唯一能复现落点的地方）。
 *
 * 坐标是**视口 CSS 像素**，与快照里元素的 x/y 同一套，与 `getBoundingClientRect` 一致；
 * 面板若对 guest 做了缩放（设备预览），渲染时要自己乘上缩放比。
 */
export type BrowserPointerAction =
  /** 左键单击（含按下 → 抬起两个相位） */
  | "click"
  /** 双击 */
  | "double-click"
  | "right-click"
  | "middle-click"
  /** 悬停 / 移入 */
  | "hover"
  /** 滚轮滚动 */
  | "scroll"
  /** 拖拽（from → 目标点） */
  | "drag"
  /** 输入聚焦那一下的点击 */
  | "type";

export interface BrowserPointerEvent {
  type: "pointer";
  tabId: string;
  action: BrowserPointerAction;
  /** 落点（视口 CSS 像素） */
  x: number;
  y: number;
  /** 拖拽起点（action 为 "drag" 时给出） */
  fromX?: number;
  fromY?: number;
  /** 同一个动作的相位：start = 按下 / 开始，end = 抬起 / 结束 */
  phase: "start" | "end";
  /** 落点上是谁（"e12 button \"Save\"" 这类可读描述）；读不到时缺省 */
  target?: string;
  /** 拖拽途经的步数（仅 drag 且 phase 为 end 时有意义） */
  steps?: number;
}

/** 主进程 → 渲染进程的单向推送 */
export type BrowserEvent =
  /** 某个标签的页面状态变化：导航、加载开始/结束、标题变化、加载失败 */
  | { type: "state"; tabId: string; state: BrowserPageState }
  /**
   * 模型要用内置浏览器：请把右侧栏展开、并在需要时**新建**一个浏览器标签。
   *
   * requestId 是回执凭据：渲染层把目标标签建好（webview 挂上）后，用
   * browser:register-tab 把这个 id 带回来，主进程才知道该往哪个 guest 上导航 ——
   * 「新建标签」是渲染层的动作，没有回执主进程就只能盲等。
   */
  | { type: "open-request"; requestId: string; newTab: boolean; tabId?: string }
  /** 模型开始 / 结束操作某个标签的页面，面板据此在该标签上显示提示条 */
  | { type: "agent"; active: boolean; note?: string; tabId?: string }
  /** 模型在页面上做的一次鼠标动作：面板据此画可见光标与涟漪（见 BrowserPointerEvent） */
  | BrowserPointerEvent;

/**
 * 工具名常量：权限层、UI 图标表与测试都按它登记，避免三处各写一份字面量。
 *
 * **刻意只有 9 个**（原先 14 个）：工具越多，模型在「该用哪个」上的选择成本越高，
 * 而浏览器动作 90% 落在同一组语义上。合并的口径是按**问题**分而不是按**事件**分：
 *   · open / history —— 到哪个页面（history 管 back/forward/reload）；
 *   · snapshot —— 页面长什么样（带 ref 的可交互元素清单，后面所有动作都靠 ref）；
 *   · act —— 改变页面状态：click / type / press / hover / select / scroll / drag 七合一，
 *     它们的参数天然互斥（ref / x,y / text / key / 值），一个 action 字段就能讲清；
 *     click 与 hover 既能按 ref（语义定位、会自己滚动到位）也能按 x,y（canvas、
 *     图片热区、快照表达不了的落点）—— 两条路都是真实鼠标事件；
 *   · wait —— 等异步渲染落定（SPA 的头号问题）；
 *   · screenshot —— 看起来是什么样；
 *   · logs —— 页面自己报了什么错、发了什么请求（console / network 两种视图）；
 *   · dialog —— JS 弹窗策略（alert/confirm 不处理会把页面永久卡住）；
 *   · evaluate —— 逃生门（快照表达不了的检查）。
 *
 * 每一个工具都接受可选的 `tab` 参数（作用于哪个标签），输出里也带当前标签身份。
 */
export const BROWSER_TOOL_NAMES = {
  open: "browser_open",
  history: "browser_history",
  snapshot: "browser_snapshot",
  act: "browser_act",
  wait: "browser_wait",
  screenshot: "browser_screenshot",
  logs: "browser_logs",
  dialog: "browser_dialog",
  evaluate: "browser_evaluate",
} as const;

/**
 * 只读的浏览器工具：读页面内容、读控制台 / 网络记录、截图、等页面就绪。
 *
 * 它们进 permissions.ts 的 LOW_RISK_TOOLS —— 语义与 read/grep 一致：只读、不改变任何
 * 状态、不触碰工作区。归入高风险会让「先看一眼页面」都要先点一次审批卡，
 * 而那恰恰是每次浏览器任务的第一步。
 *
 * 注意 wait 也在这里：它只是等，不产生任何副作用（超时也只是返回「没等到」）。
 */
export const BROWSER_READ_ONLY_TOOL_NAMES = [
  BROWSER_TOOL_NAMES.snapshot,
  BROWSER_TOOL_NAMES.logs,
  BROWSER_TOOL_NAMES.screenshot,
  BROWSER_TOOL_NAMES.wait,
];

/**
 * 网络记录的一条。
 *
 * 为什么要有它：模型在调试自己的前端时，「页面白屏」和「接口 500 / CORS 被拦」是两类
 * 完全不同的故障，而快照看不出来 —— 它只看到空白。Playwright MCP 与 codex 都提供
 * 网络可见性，就是为了让模型不必靠猜。
 */
export interface BrowserNetworkEntry {
  url: string;
  method: string;
  /** HTTP 状态码；请求失败（未拿到响应）时为 0 */
  status: number;
  /** 资源类型：document / script / xhr / fetch / image / stylesheet … */
  resourceType: string;
  /** 请求失败的原因（DNS、连接被拒、CORS 等）；成功时缺省 */
  error?: string;
  /** 耗时（毫秒）；未拿到响应时为 0 */
  durationMs: number;
  at: number;
}

/** 一次等待的结果 */
export interface BrowserWaitResult {
  /** 等到条件成立为 true；超时为 false */
  matched: boolean;
  /** 实际等待的毫秒数 */
  waitedMs: number;
  /** 人可读的结果说明（含超时时的现状描述） */
  detail: string;
}

/**
 * JS 弹窗（alert / confirm）的处理策略。
 *
 * 为什么必须有：实测 alert() 会把 guest 的渲染进程**永久卡住** —— 点击调用超时，
 * 之后任何求值也超时（页面在等一个永远不会有人点的按钮）。所以策略有一个默认值
 * （dismiss），模型可以改，但页面绝不会因为没人应答而僵死。
 *
 * 没有 promptText：Electron 的 guest 里 `prompt()` 直接抛
 * 「prompt() is not supported.」（实测），给它配文本参数是永远走不到的路。
 */
export interface BrowserDialogPolicy {
  /** accept = 点「确定」，dismiss = 点「取消」/ 关闭 */
  action: "accept" | "dismiss";
}
