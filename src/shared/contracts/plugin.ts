// 插件的双端共享契约（设置里的插件管理组件与主进程共用这一份形状）。
//
// 刻意与 docs/plugin-manager-modal-plan.md §5.1 一一对应：那份计划里定下的类型就是这里。
//
// 三条与既有契约对齐的口径：
//  - **来源沿用 SkillSource / SubagentSource 的原则**（`builtin` / `user`）：用户不需要关心
//    插件包住在哪个目录，「是不是应用自带的」才是 UI 上唯一要区分的事。`dev` 是开发期
//    直接引用本地目录的那一档，它必须单独一档 —— 因为它不进 installed/、卸载不删文件、
//    而且有文件监视，这三件事与另外两档的行为都不同。
//  - **权限的「档位」由主进程给**，渲染层只负责显示。风险的判据是宿主的能力面，
//    不是界面偏好；放在渲染层会让「同一个权限在两个地方显示成不同颜色」成为可能。
//  - **列表项里不带正文**（与 SkillInfo 同款）：插件的 README / 贡献物明细按需再取，
//    避免一次 IPC 把几十个插件的全部细节都搬过来。

/**
 * 宿主认识的**全部**插件能力。
 *
 * ## 这一份是唯一的真源
 *
 * 三处必须与它一致，任何一处漏了都会静默出错：
 *  1. **清单校验器**（main/plugins/manifest.ts）：表外的权限 = 校验失败。
 *     这一条是刻意的：规范写"未知权限必须失败"而不是"忽略"，因为静默忽略会让作者
 *     以为自己申请到了某个能力。**Oint 不抄 PI-Desktop 那个 `skills` 例外**
 *    （它缺权限时只跳过不拒绝）—— 一个会静默跳过的贡献点，作者无从知道它为什么没生效。
 *  2. **风险分档**（main/plugins/permission-risk.ts）：每一项都要有档位。
 *  3. **展示文案**（renderer/features/plugins/plugin-permissions.ts）：每一项都要有词条。
 *
 * 后两处各有一条测试断言"覆盖了这个列表里的每一项" —— 加权限时漏改会红，
 * 而不是界面上显示一个没有解释的英文 id。
 */
export const PLUGIN_PERMISSIONS = [
  // 界面
  "ui.panel",
  "ui.view",
  "ui.window",
  "ui.modal",
  "ui.theme",
  "notify",
  "storage",
  // 贡献物
  "skills.contribute",
  "prompts.contribute",
  "subagents.contribute",
  "commands.register",
  "agent.tool.register",
  // 文件
  "fs.read",
  "fs.write",
  "fs.delete",
  // 进程与出站
  "shell.exec",
  "shell.openExternal",
  "net.fetch",
  // MCP
  "mcp.server.local",
  "mcp.server.remote",
  // 介入
  "hostHooks.register",
  "clipboard.write",
  "session.read",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * **还没有执行点**的权限：清单收得下、权限卡列得出，但宿主侧今天不做任何事。
 *
 * ## 为什么需要这张表，而不是"等实现了再发布这个字段"
 *
 * 方案 §4.4 规则 8 的原话是"不要发布自己没实现的清单字段"，判据是**作者会不会照着
 * 文档写出一个不会生效的东西**。这七项里的 `fs.*` 恰好违反得最直接：作者文档
 *（`resources/skills/plugin-authoring/SKILL.md`）教作者声明"读/写/删文件 + 范围"，
 * 而插件侧**根本没有文件 API**（既没有 `window.oint.fs`，RPC 协议里也没有文件操作），
 * 范围更没有任何校验点。于是用户看到的是一句**做不到的承诺**。
 *
 * 真正的修法有两条，且都不必现在选：实现执行点，或把这几项从清单与作者文档里撤掉。
 * 在它们落地之前，界面必须如实标注 —— **不标注比这个缺口本身更糟**：
 * 用户会以为"我拒绝了 fs.write，它就写不了文件"，而带代码的插件仍然可以用
 * `require("node:fs")` 直接写（见 `PluginView.hasMain` 的说明）。
 *
 * ## 每一项为什么在里面
 *
 * - `fs.read` / `fs.write` / `fs.delete`：清单里有 `fs` 策略与范围校验，**但没有执行点**；
 * - `ui.view`：没有对应的视图槽（面板走 `ui.panel`，模态窗走 `ui.modal`，独立窗口走 `ui.window`）；
 * - `shell.openExternal`：桥里没有对应方法；
 * - `session.read`：没有任何"把会话内容给插件"的通道。
 *
 * （`hostHooks.register` 曾经也在这张表里 —— 钩子实现之后它有了执行点：
 * 声明 `hooks` 就必须有它，而钩子会真的被调用。)
 *
 * 这个集合是**纯展示判据**，不参与任何授予或拒绝 —— 宿主不会因为它而放宽什么。
 * 实现了某一项时把它从这里删掉即可（`plugin-permissions.test.ts` 钉着这份清单，
 * 逼着那次删除是有意的）。
 */
