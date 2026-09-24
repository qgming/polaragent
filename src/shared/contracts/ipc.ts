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
    /** 只重连一台 server（卡片右上角那个按钮） */
    reconnect: "mcp:reconnect",
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
    /** 读一张图片（返回可直接显示的 dataUrl）；供 read_image 的详情按需加载 */
    readImage: "files:read-image",
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
  /**
   * 插件：设置里的插件管理组件（模态窗）的全部数据通路。
   *
   * 分三组：
   *  - `list` / `diagnostics` —— 只读；
   *  - `enable` / `disable` / `reload` / `uninstall` —— 改一个插件的状态，
   *    统一返回**变更后的完整列表**（与 IPC.mcp.* 同款，面板不必再拉一次）；
   *  - `install` / `loadDev` —— 要弹文件/目录选择框，返回 PluginMutationResult
   *    （带 canceled 与 diagnostics）。
   *
   * `openSurface` 是唯一一个「不改列表但会开界面」的通道 —— 它对应
   * 「打开界面」那颗按钮：面板切右侧面板、模态窗开对话框、窗口建独立窗口。
   */
  plugins: {
    list: "plugins:list",
    enable: "plugins:enable",
    disable: "plugins:disable",
    reload: "plugins:reload",
    /** 安装一个 .ointplug 包（弹文件选择框） */
    install: "plugins:install",
    /** 卸载一个插件；keepData 决定是否保留它的私有数据目录 */
    uninstall: "plugins:uninstall",
    /** 引用一个本地目录作为开发插件（弹目录选择框，不拷贝文件） */
    loadDev: "plugins:loadDev",
    /** 打开插件提供的某个界面（面板 / 模态窗 / 独立窗口） */
    openSurface: "plugins:openSurface",
    /**
     * 插件界面**自己**请求关闭时，主进程把这件事告诉渲染层（主进程 → 渲染层，推送）。
     *
     * 为什么需要它：面板与模态窗的宿主都是渲染层的 React 组件，主进程**没有句柄**，
     * 关不掉它们，只能摘掉归属登记。不通知的话，用户在插件页面里点了"关闭"之后
     * 标签 / 模态窗照旧开着，而它此后每一次桥调用都会被身份闸门拒掉 ——
     * 一个凭空的"点了没反应"。
     *
     * 独立窗口不走这条：那类窗口由主进程建，`close()` 直接 `win.close()`。
     */
    surfaceClosed: "plugins:surfaceClosed",
    /** 在系统文件管理器里打开插件的私有数据目录 */
    revealData: "plugins:revealData",
    diagnostics: "plugins:diagnostics",
    /** 插件注册的命令（进程在跑的那些） */
    commands: "plugins:commands",
    /** 执行一个插件命令 */
    runCommand: "plugins:runCommand",
    /**
     * 把当前主题推给全部插件界面。
     *
     * **调用方是我们自己的渲染层，不是插件界面** —— 所以它不走 `surface:*`
     * （那一组的每个处理器都要先查归属表）。主题的唯一真源在渲染层的设置里，
     * 主进程没有"主题变了"的事件源。
     */
    broadcastTheme: "plugins:broadcastTheme",
    /** 把一个插件打成 zip 分享出去（弹保存框） */
    export: "plugins:export",
    /**
     * 告诉宿主当前会话的工作目录 —— 它决定**项目级插件目录**
     *（`<工作目录>/.oint/plugins/`）扫不扫。
     *
     * 由渲染层在会话切换时调（与 `resolveWorkingDir` 同一个口径）。
     * 不给就跳过项目那一层，而不是猜一个 —— 猜错会让 A 项目的插件出现在 B 项目的列表里。
     */
    setWorkspace: "plugins:setWorkspace",
  },
  /**
   * 插件界面（webview / 独立窗口）↔ 宿主的桥。
   *
   * **这一组通道与别的组有一个根本差别**：它们的调用方是**第三方代码**，
   * 而不是我们自己的渲染层。所以每一个处理器都必须先按 `event.sender.id` 查
   * 归属表确认身份（见 main/plugins/surface-owners.ts），**不能信任任何参数里的插件标识**。
   *
   * 通道名统一前缀 `surface:`，而 electron 的 invoke 通道是全局命名空间 ——
   * 这一组必须与主渲染层的通道完全不重名，否则一个恶意的插件界面能直接调
   * 主渲染层的接口（那里面有 `window.oint.settings.write`）。
   * 前缀 + 归属表两道一起才成立：光有前缀只是命名，挡不住调用。
   */
  surface: {
    /** 界面报告"我画好了"（宿主据此撤掉骨架屏） */
    ready: "surface:ready",
    /** 界面请求关闭自己 */
    close: "surface:close",
    /** 插件私有 KV */
    storageGet: "surface:storageGet",
    storageSet: "surface:storageSet",
    storageDelete: "surface:storageDelete",
    storageKeys: "surface:storageKeys",
    /** 经宿主出站的 HTTP 请求（域名白名单 + 审计） */
    fetch: "surface:fetch",
    /** 写系统剪贴板 */
    writeText: "surface:writeText",
    /** 发系统通知 */
    notify: "surface:notify",
    /** 当前会话的工作目录（面板要靠它知道该看哪个仓库） */
    workspace: "surface:workspace",
    /** 执行一条白名单里的命令（需要 shell.exec 权限） */
    exec: "surface:exec",
    /**
     * 宿主 → 界面的**推送**通道。
     *
     * 方向与上面全部相反：上面是 `invoke`（界面 → 宿主 → 应答），
     * 这一条是 `send`（宿主 → 界面）。webview 里的页面**不能主动**给宿主发消息，
     * 所以它只能听。
     */
    event: "surface:event",
  },
} as const;
