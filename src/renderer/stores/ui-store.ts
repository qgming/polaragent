import { create } from "zustand";

/**
 * 输入框上方一行的**瞬时提示**（指令被拒、压缩没什么可压…）。
 *
 * 为什么放在 store 而不是某个组件里：写它的有两处 —— 输入框（回车拦截）与发送收口
 * （真正的执行结果），而显示它的只有输入框一处。谁先写不重要，用户看到的都是同一行。
 *
 * token 只增不减：同一条提示连写两次（例如连按两次回车）也要能重新计时/重新出现。
 */
export interface ComposerNotice {
  /** i18n 键；字段名被 scripts/check-i18n.mjs 扫描，拼错/漏词条会在门禁上红 */
  messageKey: string;
  /** 插值参数 */
  params?: Record<string, string | number>;
  level: "info" | "error";
  token: number;
}

let composerNoticeSeq = 0;

/** 随应用分发的六个面板视图；插件贡献的面板不在其中 */
export type BuiltinRightPanelView =
  | "review"
  | "files"
  | "file"
  | "subagent"
  | "browser"
  | "terminal";

/**
 * 右侧面板的视图 id。
 *
 * 联合里那个 `(string & {})` 是刻意的 TS 惯用法：**保留字面量的自动补全与拼写检查，
 * 同时允许任意字符串**。写成裸 `string` 会丢掉前者（`openRightPanel("files")` 拼错
 * 就不再报错），写成纯字面量联合又会挡住插件贡献的面板。
 *
 * **顺序与展示元数据不在这里** —— 它们在右侧面板的注册表里（见
 * features/right-panel/panels.ts）。过去这里还有一张 `RIGHT_PANEL_VIEWS` 顺序表，
 * 与 `panel-meta` 的穷举 Record 两处维护，加一个视图要同时改两处，漏哪一处的症状都不同。
 * 现在只有一处：注册一行。
 *
 * **没有「侧边聊天」这个视图**：它原本是「往主线程之外塞一句小问题」的入口，
 * 但用户要的是「让模型帮我问一句」，而这件事与子智能体是同一件事 ——
 * 都需要一条独立、可查看、不污染主上下文的会话。两个入口做同一件事时，
 * 用户要先猜该点哪个；于是侧边聊天被合进子智能体面板。
 */
export type RightPanelView = BuiltinRightPanelView | (string & {});

/**
 * 面板里的一个标签。
 *
 * title 为 null 时标签显示视图自己的名字（见 RIGHT_PANEL_VIEW_META 的 labelKey）；
 * 浏览器标签就落在这里 —— 页面还没报出标题时显示「浏览器」，报出之后换成页面标题。
 * 多开浏览器时标签栏得像浏览器一样能区分「哪个页面在哪个标签」，只写两遍「浏览器」
 * 等于没写。
 */
export interface RightPanelTab {
  id: string;
  view: RightPanelView;
  title: string | null;
}

/**
 * 模型 open-request 的回执凭据与它要的那个标签。
 *
 * 主进程按 requestId 等回执（「新建标签」是渲染层的动作，没有回执它就只能盲等）。
 * 标签一被创建就记在这里，BrowserPanel 在 guest 就绪、登记 guest 时把它交回主进程。
 */
export interface PendingBrowserRequest {
  requestId: string;
  tabId: string;
}

/**
 * 一次「用内置浏览器打开这个地址」的请求（用户点文件卡片里的 HTML 时产生）。
 *
 * 与 PendingBrowserRequest 是两件事，刻意不复用：
 *   · 那个是**模型**发起的 open-request 的回执凭据，带 requestId、要走主进程的等待；
 *   · 这个是**用户**点出来的本地导航，没有请求方在等，只是「把地址栏指到这个 URL」。
 *
 * token 只增不减：同一个地址连点两次（或先看别的文件再点回来）要能再次触发导航 ——
 * 按值比较会让第二次点击被当成「没有变化」而静默失效。
 */
export interface BrowserOpenRequest {
  /** 要加载的 URL（本地 HTML 走 file://，见 turn-files 的 toFileUrl） */
  url: string;
  /** 面板标签上显示的名字（文件名）；缺省时浏览器自己按页面标题补 */
  title: string;
  token: number;
}