export const UNENFORCED_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "fs.read",
  "fs.write",
  "fs.delete",
  "ui.view",
  "shell.openExternal",
  "session.read",
]);

/** 这个权限今天有没有执行点（表外的权限一律算"有" —— 未知不等于未生效） */
export function isPluginPermissionEnforced(id: string): boolean {
  return !UNENFORCED_PLUGIN_PERMISSIONS.has(id);
}

/** 清单里 `extensions["dev.oint"]` 的名字，主进程与校验器共用一份 */
export const OINT_EXTENSION_NAMESPACE = "dev.oint";

/**
 * 宿主支持的清单版本。
 *
 * **agent-plugins 的版本用 `$schema` 表达，Oint 私有层的版本用 `apiVersion`。**
 * 两个都留着而不是合成一个：前者决定"这个包能不能被别的客户端读"，
 * 后者决定"Oint 的私有字段该怎么解释"。它们的变更节奏不一样。
 */
export const OINT_PLUGIN_API_VERSION = "1";

/** Agent Plugins 1.0.0 的清单 schema 标识（规范 §5.2 要求按它选本地校验规则） */
export const AGENT_PLUGINS_SCHEMA_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// ── 清单 ─────────────────────────────────────────────────────────────────────

/**
 * 清单里的一个界面声明。
 *
 * **三种形态**，宿主与权限各不相同：
 *  - `panel`：停靠在右侧面板里（宿主是渲染层的面板槽，权限 `ui.panel`）；
 *  - `modal`：应用内的模态窗（宿主是渲染层的 `Dialog`，权限 `ui.modal`）——
 *    与设置 / 插件管理那两个模态窗同一种观感，适合"配置一次就关掉"的界面；
 *  - `window`：独立窗口（主进程建 `BrowserWindow`，权限 `ui.window`；
 *    `shape: "widget"` 时透明、无边框、置顶 —— 桌面宠物那一类）。
 *
 * `width` / `height` 对三种形态都有效：面板用初始宽度、模态窗用对话框尺寸、
 * 窗口用窗口尺寸。
 */
export interface PluginSurfaceDecl {
  id: string;
  kind: "panel" | "window" | "modal";
  /** 显示名。对象形式要求同时给 en 与 zh-CN —— 见 §4.4 的契约 locale 规则 */
  title: string | { en: string; "zh-CN": string };
  /**
   * 图标 token，**不是文件路径**。
   *
   * 封闭集合：插件的图标画在宿主 chrome 里，宿主只认自己那几个 token
   *（照抄 PI-Desktop 的做法，也避开"插件自带 SVG"这一整类问题）。表外的 token
   * 降级为字母块，而不是拒绝加载。
   */
  icon?: string;
  order?: number;
  /** 相对插件根的 HTML 入口（`./ui/git.html`）；必须落在插件根内 */
  entry: string;
  shape?: "panel" | "widget";
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  resizable?: boolean;
  skipTaskbar?: boolean;
  /** 什么时候出现：`enable` 一启用就开，`command` 用户显式打开（缺省）*/
  openAt?: "enable" | "command";
}

