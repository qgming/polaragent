/**
 * 冻结的 IPC 通道契约：值统一为 "域:动作"。
 * 通道名先于实现冻结，避免渲染层与主进程各自漂移。
 */
export const IPC = {
  app: {
    getInfo: "app:get-info",
    openPath: "app:open-path",
  },
  window: {
    minimize: "window:minimize",
    toggleMaximize: "window:toggle-maximize",
    close: "window:close",
    onMaximizedChange: "window:maximized-change",
  },
  settings: {
    read: "settings:read",
    write: "settings:write",
  },
  sessions: {
    list: "sessions:list",
    create: "sessions:create",
    rename: "sessions:rename",
    delete: "sessions:delete",
    archive: "sessions:archive",
    fork: "sessions:fork",
    pin: "sessions:pin",
    loadMessages: "sessions:load-messages",
    setModel: "sessions:set-model",
    setMode: "sessions:set-mode",
  },
  projects: {
    list: "projects:list",
    add: "projects:add",
    remove: "projects:remove",
  },
  chat: {
    send: "chat:send",
    stop: "chat:stop",
    queue: "chat:queue",
    /** 撤销一条还没被消费的排队消息（用户点队列行上的 ×） */
    cancelQueued: "chat:cancel-queued",
    compact: "chat:compact",
    event: "chat:event",
    /** 拉取某会话当前流式消息的完整快照（增量缺口时整条补齐，见 ChatStreamSnapshot） */
    snapshot: "chat:snapshot",
  },
  approvals: {
    respond: "approvals:respond",
  },
  interaction: {
    respond: "interaction:respond",
    pending: "interaction:pending",
  },
  jobs: {
    list: "jobs:list",
    kill: "jobs:kill",
  },
  skills: {
    list: "skills:list",
    /** 弹出文件选择框，把 zip 技能包解压导入数据目录的 skills/ */
    import: "skills:import",
    read: "skills:read",
    remove: "skills:remove",
  },
  prompts: {
    list: "prompts:list",
    write: "prompts:write",
    remove: "prompts:remove",
  },
  permissions: {
    listRules: "permissions:list-rules",
    addRule: "permissions:add-rule",
    removeRule: "permissions:remove-rule",
  },
  agents: {
    read: "agents:read",
    write: "agents:write",
  },
  /**
   * 子智能体：定义目录的读写 + 运行记录的查询/停止。
   *
   * `runs` 按**父会话**过滤：一次委派是主会话里的一次工具调用，
   * 详情面板取的是「当前这个会话派出去的子智能体」，而不是全局运行列表。
   * `event` 与 chat:event 同构，是主进程 → 渲染进程的单向推送，不属于 invoke 映射。
   */
  subagents: {
    list: "subagents:list",
    read: "subagents:read",
    write: "subagents:write",
    remove: "subagents:remove",
    reveal: "subagents:reveal",
    runs: "subagents:runs",
    stop: "subagents:stop",
    event: "subagents:event",
  },
  dialog: {
    pickDirectory: "dialog:pick-directory",
  },
  mcp: {
    list: "mcp:list",
    reload: "mcp:reload",
    probe: "mcp:probe",
  },
  services: {
    fetchModels: "services:fetch-models",
  },
  models: {
    lookup: "models:lookup",
  },
  terminal: {
    list: "terminal:list",
    create: "terminal:create",
    replay: "terminal:replay",
    write: "terminal:write",
    resize: "terminal:resize",
    close: "terminal:close",
    /** 主进程 → 渲染进程的单向推送（与 chat:event 一样不属于 invoke 映射） */
    event: "terminal:event",
  },
  files: {
    listDirectory: "files:list-directory",
    readFile: "files:read-file",
  },
  review: {
    summary: "review:summary",
  },
  /**
   * 内置浏览器：状态读取 + 标签注册（三个 invoke 通道）。
   *
   * 页面的驱动（导航 / 点击 / 读内容）**不经过渲染层**：guest 由主进程从
   * did-attach-webview 拿到后直接操作（见 browser/service.ts）。渲染层的面板只需
   * 把 <webview> 建出来、把「哪个 tabId 对应哪个 webContents」登记回来，
   * 再用下面的 event 订阅「页面变了 / 模型在操作 / 请你开标签」。
   */
  browser: {
    status: "browser:status",
    /** 登记一个标签：渲染层建好 webview 后调用，主进程据此把 tabId 与 guest 绑定 */
    registerTab: "browser:register-tab",
    /** 注销一个标签：标签页被关闭时调用，主进程释放它的 guest 引用与缓冲 */
    unregisterTab: "browser:unregister-tab",
    /** 用户切到了某个标签：主进程用它回答「active 是哪一个」 */
    activateTab: "browser:activate-tab",
    /** 主进程 → 渲染进程的单向推送（同 terminal:event） */
    event: "browser:event",
  },
  /**
   * 网络搜索：设置面板的「测试连接」。
   *
   * 只这一个通道 —— provider 集合是编译期常量（见 shared/contracts/web.ts 的
   * WEB_SEARCH_PROVIDERS），不需要从主进程问；配置读写走既有的
   * settings:read / settings:write，不另开。
   */
  web: {
    /** 用**草稿**配置发一次真实检索（与是否已保存无关） */
    test: "web:test",
  },
} as const;