let browserOpenSeq = 0;

/** 随应用分发的十个设置分栏；插件贡献的设置页不在其中 */
export type BuiltinSettingsSection =
  | "general"
  | "services"
  | "web"
  | "mcp"
  | "skills"
  | "subagents"
  | "promptTemplates"
  | "personalization"
  | "data"
  | "about";

/**
 * 设置弹窗内的分栏 id。
 *
 * 与 RightPanelView 同款：`(string & {})` 保住内置项的字面量检查，同时允许插件
 * 贡献自己的设置页。
 *
 * **顺序与图标、文案都不在这里** —— 它们在设置分栏注册表里
 *（见 features/settings/sections.ts）。过去这里有一张 `SETTINGS_SECTIONS` 顺序表，
 * 与 SettingsModal 的 `SECTIONS` 数组、`renderPanel` 的 switch 三处并立，
 * 而**第 4 处最隐蔽**：SearchModal 用 `` t(`settings.${section}`) `` 拼文案键，
 * 依赖"id 恰好等于键的后缀"这条没人写下来的约定。
 */
export type SettingsSection = BuiltinSettingsSection | (string & {});

/**
 * 默认落在哪一栏。
 *
 * 单独一个常量而不是让三处各写一次 `"general"`：它是"打开设置时看到什么"的答案，
 * 改了要一起改（store 的初值、openSettings 的缺省、以及将来深链的回落）。
 */
export const DEFAULT_SETTINGS_SECTION: BuiltinSettingsSection = "general";

/**
 * 插件管理模态窗内的**来源页签**。
 *
 * 与设置分栏同款（`DEFAULT_SETTINGS_SECTION`），但值域是"插件从哪来"而不是"配置的哪一栏"。
 *
 * ## 为什么从「四栏」收敛成「两个来源」
 *
 * 原先左导航是 已安装 / 开发 / 来源 / 诊断 四项，而「开发」与「已安装」在**内容上高度重叠**
 * —— 同一个开发插件在两栏里都会出现（DevPanel 的注释自己写了这一点）。
 * 一个东西出现在两个地方，用户就要先想"我该去哪一栏找它"。
 *
 * 现在：**来源只有系统与用户两个**，开发插件并入用户（它本来就是用户自己挂的，
 * 生命周期也归用户）。开发与安装的差别**落在行上的徽章**里（见 PluginRow），
 * 而不是落在导航上 —— 那个差别影响的是"卸载会不会删我的文件"，
 * 是某一行的属性，不是一整栏的属性。
 *
 * 市场来源与诊断不再各占一栏：前者并入用户页签的空态提示（它本来就没实现），
 * 后者并进用户面板底部（有内容才显示）。
 */
export type PluginSourceTab = "system" | "user";

/** 默认落在哪一页签。用户装的东西比随包分发的更需要管理，所以默认落在用户 */
export const DEFAULT_PLUGIN_SOURCE: PluginSourceTab = "user";
/**
 * 从搜索模态窗跳到某条消息。
 * token 只增不减：Thread 用它做「同一目标只滚一次」的去重键，
 * 若随清空归零，回到同一会话再点同一条消息就会撞上已消费的记录而不再滚动。
 */
export interface SearchJump {
  sessionId: string;
  messageId: string;
  token: number;
}

let searchJumpSeq = 0;

/**
 * 标签 id 的分配器。
 *
 * 自增计数、不回收：同一个 id 在窗口生命周期内不会再分配给别的标签 ——
 * id 会发给主进程（registerTab / activateTab / unregisterTab），
 * 复用已注销的 id 会让主进程把新标签认成旧标签。
 */
let rightPanelTabSeq = 0;

function nextRightPanelTabId(): string {
  rightPanelTabSeq += 1;
  return `t${rightPanelTabSeq}`;
}

/**
 * 找一个可以复用的标签：优先「当前就在看的那个」（它正好是这个视图），
 * 否则该视图最后创建的那一个。
 *
 * 后者的理由：浏览器有多页时，「复用」应该落在最近用过的一页上，
 * 而不是永远跳回最早开的那一页；不记「每个视图上次看的标签」是为了不再多一份状态 ——
 * 标签按创建顺序排列，最后一个就是最近的近似。
 */