/** 一条文件访问范围（与「开关」是两件事：权限说能不能，范围说能碰哪些） */
export interface PluginFsRule {
  root?: "workspace" | "pluginData" | "userSelected";
  scope?: string[];
  /** 只对 delete 合法：只能删自己写过的 */
  own?: boolean;
}

export interface PluginFsPolicy {
  read?: PluginFsRule;
  write?: PluginFsRule;
  delete?: PluginFsRule;
}

/**
 * 插件可以注册的钩子事件 —— **宿主真的会调的那几个**。
 *
 * ## 为什么只有三个（而 ZCode / Claude Code 有 30+ 个）
 *
 * 事件名沿用生态里已经收敛的那一套 PascalCase（Claude Code / Codex / VS Code 的
 * `PreToolUse` / `PostToolUse` 同名同义，DSH 的 hook 桥也是照这两个方言做的），
 * 但**只声明宿主今天真能挂上的点**：方案 §4.4 规则 8 的纪律 ——
 * 声明一个永远不触发的事件，等于让作者写完脚本之后怀疑自己写错了。
 *
 * 三个都挂在工具调用的同一条路上（宿主已有 `before_tool` / `after_tool` 两个挂点）：
 *
 * - `PreToolUse`：工具执行前。**唯一能阻断的事件** —— 宿主在权限门**之前**调它，
 *   所以它能拦下"本来会被批准"的调用，而它**永远不能放行**被宿主门拦下的调用
 *  （只加限制，不减限制）。
 * - `PostToolUse`：工具成功之后。只能观察与补充上下文。
 * - `PostToolUseFailure`：工具失败之后（同一个挂点，按 `isError` 分派）。
 *
 * **明确还没做的**（写在这里是为了让作者知道自己碰到的是"没有"而不是"写错了"）：
 * `SessionStart`、`UserPromptSubmit`、`Stop`、`PermissionRequest`。前三个各有更合适的
 * 内核挂点但还没接（会话起点 / `before_run` / `before_run_end`），最后一个要求
 * 钩子能参与审批决定，属于更晚的一步。
 */
export const PLUGIN_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number];

/**
 * 清单里的一条钩子声明。
 *
 * **钩子在清单里声明，不在 `ready` 里注册** —— 与工具/命令刻意不同。理由是这一条
 * 属于"用户装之前就该看见"的东西：`PreToolUse` 能拦住工具调用，用户要在装之前
 * 就在权限卡上看到"这个插件会介入工具调用"（`hostHooks.register`），而不是等它跑起来才知道。
 * 另外宿主也需要在**插件进程没起来时**就知道有哪些钩子存在，否则"进程崩了"会
 * 静默变成一个"没有钩子"的世界（对 fail-closed 的钩子来说那是安全侧失效）。
 */
export interface PluginHookDecl {
  /** 插件内部的钩子名（宿主按它分派）。`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，插件内唯一 */
  id: string;
  event: PluginHookEvent;
  /**
   * **大小写敏感的正则**，对"模型看到的工具名"求值（`bash` / `read` / `mcp__github__list`）。
   *
   * 省略 = 匹配全部（ZCode 的语义）。**非法正则在清单校验期就被拒** ——
   * ZCode 那边是"非法正则永远不匹配且静默"，那正好是最难查的一类（钩子注册了、不触发、没提示）。
   */
  matcher?: string;
  /**
   * 这个钩子**出错 / 超时**时怎么处置。只在 `PreToolUse` 上合法。
   *
   * - `closed`（默认）：按"拒绝"处理 —— 权限类钩子宁可挡住，也不要在自己坏掉时静默放行；
   * - `open`：当它不存在，继续走宿主的权限门 —— 给"只想记一笔"的观察型钩子用。
   *
   * 拒绝原因会写明是哪个插件、哪个钩子、失败原因为何，并提示"在插件管理里停用它可恢复"——
   * fail-closed 的代价必须能被用户一句话消除，否则一个坏插件会让工具全不可用而没人知道为什么。
   */
  failure?: "open" | "closed";
}

