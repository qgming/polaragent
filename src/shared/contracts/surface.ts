// 插件界面 ↔ 宿主的桥接契约。
//
// 这份类型**同时**被三处消费，所以它必须只有一份：
//  1. guest preload（src/preload/plugin-surface.ts）—— 暴露 `window.oint`；
//  2. 主进程的处理器（src/main/ipc/surface.ts）—— 实现它们；
//  3. 插件作者（将来的 `@oint/plugin-api` 类型包，或直接把这份文件拷进插件仓库）。
//
// ## 一套 API，两种界面形态
//
// 面板（`ui.panel`）与独立窗口（`ui.window`）拿到的**是同一套 API**。
// 分开两套会让"把面板改成窗口"变成一次重写，而那是插件作者最自然会想做的事
//（桌面宠物最初往往是个面板）。
//
// ## 身份不在参数里
//
// **没有任何一个方法接受 pluginId。** 插件是谁由主进程按 `event.sender.id` 查
// 归属表得到（见 main/plugins/surface-owners.ts）。把 pluginId 放进参数等于让
// 插件自报身份，而那正是这类桥最经典的漏洞。

/**
 * 宿主 → 界面的事件名。
 *
 * 这是**唯一的推送方向**：`<webview>` 里的页面不能主动给宿主发消息，
 * 除非有 preload 用 `ipcRenderer.sendToHost`。插件界面的所有主动行为都走
 * 下面的 invoke 方法，所有被动接收都走 `host.on`。
 *
 * ## ⚠️ 今天真正会推过来的只有 `theme` 一个
 *
 * 另外三个是**保留位**：通道、preload 的订阅机制、主进程的广播函数都在，
 * 但没有任何代码路径会发它们（全仓只有一处 `broadcastSurfaceEvent` 调用，发的是 `theme`）。
 * 把这件事写在这里，是因为"声明了却永远收不到"会让你去查自己哪里写错了 ——
 * 需要刷新时**不要**等事件：
 *
 * - `active`：插件面板切走时**会被卸载、切回来时重新加载**（右栏只有常驻面板
 *   —— 目前只有浏览器 —— 才保持挂载），所以"切回来"本身就等于页面重新初始化，
 *   不需要事件；独立窗口的失焦/聚焦也还没有接。
 * - `reload`：宿主重载插件时还没有推它。
 * - `config`：还没有插件级配置系统（等 `userConfig` 那一类机制落地）。
 *
 * 要刷新数据就自己定一个节奏（内置示例 `git-status` 是 5 秒轮询）。
 */
export type SurfaceEventName =
  /** 宿主主题变了（浅色/深色切换）—— 插件界面要跟着变，否则会有一块刺眼的白 */
  | "theme"
  /** 这个界面被激活 / 失活（面板切走、窗口失焦） */
  | "active"
  /** 宿主主动要求界面重载数据（用户在插件管理里点了「重载」） */
  | "reload"
  /** 插件的配置变了（将来接设置页） */
  | "config";

export interface SurfaceEvent {
  name: SurfaceEventName;
  payload: unknown;
}

/** 界面自己的信息 —— 插件常用它做标题、日志前缀、主题判断 */
export interface SurfaceInfo {
  pluginId: string;
  surfaceId: string;
  kind: "panel" | "window" | "modal";
  /** 插件清单里的显示名 */
  pluginName: string;
  theme: "light" | "dark";
}

/** `storage` 的取值类型：只允许 JSON 能表达的东西（它要落盘） */
export type SurfaceStoredValue =
  | string
  | number
  | boolean
  | null
  | SurfaceStoredValue[]
  | { [key: string]: SurfaceStoredValue };

/**
 * guest preload 暴露给插件界面的 API。
 *
 * 每个方法的失败都是**抛异常**（`ipcRenderer.invoke` 的 rejection），
 * 而不是返回 `{ok:false}`：异常在插件作者那边的调用栈里有位置信息，
 * 而返回值需要作者每次都记得判。桥接这一层的错误已经带了可读文案。
 */