function findReusableTab(
  tabs: RightPanelTab[],
  activeTabId: string | null,
  view: RightPanelView,
): RightPanelTab | undefined {
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (active !== undefined && active.view === view) return active;
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab !== undefined && tab.view === view) return tab;
  }
  return undefined;
}

/**
 * 一个正在打开的**插件模态窗**：哪个插件的哪一个界面。
 *
 * 只存 id 不存 surface 描述对象：那份描述来自 `plugins:list` 的结果，
 * 而插件可以在模态窗开着的时候被停用 / 卸载 —— 届时描述会失效。
 * 存 id、用时现查，天然让"插件没了"表现为"查不到"（模态窗自己收掉），
 * 而不是拿一份过期的描述继续渲染。
 */
export interface PluginModalTarget {
  pluginId: string;
  surfaceId: string;
}

interface UiState {
  sidebarCollapsed: boolean;
  /** 搜索模态窗的显隐：侧栏搜索按钮与 Ctrl+K 共用同一个开关 */
  searchOpen: boolean;
  settingsOpen: boolean;
  /**
   * 插件管理模态窗的显隐与当前分栏。
   *
   * 与 settingsOpen / searchOpen 是**互斥**的三个模态（见 openPlugins 的实现）：
   * 同一时刻只能开一个。互斥写在 store 里而不是各组件里 —— 三个模态的开关分散在
   * 侧栏、快捷键、命令面板多处，靠调用方自觉「先关别的」迟早会漏一处。
   */
  pluginsOpen: boolean;
  /**
   * 数据统计模态窗的显隐。
   *
   * 与 settingsOpen / searchOpen / pluginsOpen 一起构成**互斥**的模态组
   * （见 openStats 的实现）：四种内容都是「占满一屏、要人看一会儿」的东西，
   * 叠起来只会让底下那层还能被点到。
   */
  statsOpen: boolean;
  /** 插件模态窗当前的分栏（与 settingsSection 同款：配置态，关闭不清空） */
  pluginsSource: PluginSourceTab;
  /**
   * 正在打开的插件模态窗界面（清单里 `kind: "modal"` 的那一类）；null = 没有。
   *
   * 与 searchOpen / settingsOpen / pluginsOpen 一起构成四个**互斥**的模态：
   * 同一时刻只开一个。理由与那三个一字不差 —— 叠起来的模态底下那层还能被点到。
   */
  pluginModal: PluginModalTarget | null;
  settingsSection: SettingsSection;
  /** 待定位的消息（null = 无）；由搜索模态窗的消息结果写入，Thread 消费后自行去重 */
  searchJump: SearchJump | null;
  /** 待确认删除的会话 id（null = 无）；由侧栏渲染确认对话框 */
  pendingDeleteSessionId: string | null;
  /** 待确认的删除所对应的解决函数：确认与否决都要调它，否则适配器那边的 Promise 悬挂 */
  resolveDeleteSession: ((confirmed: boolean) => void) | null;
  /** 正在编辑的用户消息 id（null = 未编辑）；由 ChatView 渲染编辑模态 */
  editingMessageId: string | null;
  /** 输入框上方那一行瞬时提示；null = 没有 */
  composerNotice: ComposerNotice | null;

  /**
   * 右侧面板是否展开。与左侧栏同一套「展开 / 完全隐藏」两态（没有窄轨道）。
   * 收起**不清空标签**：面板是「藏起来」而不是「关掉」，
   * 再次展开回到用户上次在看的内容（与左侧栏停在同一份会话列表上同理）。
   */
  rightPanelOpen: boolean;
  /** 面板里的全部标签，按创建顺序（标签栏从左到右就是它） */
  rightPanelTabs: RightPanelTab[];
  /**
   * 当前在看的标签；**null = 选择列表那一屏**（面板展开但还没选内容）。
   *
   * 关掉最后一个标签也会落回这里（见 closeRightPanelTab）：面板没内容可看时，
   * 与其把面板收起（用户还得再点开一次），不如直接给出五个入口。
   */
  activeTabId: string | null;
  /** 模型这次要的浏览器标签还没交回执；null = 没有待结算的请求 */
  pendingBrowserRequest: PendingBrowserRequest | null;
  /**
   * 子智能体面板要聚焦的运行 id（= 那次 Task 调用的 delegationId）；null = 列出全部运行。
   *
   * 单独一个字段而不是并进标签：点击主会话里的子智能体组件是「在已打开的面板里
   * 换一个焦点」，而切换标签是另一回事 —— 并进去就得在每次点击时重新构造标签值，
   * 关闭面板再打开也就丢掉了焦点。
   */
  subagentPanelTarget: string | null;