/** 这条钩子在出错时是否按"拒绝"处理（缺省按事件给：只有 PreToolUse 默认 closed） */
export function hookFailsClosed(decl: Pick<PluginHookDecl, "event" | "failure">): boolean {
  if (decl.failure !== undefined) return decl.failure === "closed";
  return decl.event === "PreToolUse";
}

/**
 * 校验通过之后的清单 —— **只有宿主真正会消费的字段**。
 *
 * 这与方案 §4.4 规则 8 的第二半是同一条纪律：**不要发布自己没实现的清单字段**。
 * PI-Desktop 的 `activationEvents` / `engines` / `entrypoints` 三个字段被文档化了、
 * 真实例子里也写了，但校验器的结构体里一个引用都没有 —— 作者会照着文档写
 * `onCommand:` 触发器，然后奇怪插件为什么没被激活。
 *
 * 所以这个类型里出现的每一个字段都必须有消费者；清单里出现但这里没有的私有字段
 * **直接判校验失败**（不是静默忽略）。
 */
export interface OintPluginManifest {
  /** Agent Plugins 根：展示名 */
  name: string;
  version: string;
  description: string;

  /** Oint 私有层（`extensions["dev.oint"]`） */
  /** 反向域名，全局唯一；也是数据目录名与审计作用域的键 */
  id: string;
  apiVersion: string;
  permissions: PluginPermission[];
  fs?: PluginFsPolicy;
  net?: { domains: string[] };
  /** 允许执行的命令白名单（裸命令名）。**有它就一定需要 shell.exec 权限** */
  shell?: { exec: string[] };
  /** 插件进程入口（相对路径）。没有 = 这个插件不含可执行代码 */
  main?: string;
  /**
   * 注册的钩子。**有它就一定有 `main` 与 `hostHooks.register`**（校验器两条都会强制）——
   * 钩子是宿主回调插件进程里的代码，没有进程就没人接。
   */
  hooks: PluginHookDecl[];
  surfaces: PluginSurfaceDecl[];
}

/** 一条校验问题。`path` 用点分路径指到具体字段，便于作者定位 */
export interface PluginManifestIssue {
  path: string;
  message: string;
  /**
   * 两级严重度。
   *
   * `warning` 只有一种来源：**Agent Plugins 根上的未知字段**。规范 §5.2 明确要求
   * "报告并忽略"（MUST report and ignore），所以那不是失败。
   * `extensions["dev.oint"]` 里的未知字段则一律是 `error` —— 对 Oint 作者来说
   * 它就是打错了（这条与 DSH 那个"非法配置键只 warn 后跳过"的教训同源）。
   */
  severity: "error" | "warning";
}

export type PluginManifestResult =
  | { ok: true; manifest: OintPluginManifest; warnings: PluginManifestIssue[] }
  | { ok: false; issues: PluginManifestIssue[] };

/**
 * 插件来源。
 *
 * 顺序即设置面板里「系统 / 用户」两页签的归属：`builtin` 进系统页签（随包分发、
 * 可禁用不可删除），`user` 与 `dev` 进用户页签。`dev` 不单独开页签 —— 它是用户
 * 自己挂的，与装进来的包在「谁负责它的生命周期」上是同一件事（都是用户）。
 */
export type PluginSource = "builtin" | "user" | "dev";

/**
 * 插件的运行状态。
 *
 * 与 PI-Desktop 的状态机对齐但**砍掉它没有实现的那几个**（`installed` / `enabled`
 * 是配置态，`enabled: boolean` 已经表达了；`discovered` / `validated` 是加载过程中的
 * 中间态，用户看到的应该是结果）。留下的六个都是**用户会看到不同界面**的状态：
 *  - `disabled`：用户关掉了，列表里灰着；
 *  - `loading`：正在加载（行内转圈）；
 *  - `running`：加载成功；
 *  - `load_error`：加载失败（有 error 可读）；
 *  - `invalid`：清单或文件校验失败（重试没有意义，要改包）；
 *  - `crashed`：跑起来之后崩了（可重载）。
 */
export type PluginState = "disabled" | "loading" | "running" | "load_error" | "invalid" | "crashed";