export interface OintSurfaceApi {
  /** 界面自己的信息（同步，preload 在注入时就拿到了） */
  readonly info: SurfaceInfo;

  /**
   * 主动告知宿主"我画好了"。
   *
   * 宿主用它撤掉加载骨架屏。**不做成自动的**：页面 load 事件早于首屏渲染完成，
   * 用它当信号会让骨架屏在内容出现前就消失，看起来像闪了一下。
   */
  ready(): Promise<void>;

  /** 请求宿主关闭这个界面（面板：关掉标签；窗口：关窗） */
  close(): Promise<void>;

  /** 插件私有的键值存储（住在 `<dataDir>/plugins/data/<id>/storage.json`） */
  storage: {
    get(key: string): Promise<SurfaceStoredValue | undefined>;
    set(key: string, value: SurfaceStoredValue): Promise<void>;
    delete(key: string): Promise<void>;
    /** 全部键名（不返回值：插件通常只想要个清单，值可能很大） */
    keys(): Promise<string[]>;
  };

  /**
   * 监听宿主事件；返回取消订阅函数。
   *
   * 返回取消函数而不是 `off(name, handler)`：插件页面里
   * `on`/`off` 配对写错是最常见的泄漏来源，而返回的函数天然成对。
   */
  on(name: SurfaceEventName, handler: (payload: unknown) => void): () => void;

  /**
   * 请求宿主做一次出站请求（**不是**页面自己 fetch）。
   *
   * 为什么绕一圈：插件界面的 CSP 是 `connect-src 'none'`，它自己发不出请求。
   * 出站必须经过宿主的域名白名单与审计 —— 这是"审计过的出口"与"任意出口"的分界。
   *
   * 宿主执行时会逐条检查（判据见 main/plugins/net-guard.ts）：
   * 只允许 http/https、host 必须在清单的 `net.domains` 里、拒本机与内网地址、
   * **重定向逐跳检查**（只查第一跳等于没查）、响应体有上限（5 MB 字符）。
   */
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;

  /**
   * 写系统剪贴板（需要 `clipboard.write` 权限）。
   *
   * **只有写，没有读** —— 两个方向的风险不对称：写是插件往用户那边放东西，
   * 读是插件把用户的东西拿走（而剪贴板里可能是密码）。要读的话，那该是一次
   * 显式的新能力，而不是顺手加个方法。
   *
   * 单次上限 100 万字符：剪贴板是**全局共享**的，一次写入会覆盖用户自己复制的东西。
   */
  writeText(text: string): Promise<void>;

  /** 发一条系统通知（需要 `notify` 权限）。标题与正文各有 200 字符上限，超出会截断 */
  notify(title: string, body?: string): Promise<void>;

  /**
   * 当前会话的工作目录（**没有会话时是空串**）。
   *
   * 面板要靠它知道"该看哪个仓库"。它在会话切换时会变，所以要**按需读**而不是启动时读一次。
   */
  workspace(): Promise<string>;

  /**
   * 执行一条命令（需要 `shell.exec` 权限，且命令必须在清单的白名单里）。
   *
   * 这是插件界面唯一能读本地状态的通道 —— `fetch` 出不了本机，而 `storage` 只有它自己写的。
   * Git 状态、依赖清单、构建产物这类面板全靠它。
   *
   * 宿主侧的约束（不能靠插件自觉）：
   *  - 命令名必须命中清单里的 `shell.exec` 白名单；
   *  - **参数逐项传递，不经过 shell** —— 所以 `"; rm -rf /"` 只是一个普通参数；
   *  - `cwd` 必须在当前工作目录之内；
   *  - 默认 15 秒超时、最长 60 秒；stdout/stderr 各上限 512 KB（超了会截断并置 `truncated`）。
   *
   * **不抛异常表达"命令失败"**：退出码非 0 是正常结果（`git diff --quiet` 就用它表达"有改动"）。
   * 只有"这条命令根本不该跑"（没权限、不在白名单、cwd 越界）才抛。
   */
  exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }>;
}