  /**
   * 文件查看器当前打开的文件（绝对路径）；null = 没有打开任何文件。
   *
   * 与标签分开存，理由和 subagentPanelTarget 一字不差：点另一张卡片是「在已打开的
   * 查看器里换一个文件」，那是换焦点而不是换标签。并进标签值就得在每次点击时重建
   * 标签对象，关掉再打开还会丢掉焦点。
   */
  filePanelTarget: string | null;
  /** 一次「用内置浏览器打开这个地址」的请求；null = 没有待处理的请求 */
  browserOpenRequest: BrowserOpenRequest | null;

  /**
   * 展开 / 收起面板。
   *
   * **这是面板唯一的开合入口**（面板内部刻意没有收起按钮）：顶栏那颗开关
   * 一直在屏幕上，而面板内的按钮只在展开时存在 —— 把动作放在始终可见的那一处，
   * 同一个意图就不会有两个入口。
   */
  toggleRightPanel(): void;
  /**
   * 展开面板并聚焦到某个视图。**只切不关**：面板内的点击是「换个内容」，
   * 想收起用顶栏那颗开关。
   *
   * 单例视图（审查 / 文件 / 子智能体 / 终端）已有标签就复用它 —— 同一个面板
   * 开两份没有意义。**浏览器相反：每次都新开一个标签**（选择列表里的「浏览器」
   * 与 Ctrl+T 都是「新建标签页」的语义，与浏览器的既有习惯一致；已有标签靠点标签栏
   * 切换）。模型的 open-request 不走这里 —— 它有自己的复用规则（见 RightSidebar）。
   */
  openRightPanel(view: RightPanelView): void;
  /**
   * 新开一个浏览器标签并激活它，返回新标签的 id。
   * **每次都新建**（「+」与模型的 newTab 请求走这里）：多开浏览器是特性，不是重复。
   */
  openBrowserTab(): string;
  /**
   * 关掉一个标签。关的是当前标签时接上邻居（右邻优先，其次左邻），
   * 一个都不剩就回到选择列表那一屏。
   */
  closeRightPanelTab(id: string): void;
  /** 切换到某个标签（用户点标签栏） */
  activateRightPanelTab(id: string): void;
  /** 回到选择列表（面板保持展开）：这是「换一个内容」，与收起是两件事 */
  showRightPanelChooser(): void;
  /** 页面报出的标题：换成标签上的名字（空串还原成视图名） */
  setRightPanelTabTitle(id: string, title: string): void;
  /** 回执已经交回主进程：清掉待结算的请求 */
  settleBrowserRequest(): void;
  /** 打开右侧栏并聚焦到某次子智能体运行；由主会话里的子智能体组件调用 */
  openSubagentPanel(delegationId: string): void;
  /**
   * 打开右侧栏的文件查看器并指向某个文件（绝对路径）。
   *
   * 单例视图（与审查 / 文件 / 子智能体同一条规则）：已有查看器标签就复用它并换文件，
   * 没有才新建。用户连点三张卡片时应该是「同一个查看器换了三次内容」，
   * 而不是开出三个标签 —— 后者会让标签条堆满一堆同名的「文件」。
   */
  openFilePanel(absolutePath: string): void;
  /** 用内置浏览器打开一个地址（用户点 HTML 卡片时调用）；每次都复用/新建浏览器标签 */
  openInBrowser(request: { url: string; title: string }): void;
  /**
   * 回到运行列表（清掉焦点）。
   *
   * 必须是**独立的动作**：不能靠再调一次 openSubagentPanel 表达「返回」——
   * 那个动作的语义是「聚焦到某一条运行」，拿它当返回等于把同一条又聚焦一遍，
   * 状态不变所以界面纹丝不动。这正是「点返回没反应」的成因。
   */
  clearSubagentPanelTarget(): void;