/**
 * 插件贡献物的计数摘要。
 *
 * 只给数量不给明细：列表行上要的是「这个插件给了我什么」的一眼印象，
 * 明细在详情里按需取。**这七个字段覆盖了插件能贡献的全部类型** ——
 * 少一个都会让「贡献物」那一行与实际不符。
 */
export interface PluginContributionSummary {
  panels: number;
  /** 模态窗界面（`kind: "modal"`）。**与面板分开计**：它在界面上的位置与观感都不同 */
  modals: number;
  windows: number;
  commands: number;
  skills: number;
  prompts: number;
  subagents: number;
  mcpServers: number;
  tools: number;
}

/**
 * 贡献物的**名字**（不是个数）。
 *
 * ## 为什么界面需要它
 *
 * 按方案 §4.8 的边界，插件贡献的技能 / 提示 / 子智能体**不进**设置面板里那三张列表
 * （它们归插件管，用户在那边既改不了也删不掉，显示出来只会制造"这里能管它"的错觉）。
 * 于是插件的行与详情页成了**唯一能看到它们的地方** —— 那里只有计数的话，
 * 「这个插件到底给我带来了什么」在整个产品里就没有答案。
 *
 * ## 为什么没有 commands / tools
 *
 * 那两项是**运行期**的事实：插件进程在 `ready` 里报给宿主（见 plugin-rpc.ts），
 * 磁盘上数不出来。工具的名字走 `plugin_tools` 那条通道给模型看
 *（`main/plugins/tools/plugin-catalog.ts`），命令名在命令面板里可见。
 *
 * ## 与 `contributionSummary` 的口径关系
 *
 * `counts = names.length`：同一份实现数出来的（见 contributions-paths.ts）。
 * 界面显示"技能 2"时，展开的那两行必须正好是两个名字。
 */
export interface PluginContributionNames {
  skills: string[];
  prompts: string[];
  subagents: string[];
  mcpServers: string[];
}

/**
 * 一条权限（供界面显示）。
 *
 * `scope` 是**范围**，与「开关」是两件事（方案 §4.5）：
 * `fs.read` 说能不能碰文件，`scope` 说能碰哪些；`shell.exec` 说能不能跑命令，
 * `scope` 说是哪几个命令。**文件类与命令类权限永远要把范围显示在旁边** ——
 * 一个孤零零的 `fs.write` 会让用户以为它能写整块盘。
 */
export interface PluginPermissionView {
  /** 权限 id（"ui.panel" / "shell.exec" / "fs.read" …） */
  id: string;
  /** 范围的可读形式（"workspace/**" / "git" …）；没有范围时缺省 */
  scope?: string;
  /** 风险档位。**由主进程给**，渲染层不自己推断 */
  risk: "low" | "medium" | "high";
}

/**
 * 一个插件命令（进命令面板）。
 *
 * 与工具的区别是**触发者**：工具由模型调，命令由用户点或敲。所以命令的
 * `description` 是写给**人**看的（工具那份是写给模型的）。
 */
export interface PluginCommandView {
  /** 全局唯一的调用 id：`<插件 key>:<命令名>` */
  id: string;
  pluginId: string;
  pluginName: string;
  /** 命令名（插件内唯一） */
  name: string;
  description: string;
}

/** 「打开界面」的结果。
 *
 * 三种形态的宿主不同，所以**开在哪里**这个决定要跨进程传回来：
 *  - `window`：主进程已经把独立窗口建好了，渲染层什么都不用做；
 *  - `panel`：**渲染层**要往右侧面板里加一个标签；
 *  - `modal`：**渲染层**要开一个模态窗。
 *
 * 为什么不让主进程连面板 / 模态窗一起开：两者的宿主都是渲染层的 React 组件，
 * 主进程没有它们的句柄。要在这里建就得发明一个"往渲染层里插组件"的机制，
 * 而右侧面板注册表与模态窗状态已经在做这件事了。
 */
export type PluginSurfaceOpenResult = { kind: "window" } | { kind: "panel" } | { kind: "modal" };

