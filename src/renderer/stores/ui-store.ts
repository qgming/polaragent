import { create } from "zustand";

/** 右侧面板的视图 */
export type RightPanelView = "review" | "files" | "subagent" | "browser" | "terminal";

/**
 * 右侧面板五个视图的规范顺序，即面板内选择列表的顺序（与参考图一致）。
 * 加一个视图时只有这一处要改，选择列表与快捷键提示都读它。
 *
 * **没有「侧边聊天」这个视图**：它原本是「往主线程之外塞一句小问题」的入口，
 * 但用户要的是「让模型帮我问一句」，而这件事与子智能体是同一件事 ——
 * 都需要一条独立、可查看、不污染主上下文的会话。两个入口做同一件事时，
 * 用户要先猜该点哪个；于是侧边聊天被合进子智能体面板。
 */
export const RIGHT_PANEL_VIEWS = [
  "review",
  "files",
  // 子智能体：一次委派的执行详情（任务、进度、报告、子会话转录）。
  // 排在这里是因为它是唯一「对话形态」的面板，与审查 / 文件那种资料形态分开
  "subagent",
  "browser",
  "terminal",
] as const satisfies readonly RightPanelView[];

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

/** 设置弹窗内的分栏 */
export type SettingsSection =
  | "general"
  | "services"
  | "mcp"
  | "skills"
  | "subagents"
  | "promptTemplates"
  | "personalization"
  | "data"
  | "about";

/**
 * 设置分类的规范顺序：左栏导航与搜索里的「设置」结果都按它渲染。
 * 两处各写一份列表时，删掉一个分类就会漏改另一处（搜索会打开一个没有面板的分栏）。
 */
export const SETTINGS_SECTIONS = [
  "general",
  "services",
  "mcp",
  "skills",
  "subagents",
  "promptTemplates",
  "personalization",
  "data",
  "about",
] as const satisfies readonly SettingsSection[];
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

interface UiState {
  sidebarCollapsed: boolean;
  /** 搜索模态窗的显隐：侧栏搜索按钮与 Ctrl+K 共用同一个开关 */
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** 待定位的消息（null = 无）；由搜索模态窗的消息结果写入，Thread 消费后自行去重 */
  searchJump: SearchJump | null;
  /** 待确认删除的会话 id（null = 无）；由侧栏渲染确认对话框 */
  pendingDeleteSessionId: string | null;
  /** 待确认的删除所对应的解决函数：确认与否决都要调它，否则适配器那边的 Promise 悬挂 */
  resolveDeleteSession: ((confirmed: boolean) => void) | null;
  /** 正在编辑的用户消息 id（null = 未编辑）；由 ChatView 渲染编辑模态 */
  editingMessageId: string | null;

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
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: false,
  searchOpen: false,
  settingsOpen: false,
  settingsSection: "general",
  searchJump: null,
  rightPanelOpen: false,
  rightPanelTabs: [],
  activeTabId: null,
  pendingBrowserRequest: null,
  subagentPanelTarget: null,
  pendingDeleteSessionId: null,
  resolveDeleteSession: null,
  editingMessageId: null,

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

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? "general" }),
  closeSettings: () => set({ settingsOpen: false }),

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
}));