  toggleSidebar(): void;
  openSearch(): void;
  closeSearch(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  /** 打开插件管理模态窗并落在某个分栏（缺省 = 已安装）；同时关掉另外三个模态 */
  openPlugins(source?: PluginSourceTab): void;
  closePlugins(): void;
  /** 打开数据统计模态窗；同时关掉另外三个模态（同一时刻只开一个） */
  openStats(): void;
  closeStats(): void;
  /**
   * 打开一个插件的模态窗界面（清单 `kind: "modal"`）；同时关掉另外三个模态。
   *
   * **同一时刻只开一个插件模态窗**：与独立窗口那条「再点就聚焦」同一口径 ——
   * 两个插件的配置叠在一起没有意义，而模态窗本来就互斥。
   * 已经在开的那一个再点一次是**幂等**的（不重挂、不闪）。
   */
  openPluginModal(pluginId: string, surfaceId: string): void;
  closePluginModal(): void;
  /** 记录一次消息跳转请求；token 自增让同一目标也能重新触发定位 */
  jumpToMessage(sessionId: string, messageId: string): void;
  /** 丢弃当前跳转目标；离开目标会话后由 Thread 调用，避免残留标记 */
  clearSearchJump(): void;
  /**
   * 请求删除会话，返回用户是否确认。
   * 官方 thread-list 的 Delete 是会立刻执行的，删除又是不可撤销的磁盘操作，
   * 因此把确认拦在这里：确认框关闭前不真正删除。
   */
  requestDeleteSession(id: string): Promise<boolean>;
  /** 由确认对话框调用：记录用户选择并关闭对话框 */
  settleDeleteSession(confirmed: boolean): void;
  /** 打开某条用户消息的编辑模态 */
  beginEditMessage(id: string): void;
  closeEditMessage(): void;
  /** 写一行输入框提示（指令被拒 / 执行结果）；同一条文案连写两次也会重新出现 */
  notifyComposer(notice: Omit<ComposerNotice, "token">): void;
  /** 收起提示（用户一开始打字就调，提示不该赖在屏幕上） */
  dismissComposerNotice(): void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: false,
  searchOpen: false,
  settingsOpen: false,
  settingsSection: DEFAULT_SETTINGS_SECTION,
  pluginsOpen: false,
  pluginsSource: DEFAULT_PLUGIN_SOURCE,
  statsOpen: false,
  pluginModal: null,
  searchJump: null,
  rightPanelOpen: false,
  rightPanelTabs: [],
  activeTabId: null,
  pendingBrowserRequest: null,
  subagentPanelTarget: null,
  filePanelTarget: null,
  browserOpenRequest: null,
  pendingDeleteSessionId: null,
  resolveDeleteSession: null,
  editingMessageId: null,
  composerNotice: null,

  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

  // 只切不关：面板内的点击是「换个内容」，用户要看的是新内容。
  // 收起由顶栏那颗开关负责（它始终可见），这里不重复这个动作。
  openRightPanel: (view) =>
    set((state) => {
      // 浏览器是多实例视图：从选择列表点它（以及 Ctrl+T）就是「新建标签页」，
      // 复用已有标签反而让「怎么开第二个」变成一道无解的题。
      if (view === "browser") {
        const tab: RightPanelTab = { id: nextRightPanelTabId(), view, title: null };
        return {
          rightPanelOpen: true,
          rightPanelTabs: [...state.rightPanelTabs, tab],
          activeTabId: tab.id,
        };
      }
      const existing = findReusableTab(state.rightPanelTabs, state.activeTabId, view);
      if (existing !== undefined) return { rightPanelOpen: true, activeTabId: existing.id };
      const tab: RightPanelTab = { id: nextRightPanelTabId(), view, title: null };
      return {
        rightPanelOpen: true,
        rightPanelTabs: [...state.rightPanelTabs, tab],
        activeTabId: tab.id,
      };
    }),

  openBrowserTab: () => {
    const tab: RightPanelTab = { id: nextRightPanelTabId(), view: "browser", title: null };
    set((state) => ({
      rightPanelOpen: true,
      rightPanelTabs: [...state.rightPanelTabs, tab],
      activeTabId: tab.id,
    }));
    return tab.id;
  },

  closeRightPanelTab: (id) =>
    set((state) => {
      const index = state.rightPanelTabs.findIndex((tab) => tab.id === id);
      if (index === -1) return {};
      const tabs = state.rightPanelTabs.filter((tab) => tab.id !== id);
      return {
        rightPanelTabs: tabs,
        // 关掉当前标签时接上右邻（关掉后视线停在原位置附近），没有右邻就用左邻；
        // 关的不是当前标签则不动焦点。一个都不剩 -> activeTabId = null（选择列表）。
        activeTabId:
          state.activeTabId === id
            ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
            : state.activeTabId,
        // 回执跟着标签走：它还没等到 registerTab 就被关掉时，留着谁也领不了
        pendingBrowserRequest:
          state.pendingBrowserRequest?.tabId === id ? null : state.pendingBrowserRequest,
      };
    }),

  activateRightPanelTab: (id) =>
    set((state) => (state.rightPanelTabs.some((tab) => tab.id === id) ? { activeTabId: id } : {})),

  showRightPanelChooser: () => set({ activeTabId: null }),

  setRightPanelTabTitle: (id, title) => {
    const label = title.trim();
    set((state) => {
      // 标签可能刚被关掉（页面标题事件晚到一步）：没有这个 id 就不必换一份数组
      if (!state.rightPanelTabs.some((tab) => tab.id === id)) return {};
      return {
        rightPanelTabs: state.rightPanelTabs.map((tab) =>
          tab.id === id ? { ...tab, title: label === "" ? null : label } : tab,
        ),
      };
    });
  },

  settleBrowserRequest: () => set({ pendingBrowserRequest: null }),
  // 点开子智能体组件 = 「把它摊开给我看」：既展开面板，也把焦点定到这一条运行上。
  // 子智能体是单例视图：已有标签就复用它（openRightPanel 的规则相同）
  openSubagentPanel: (delegationId) =>
    set((state) => {
      const existing = findReusableTab(state.rightPanelTabs, state.activeTabId, "subagent");
      if (existing !== undefined) {
        return {
          rightPanelOpen: true,
          activeTabId: existing.id,
          subagentPanelTarget: delegationId,
        };
      }
      const tab: RightPanelTab = { id: nextRightPanelTabId(), view: "subagent", title: null };
      return {
        rightPanelOpen: true,
        rightPanelTabs: [...state.rightPanelTabs, tab],
        activeTabId: tab.id,
        subagentPanelTarget: delegationId,
      };
    }),

  clearSubagentPanelTarget: () => set({ subagentPanelTarget: null }),

  // 点文件卡片 = 「把这份文件摊开给我看」：既展开面板，也把查看器指向这个文件。
  // 查看器是单例视图：已有标签就复用它（规则与 openRightPanel 一致），
  // 否则「连点三张卡片」会开出三个标签。
  openFilePanel: (absolutePath) =>
    set((state) => {
      const existing = findReusableTab(state.rightPanelTabs, state.activeTabId, "file");
      if (existing !== undefined) {
        return {
          rightPanelOpen: true,
          activeTabId: existing.id,
          filePanelTarget: absolutePath,
        };
      }
      const tab: RightPanelTab = { id: nextRightPanelTabId(), view: "file", title: null };
      return {
        rightPanelOpen: true,
        rightPanelTabs: [...state.rightPanelTabs, tab],
        activeTabId: tab.id,
        filePanelTarget: absolutePath,
      };
    }),

  /**
   * 用内置浏览器打开一个地址。
   *
   * 与 openRightPanel("browser") 的差别：那个是「新建标签页」的语义（从选择列表点就是
   * 要多开一个）。这里的目标是**看这一个文件**，所以复用已有的浏览器标签更贴近意图 ——
   * 点三次 HTML 卡片不该开出三个标签。没有标签时才新建一个。
   *
   * 标签名先按文件名写上：本地文件的页面标题常常是空串或与文件名重复，
   * 等浏览器报回真正的标题后会由 setRightPanelTabTitle 覆盖。
   */
  openInBrowser: ({ url, title }) => {
    browserOpenSeq += 1;
    set((state) => {
      const browserTabs = state.rightPanelTabs.filter((tab) => tab.view === "browser");
      const target = browserTabs.at(-1);
      const request: BrowserOpenRequest = { url, title, token: browserOpenSeq };
      if (target !== undefined) {
        return {
          rightPanelOpen: true,
          activeTabId: target.id,
          browserOpenRequest: request,
          rightPanelTabs: state.rightPanelTabs.map((tab) =>
            tab.id === target.id ? { ...tab, title } : tab,
          ),
        };
      }
      const tab: RightPanelTab = { id: nextRightPanelTabId(), view: "browser", title };
      return {
        rightPanelOpen: true,
        rightPanelTabs: [...state.rightPanelTabs, tab],
        activeTabId: tab.id,
        browserOpenRequest: request,
      };
    });
  },

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  /*
    模态互斥（搜索 / 设置 / 插件 / 统计 + 插件自己的模态窗）。
    互斥写在 store 里而不是各组件里：开关分散在侧栏按钮、快捷键、命令面板若干处，
    靠调用方自觉「先关掉别的」迟早会漏 —— 而漏了的症状是两层模态叠在一起，
    底下的那层还能被点到。
  */
  openSearch: () =>
    set({
      searchOpen: true,
      settingsOpen: false,
      pluginsOpen: false,
      statsOpen: false,
      pluginModal: null,
    }),
  closeSearch: () => set({ searchOpen: false }),
  openSettings: (section) =>
    set({
      settingsOpen: true,
      settingsSection: section ?? DEFAULT_SETTINGS_SECTION,
      searchOpen: false,
      pluginsOpen: false,
      statsOpen: false,
      pluginModal: null,
    }),
  closeSettings: () => set({ settingsOpen: false }),
  openPlugins: (section) =>
    set({
      pluginsOpen: true,
      pluginsSource: section ?? DEFAULT_PLUGIN_SOURCE,
      searchOpen: false,
      settingsOpen: false,
      statsOpen: false,
      pluginModal: null,
    }),
  closePlugins: () => set({ pluginsOpen: false }),
  openStats: () =>
    set({
      statsOpen: true,
      searchOpen: false,
      settingsOpen: false,
      pluginsOpen: false,
      pluginModal: null,
    }),
  closeStats: () => set({ statsOpen: false }),
  openPluginModal: (pluginId, surfaceId) =>
    set((state) => {
      // 已经在开的那一个：**不动状态**（幂等）。仍然要关掉另外三个 —— 幂等指的是
      // "不重挂这个模态窗"，不是"什么都不做"
      const same =
        state.pluginModal?.pluginId === pluginId && state.pluginModal.surfaceId === surfaceId;
      return {
        pluginModal: same ? state.pluginModal : { pluginId, surfaceId },
        searchOpen: false,
        settingsOpen: false,
        pluginsOpen: false,
        statsOpen: false,
      };
    }),
  closePluginModal: () => set({ pluginModal: null }),

  jumpToMessage: (sessionId, messageId) => {
    searchJumpSeq += 1;
    set({ searchJump: { sessionId, messageId, token: searchJumpSeq } });
  },

  clearSearchJump: () => set({ searchJump: null }),

  requestDeleteSession: (id) =>
    new Promise<boolean>((resolve) => {
      // 上一个请求还没结算就再来一个（连点菜单）：先把旧的按否决收掉，避免悬挂
      get().resolveDeleteSession?.(false);
      set({ pendingDeleteSessionId: id, resolveDeleteSession: resolve });
    }),

  settleDeleteSession: (confirmed) => {
    const resolve = get().resolveDeleteSession;
    set({ pendingDeleteSessionId: null, resolveDeleteSession: null });
    resolve?.(confirmed);
  },

  beginEditMessage: (id) => set({ editingMessageId: id }),
  closeEditMessage: () => set({ editingMessageId: null }),

  notifyComposer: (notice) => {
    composerNoticeSeq += 1;
    set({ composerNotice: { ...notice, token: composerNoticeSeq } });
  },
  dismissComposerNotice: () => {
    // 已经是 null 就不换引用：每次按键都 set 一次会让订阅它的组件白白重渲染
    if (get().composerNotice !== null) set({ composerNotice: null });
  },
}));