/**
 * 「某个界面被关掉了」的通报（主进程 → 渲染层）。
 *
 * **只覆盖宿主在渲染层的两类**（面板 / 模态窗）：它们的宿主是 React 组件，主进程
 * 只能请求渲染层收掉。`window` 不进这个类型 —— 那类窗口由主进程建、也由主进程关，
 * 渲染层不需要知道（类型上就没有它的位置，比在处理器里判一次更省事）。
 *
 * 触发场景目前只有一个：插件页面调 `window.oint.close()`。停用 / 卸载插件走的是另一条路
 *（渲染层从插件列表现算，见 use-plugin-panels 与模态窗的自守），不依赖这条事件。
 */
export interface PluginSurfaceClosedEvent {
  pluginId: string;
  surfaceId: string;
  kind: "panel" | "modal";
}

/** 插件提供的一个界面（面板 / 模态窗 / 独立窗口），供「打开界面」用 */
export interface PluginSurfaceInfo {
  id: string;
  kind: "panel" | "window" | "modal";
  title: string;
  /**
   * 要加载的 `oint-plugin://` URL —— **由主进程算好**。
   *
   * 为什么不让渲染层自己拼（它当然知道 pluginId 与 entry）：URL 的形状是
   * 协议处理器与归属表共同的契约（host 固定、路径段编码、拒绝查询串），
   * 两处各拼一份的话，改一处就会变成"页面 404"或"归属登记不上"——
   * 而这两种症状都不指向拼接代码。**一种形状，一个产地。**
   */
  url: string;
  /**
   * 这个界面要用的 Electron 分区。
   *
   * **每个插件一个**，不是所有插件共用一个。理由不是洁癖：共用分区意味着
   * 共用 `localStorage` / `IndexedDB` / cookie —— 插件 A 的页面能直接读到
   * 插件 B 存的东西，而那是真实的数据泄漏（与"跨插件读到一张图片"完全不是一个量级）。
   *
   * 由主进程给而不是渲染层自己算：主进程要为它装一套"全拒绝"的权限处理器，
   * 而**两处算出来的字符串必须逐字相同**（不一致的症状是权限阻挡悄悄失效）。
   */
  partition: string;
  /**
   * 清单里的初始尺寸（`width` / `height`，可能没有）。
   *
   * 三种形态都用它，但**含义随形态变**：面板是初始宽度、模态窗是对话框尺寸、
   * 窗口是窗口尺寸。宿主各处的兜底值不同，所以这里原样透传、不做缺省填充 ——
   * 缺省是展示层的事（面板不知道自己的宽度上限，窗口知道）。
   */
  width?: number;
  height?: number;
}

/**
 * 设置里的一行：配置 + 状态 + 展示元数据。
 *
 * 与 McpServerView 同一分层：**配置来自 settings / 磁盘，状态来自运行管理器**，
 * 两者在这里合并成「面板要的那一行」，避免面板自己拼两处真相。
 */
export interface PluginView {
  /** 反向域名，全局唯一；也是数据目录名与审计作用域的键 */
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  /**
   * 宿主能不能**删掉它的文件**。
   *
   * `false` 有两种：内置（住在 asar 里，删不了也不该删），
   * 以及**项目目录插件**（`<工作目录>/.oint/plugins/`，那是用户或模型写的源码）。
   *
   * 界面据此把「卸载」换成「打开所在目录」—— 「卸载」在这两处会意味着
   * "删掉你自己的文件"，与它在别处（删掉宿主拷进来的副本）不是一回事。
   * 一个点了只会报错的按钮比没有按钮更糟。
   */
  removable: boolean;
  /** 用户的启停选择（配置态）。与 state 是两件事：enabled 但 load_error 是完全可能的 */
  enabled: boolean;
  /** 当前实际状态（运行态） */
  state: PluginState;
  /** state 为 load_error / invalid / crashed 时的可读原因 */
  error?: string;
  contributions: PluginContributionSummary;
  /**
   * 贡献物的**名字**（技能 / 提示 / 子智能体 / MCP server）。
   *
   * 计数只说"有几个"，展开起来才是"是哪几个"。按方案 §4.8 的边界，插件贡献的技能
   * 不进设置面板的技能列表 —— 所以这里是**唯一**能看到它们的地方，只有计数等于没答案。
   */
  contributionNames: PluginContributionNames;
  /**
   * 这个插件注册的钩子（清单里 `hooks` 那一份，原样给界面）。
   *
   * 界面要逐条列出来，理由与"贡献物要列名字"同源但更硬：`PreToolUse` 能**拦住工具调用**，
   * 用户在做"装不装"的判断时必须看见"它会介入哪些调用"。ZCode 的插件详情页也是
   * 逐条列钩子的（那是我在对比里唯一建议照抄的界面细节）。
   *
   * 有效性不由界面判断：钩子是否真的会被调用取决于插件进程起没起来 ——
   * 那是 `state` 的事，与这份声明是两件事。
   */
  hooks: PluginHookDecl[];
  /**
   * 这个插件**带自己的代码**（清单里有 `main`）。
   *
   * 界面靠它决定要不要展示那句信任边界（方案 §4.11）：带代码的插件跑在一个
   * `utilityProcess` 里，那是**崩溃隔离**，**不是操作系统沙箱** —— 它拿得到完整 Node
   * 权限。也就是说权限表管得住的是"宿主交给它的能力"（界面桥、插件声明的 MCP server、
   * 工具调用），管不住它自己去 `require("node:fs")` 读不该读的东西。
   *
   * 不显示这句话比这句话本身更糟：用户会以为"我拒绝了 fs.write，它就写不了文件"。
   * 而**只对带代码的插件**说这一句：对声明式插件（只有技能/提示/MCP/server 声明）
   * 说它，只会让人以为所有插件都危险。
   */
  hasMain: boolean;
  permissions: PluginPermissionView[];
  /**
   * 相对「用户已批准的那一份清单」**新增**的权限 id。
   *
   * 升级时非空 —— 界面据此打「新」徽标。这是「升级不能静默扩权」的界面一半，
   * 另一半是清单与权限集一起做哈希绑定（方案 §4.10）。
   */
  newlyRequested: string[];
  surfaces: PluginSurfaceInfo[];
  installedAt?: number;
  updatedAt?: number;
}

/**
 * 一条诊断记录（诊断分栏用）。
 *
 * 三条来源分开而不是混成一个字符串：**用户要能按来源过滤，也要能一眼看出
 * 「这是加载失败还是运行时崩溃」** —— 两者的下一步动作完全不同（改包 / 重载）。
 */
export interface PluginDiagnostic {
  pluginId: string;
  /**
   * 单调递增的序号，由主进程在写入诊断时分配。
   *
   * **存在的唯一理由是给列表一个稳定的 React key**：诊断的其余字段都可能重复
   *（同一个插件在同一个毫秒里报两条同样的错是完全可能的），用它们拼 key 会让
   * React 把两行认成一行；而用数组下标当 key 是 lint 明令禁止的
   *（重排 / 插入时组件状态会串行）。序号让「每条诊断的身份」是宿主给的，不是猜的。
   */
  seq: number;
  level: "warn" | "error";
  /** 事件名（"load.error" / "crash" / "permission.denied" …），与审计口径一致 */
  event: string;
  message: string;
  at: number;
}

/** 安装/导入类操作的结果：用户取消时 canceled 为真，其余字段仍可用 */
export interface PluginMutationResult {
  /** 用户在文件/目录选择框里取消 */
  canceled: boolean;
  /** 变更之后的完整列表 —— 面板拿它就地替换，不必再拉一次 */
  views: PluginView[];
  /** 跳过/失败说明（路径越界、包超限、清单不合法…），直接显示给用户 */
  diagnostics: string[];
}

/**
 * 启停/卸载类操作的结果。
 *
 * **返回完整列表而不是 void**：与 IPC.mcp.* 的既有做法一致 —— 面板不必再拉一次，
 * 也不会出现「点了没反应」的中间态。一次操作可能连带影响别的行（比如升级时的
 * 依赖、同 id 覆盖），只回一行会让界面漏刷新。
 */
export interface PluginListResult {
  views: PluginView[];
  diagnostics: string[];
}
