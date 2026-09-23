# Oint 插件系统实现方案

> **本文件是什么**：一份**可执行的实现方案**，不是调研综述。
> 它回答三个问题：(1) 别的产品怎么做（事实层，带一手来源）；(2) Oint 今天卡在哪（逐文件证据）；(3) 分几期、改哪些文件、每期的验收标准是什么。
>
> **与 `docs/plugin-system-report.md` 的关系**：那份是上一轮的调研报告，结论仍然大体成立，但它引用的 `docs/research/*.md` 证据文件**已经不在仓库里**（`docs/research/` 是空目录），且部分外部事实已过时（最明显的是 Codex：那份报告把 Codex 描述成「MCP + hooks」，而 `codex-rs` 现在有真正的插件系统 `core-plugins`）。本文件重新取证并把设计收敛成工程计划，**建议以本文件为准**。
>
> 时效：2026-09。所有外部结论标注证据等级：**【源码】**（读到的真实代码/规范原文）、**【规范】**（项目自己的规范文档）、**【推断】**（我基于前两者的判断，非原文）。

---

## 0. 摘要

### 0.1 四句话结论

1. **Oint 的底座已经是插件系统最需要的那层地基，只是从没被当"宿主"设计过。** 主进程独占 Agent 运行时、渲染进程零特权、类型化 IPC、路径守卫 + 三模式审批门 —— 这四样恰好是"插件能力网关"的全部零件。真正缺的不是安全机制，而是**注册表**：今天加一个右侧面板要改 5 个文件，加一个工具渲染器要改同一个 1610 行文件里的 4 处。

2. **不要照抄任何一家，尤其不要照抄 PI-Desktop 的"一种插件打天下"。** PI-Desktop 的插件模型是**单层**的：每个插件都是"一个 Node 进程 + 一块自带 HTML"。那套在它的架构里成立（自建 agent sidecar，插件 UI 跑在独立窗口里、只拿 `window.pluginBridge`）。Oint 的渲染层持有 70 个方法的特权桥且 CSP 禁止运行期第三方脚本，硬套会把最贵的成本花在最危险的面上。**Oint 应该按能力分三档**（见 §4.2），先把零风险的声明式那一档做完。

3. **最高性价比的一期不是"插件加载器"，是"注册表化 + 声明式贡献面"。** 插件能贡献技能 / 魔法提示 / 子智能体定义 / MCP server（全是**数据**，宿主自己执行）已经覆盖了真实生态里绝大多数插件包；而这条路的实现成本集中在 `resources.ts` 的三个目录解析函数上——**四个消费者会自动跟着走**。

4. **在写第一行插件代码之前必须先修六个既有缺口。** 它们今天不是漏洞（输入都来自用户自己），但在有第三方代码之后全部变成提权链。§6 给出文件级证据与修法，判据只有一条：**谁能控制那个字符串**。

### 0.2 建议的最小可行切片（MVP）

> **清单 + 能力默认拒绝 + 声明式四件贡献面（技能/提示/子智能体/MCP）+ 一个"插件"设置分栏。**
> **不开放**插件代码执行、不开放 fs 写、不开放网络，直到 §6 的缺口修完。

产出：用户能装一个 zip 技能包/提示包/MCP 包，在设置里看到它、启用/禁用/卸载它，并且模型下一轮就能用到它贡献的技能。

### 0.3 与既有报告的**结论修正**（八处）

| # | 上一轮的说法 | 本轮取证 | 影响 |
| --- | --- | --- | --- |
| 1 | Codex 的扩展面 = MCP + hooks + config | **Codex 有真正的插件系统**：`codex-rs/core-plugins` crate、`Feature::Plugins` 门禁、插件可贡献 MCP server、有 marketplace 与管理员策略 | 参照系从"三方"变成"四方"，且 Codex 的**管理员可 allowlist 每个插件的 MCP server** 是一条值得抄的机制 |
| 2 | 参照对象的清单都以 `plugin.json` / Agent Plugins 为标准 | PI-Desktop 用的是**私有 `manifest.json` + `schemaVersion: 1`**，字段远比 Agent Plugins 丰富（35 项权限、15 类贡献、fs/net 范围） | "清单标准化"的取舍要重新算：可移植层很小，私有层才是主体 |
| 3 | 报告未覆盖 | **Oint 的 `resources.ts` 三个解析函数各自已有四个消费者**，扩展插件目录是"改一处、四处生效" | P3 的成本远低于上一轮的估计，应当提前 |
| 4 | 报告未覆盖 | **清单形状正在跨厂商收敛**：Codex 直接读 `.claude-plugin/plugin.json` 与 `.cursor-plugin/plugin.json`，hook 引擎叫 `ClaudeHooksEngine`；中立标准在 `agent-plugins.org` | §4.4 规则 10 预留兼容位 |
| 5 | 报告未覆盖 | **`~/.oint/settings.json` 的读取今天就能被 `grep` 零确认完成**（§6 缺口一），且 `path-guard` **不做 realpath** | P0 的最高优先项 |
| 6 | 报告未覆盖 | **PI-Desktop 的权限规范与实现不一致**：规范写 "Deny by default"，实现是 **"清单里声明的权限在加载时自动授予"**（§2.1.4b） | **不要照抄它的授权默认值** —— 抄它规范**声称**的语义 |
| 7 | 报告未覆盖 | **真实生态已经存在**：线上市场 **31 个插件**，而**下载量第一的插件权限最小**（只有 `fs.read` + `ui.view`，1555 次下载） | §5 的 P3 不是"先做个简单的"，**它就是要做的那一类**（§2.1.12） |
| 8 | DSH 的"内核机制"被引用了但来源文件已丢失 | **本轮已复查到源码级**（cordis 随包带 `src/*.ts`）。结论：DSH 是"**全部信任**"那一端 —— 无能力系统、**刻意不做**完整性校验、插件与宿主同进程同权限；连它自己的 `node:vm` 沙箱 README 都写着"不是安全边界" | §2.2 重写。**Oint 取相反的一端，但仍抄它的六个内核机制**（§2.2.9） |

---

## 1. 调研方法与证据等级

| 路 | 对象 | 手段 | 置信度 |
| --- | --- | --- | --- |
| A | **本仓库 Oint** | 逐文件 `read` / `grep`，**未使用任何二手描述**；关键行号在下文逐条给出 | 最高 |
| B | **PI-Desktop**（`vastsa/PI-Desktop`，5283★，LGPL-3.0） | `api.github.com` + `raw.githubusercontent.com` 直接抓取：`docs/spec/07-plugins/` 全 16 篇规范、`docs/plugin-development.md` 作者指南 | 高（官方规范原文） |
| C | **DSH**（本机 `D:\DSH Desktop\resources\app\`，`dsh-plugin-desktop@2.0.13`） | 直接读本机安装产物：`package.json`、`cordis.patch.yml`、`node_modules/@deepseek-ai/*`；**cordis 与 `cordis-plugin-{loader,include,group,hmr}` 随包带完整 `src/*.ts`，已逐行复查** | 高（内核为 TS 源码，其余为未混淆的 runtime + JSDoc） |
| D | **Codex / Claude Code** | `codex-rs` 源码（`raw.githubusercontent.com`）、官方文档 | 中—高（见下） |

**必须如实告知的环境限制**：

- 本次会话 `web_search` 全程 **HTTP 401 不可用**（搜索端点的凭据无效）。所有外部结论均来自 `web_fetch` 直接抓取一手产物，**没有一条来自搜索摘要**。
- `developers.openai.com` 对本环境返回 **HTTP 403**（所有路径）。Codex 的结论因此改从 `codex-rs` 仓库源码取得，这反而比文档更硬。
- 因此第 2.2 / 2.3 节中标注 **UNVERIFIED** 的条目，是我明确没能取到的部分，不是"我认为如此"。

**证据等级标记**：**【源码】**真实代码 ｜ **【规范】**项目官方规范文档原文 ｜ **【推断】**我的判断。

---

## 2. 参照系统（事实层）

### 2.1 PI-Desktop —— 最贴近的参照物

产品自述（`api.github.com/repos/vastsa/PI-Desktop` 的 `description` 字段原文）：

> Local-first AI coding agent desktop: Electron + Rust host core + pi Agent Harness + user-installable plugins

它与 Oint 的关系：**同一个 pi 内核**（`@earendil-works/pi-agent-core`），但架构根本不同——PI-Desktop 是"Electron 外壳 + Rust host core + 独立 agent sidecar"，Oint 是"主进程独占 harness"。这个差异导致后面几乎所有的取舍分歧（§2.1.7）。

#### 2.1.1 插件单元与磁盘布局 【规范】

一个插件就是一个目录，最小形态（`docs/plugin-development.md` §4 原文）：

```text
my-first-plugin/
├── manifest.json      # 身份、入口、贡献、权限
├── main.js            # 跑在插件进程里的生命周期钩子
├── README.md
└── renderer/
    └── index.html     # 跑在隔离面板窗口里的 UI
```

**分发包里必须是可直接执行的 JS/HTML/CSS/资源 —— 宿主不装依赖、不编译 TypeScript**（原文：*"PI-Desktop does not install dependencies or compile TypeScript when it loads a plugin."*）。

**四种来源**（`05-plugin-lifecycle.md`）：`installed` / `dev`（开发目录直接引用，不拷贝） / `marketplace` / 内置（`apps/desktop/resources/plugins/*`）。

#### 2.1.2 清单 `manifest.json` 【规范】

强制字段只有五个：`schemaVersion`（必须 `1`）、`id`、`name`、`version`、`main`。`id` 的正式文法：

```
^[a-z0-9]+(\.[a-z0-9_-]+)+$      # 反向域名
```

完整字段（`02-plugin-manifest-schema.md` §2 的 TS 类型原文节选）：

```ts
type PluginManifestV1 = {
  schemaVersion: 1;
  id: string; name: string; version: string;   // version 是 semver
  description?: string;
  author?: string | { name; url?; email? };
  homepage?: string; repository?: string;
  icon?: string;                                // 相对路径
  i18n?: { [locale: string]: { name?; description?; safetyNotes? } };
  main?: string;                                // 插件进程入口
  ui?: PluginUiConfig;                          // 面板/窗口配置
  contributes?: PluginContributes;
  permissions?: PluginPermission[];
  fs?: PluginFsPolicy;                          // 每个文件权限能碰哪些路径
  net?: { domains?: string[] };                 // 出站白名单
  engines?: { piDesktop?: string };             // semver range
  entrypoints?: { onInstall?; onLoad?; onEnable?; onDisable?; onUnload?; onUninstall? };
  activationEvents?: string[];                  // onStartup / onCommand:xxx / onAgentMode / onWorkspaceOpen
  enabledByDefault?: boolean;
};
```

**i18n 有一条 Oint 必须注意的硬规则**（§3.1）：`en` 与 `zh-CN` 是**契约 locale**，两侧都必须提供 `name`/`description`；宿主按 app 语言取用，**缺省按字段回落到作者的原话**。原文的理由值得抄：*"A plugin is not required to translate itself into the other shipped shell locales, so `zh-TW` reads English rather than half a `zh-CN` guess."*

#### 2.1.3 15 类贡献点 【规范】

`PluginContributes` 的全部键（`02` §4，逐条抄录）：

| 键 | 需要权限 | 形态 |
| --- | --- | --- |
| `commands` | — | 命令（进全局搜索） |
| `agentTools` | `agent.tool.register` | 模型可调用的工具（JSON Schema + `risk: low\|medium\|high` + `timeoutMs`） |
| `skills` | `agent.prompt.inject`（**唯一例外：缺权限只是跳过，不拒绝加载**） | 相对路径或带元数据覆盖的对象 |
| `agentExtensions` | `agent.extension` | pi `ExtensionAPI` 模块（`16-trusted-extensions.md`） |
| `providers` | `provider.register` | **宿主拥有的模型 provider 行**（最多 8 个，`models` 1..64） |
| `settings` | — | 设置 schema，宿主生成表单（`string`/`number`/`boolean`/`select`/`json`/`shortcut`） |
| `themes` | `ui.theme` | `.css` 文件（≤256 KiB，最多 8 个） |
| `scenicThemes` | `ui.settings` + `ui.theme` | **纯数据、宿主渲染**的主题画廊 |
| `windowAppearance` | `ui.window.appearance` | 原生窗口背景色 |
| `mcpServers` | `mcp.server.local` / `mcp.server.remote` | 声明式 MCP server |
| `services` | `background.service` | 常驻服务（**每插件最多 4 个**） |
| `bus` | `bus.publish` / `bus.subscribe` | 插件间消息总线（有主题文法） |
| `views` | `ui.view` | **停靠在右侧工作面板**里的 HTML 视图 |
| `sessionSources` | — | 会话来源标记 |
| `globalShortcuts` | `keyboard.globalShortcut` | 全局快捷键（最多 8 条，必须指向已声明命令） |

> **一条对 Oint 极其重要的观察**：PI-Desktop 的 `scenicThemes` 是**唯一一个"纯数据、宿主渲染"的贡献类型**，规范里专门写了一句：*"Plugins provide neither Settings HTML nor CSS or JavaScript: the host renders the Extensions entry, cards, range control, and Apply action in its normal React tree."*
> **这正是 Oint 应该推广到所有 UI 贡献的形态**（见 §4.7）。

#### 2.1.4 权限：三档风险 + 带范围 【规范 + 源码】

**⚠️ 先看这一条：权限清单本身是三方不一致的。**

| 出处 | 数量 | 说明 |
| --- | --- | --- |
| `02-plugin-manifest-schema.md` §5 的枚举（**规范**） | **34** | 规范自己写着 *"Unknown permission = validation failure"* |
| 规范其余各篇（`03` / `13` / `16`）实际使用的名字 | **+5** | `agent.extension`、`session.read`、`agent.complete`、`models.list`、`ui.settings` —— **这五个不在枚举里，但别处都在用** |
| 运行时的 `PLUGIN_PERMISSIONS`（**源码**） | **39** | 以这个为准 |

**下面是并集（35 项，即枚举 34 + `agent.extension`），逐字抄录**：

```
ui.panel · ui.view · ui.theme · ui.window.appearance
clipboard.read · clipboard.write · notify
fs.read · fs.write · fs.delete
agent.tool.register · agent.prompt.inject · agent.extension
provider.register · net.fetch · net.websocket · shell.openExternal
mcp.server.local · mcp.server.remote · background.service
bus.publish · bus.subscribe · browser.cdp · desktop.control
ui.microphone · project.create · session.import
session.read.own · session.update.own · session.delete.own · usage.read
audio.capture.background · audio.playback.background · speech.adapter.register
keyboard.globalShortcut
```

**未知权限 = 校验失败**（不是忽略）。

风险分档（`plugin-development.md` §7 原文）：

| 风险 | 权限 |
| --- | --- |
| Low | `ui.panel`、`ui.view`、`ui.theme`、`notify` |
| Medium | `clipboard.read`、`clipboard.write`、`fs.read`、`shell.openExternal`、`background.service`、`bus.publish`、`bus.subscribe`、`audio.playback.background`、`keyboard.globalShortcut` |
| High | `fs.write`、`fs.delete`、`agent.tool.register`、`agent.prompt.inject`、`net.fetch`、`mcp.server.local`、`mcp.server.remote`、`audio.capture.background`、`net.websocket` |

**"权限"与"范围"是两件事，范围 fail-closed**（`02` §5.2 原文）：

```ts
type PluginFsPolicy = {
  read?:  PluginFsRule;
  write?: PluginFsRule;
  delete?: PluginFsRule;
};
type PluginFsRule = {
  root?: "workspace" | "userSelected";  // 默认 workspace
  scope?: string[];                      // 相对 root 的 glob（* 单段、** 跨分隔符）
  own?: boolean;                         // 仅 delete：只能删自己写过的
};
```

四条硬规则（原文）：

1. `fs` 块缺失、某个 mode 缺失、或 `scope` 为空 —— **都表示"没有常驻可达范围"，每次访问都落到运行期确认**（*"saying nothing grants nothing"*）。
2. **写与删不得使用整树通配**（`**` / `**/*` / `*/**` / `./*` 在校验期被拒），读可以。理由原文：*"the egress allowlist is what makes a broad read safe and nothing makes a broad write safe"*。
3. `root: "userSelected"` 免 scope —— 目录由用户在运行期通过 `pi.fs.requestDirectory()` 选，**句柄只活在内存里，插件进程退出即失效**。
4. `own: true` 只在 `delete` 上合法。

**出站白名单同样 fail-closed**（§5.3）：

- `net.domains` 只接受裸主机名（无 scheme / port / path），可带前导 `*.`；**裸 `*` 在安装期被拒**。
- **省略、空、或格式非法 = 完全没有出站**，无论 `net.fetch` 是否授予。
- 它是**宿主拥有的每一条出站路径**的唯一白名单 —— `pi.net.fetch`、**面板自己的 `fetch`/`<img>`/`<script>`/样式表**、以及远程 HTTP MCP 端点，全部受它约束。重定向**逐跳重新校验**。
- 原文：*"Bundle assets into the plugin rather than loading them from a CDN you would otherwise have to declare."*

**固定黑名单**（无论声明什么都被拒，`plugin-development.md` §6.5 原文）：`.env*`、SSH 与云凭据、`*.pem`、`.git/**`、以及 **PI-Desktop 自己的数据目录**；这些路径**也不出现在 `fs.glob` 结果里**。

#### 2.1.4b ⚠️ 规范与实现的四处背离（本节是本报告最需要小心的地方）

PI-Desktop 的**规范写得很严，但实现比规范松**。逐条列出来，因为它们直接决定"哪些能抄、哪些只能抄意图"：

| # | 规范怎么说 | 实现是什么 | 对 Oint 的含义 |
| --- | --- | --- | --- |
| 1 | 权限矩阵写着 `net.fetch` / `mcp.server.*` / `agent.prompt.inject` **"Deny by default"** | `04-plugin-security.md` §11 自认：*"**Declared manifest permissions are auto-granted at load time, subject to the user unchecking them at install**"*。代码实证：`const granted = grantedPermissions === undefined ? declared : …` —— **未记录用户答复时回落到清单** | **不要照抄它的授权默认值。** Oint 要的是规范**声称**的那个语义（未授予 = 不可用）。这是本方案里少数几处"抄文档而不是抄实现"的地方 |
| 2 | 信任绑定：本方案希望是"哈希绑定" | **PI-Desktop 的信任绑定在权限集上，不在代码哈希上**。grep 运行时没有 `digest`/`sha256`/`manifestHash` 的任何使用；授予是一个裸 `string[]`。唯一带代码强制上限的是**开发插件热重载**（新增权限**或放宽 fs scope** ⇒ `PERMISSION_DENIED`） | **Oint 应当做得比它严**：清单 + 权限集一起哈希绑定。这条**不是**照抄，是改进。**真正给出可用参照的是 Codex**：`hooks.state.<key>.trusted_hash` 是实装的（§2.3.1） |
| 3 | `fs` 的 `root` 合法值 | 规范写 `"workspace" \| "userSelected"`；**实现里根本没有 `pluginData` 这个 root** —— 插件私有目录是通过 `pi.plugin.getDataPath()` 拿的，**不参与 scope 声明** | **本方案 §4.5 早期草案里的 `pluginData` root 是错的，已改正**：插件的私有可写区不是一个可声明的 scope 根，而是宿主给的固定目录 |
| 4 | 清单字段 `activationEvents` / `engines` / `entrypoints` / `homepage` / `repository` / `icon` | **Rust 校验器的结构体里一个引用都没有** —— 这些字段被文档化了、真实例子里也写了，但**运行时完全惰性**（activation-event 门控实际不生效） | **一条硬教训：不要发布自己没实现的清单字段。** 作者会按文档写 `onCommand:` 触发器，然后奇怪为什么插件没被激活。Oint 的 §4.4 规则 8 要加一句：**清单里的每个字段都必须有消费者，否则校验期报 `UNSUPPORTED`** |

**另外一处值得知道的背离**：`.piplug` 强制 **store-only ZIP**（条目 method 必须为 0，`bail!("PLUGIN_INVALID: only store-compressed piplug supported")`），但这条**只写在 `10-plugin-devex.md` 与作者指南里，打包规范 `06` 里没有**。作者看规范 06 写代码 → 用普通 `zip` 打包 → 安装被拒，而原因文档里找不到。**这是"实现细节泄漏到作者体验"的第二个实例**（第一个是 §2.1.10）。

#### 2.1.4c 四道有序的 `fs` 闸门（可直接照抄的形状）【源码】

> **"a later gate can only refuse, never widen"**

| # | 闸门 | 细节 |
| --- | --- | --- |
| 1 | **权限** | 声明 ∩ 已授予；撤销后即使清单仍写着也立即失效 |
| 2 | **容器校验** | 对 root **与** target **都做 `realpath`**；工作区里的符号链接指向 `~/.ssh` 在这里失败；绝对路径与 `..` 拒绝；新建路径沿"最近的已存在祖先"解析；**路径不存在返回 `NOT_FOUND` 而不是"逃逸"** —— 原文理由：*"telling a plugin author with a typo that they tried to escape the workspace is a lie that costs them an afternoon"* |
| 3 | **黑名单（覆盖一切）** | 目录按**每一段**匹配：`.git` `.ssh` `.aws` `.gnupg` `.kube` `.docker`；文件按 basename 匹配：`/^\.env$/i`、`/^\.env\./i`、`/^\.npmrc$/i`、`/^\.netrc$/i`、`/^\.pypirc$/i`、`/^\.git-credentials$/i`、`/^id_(rsa\|dsa\|ecdsa\|ed25519)/i`、`/\.pem$/i`、`/\.p12$/i`、`/\.pfx$/i`、`/\.keystore$/i`；外加宿主保留路径，以及删除时的 root 自身 |
| 4 | **声明的 scope，否则原生确认** | `Deny / Allow once / Allow this session`；session 授予覆盖所在目录、**只在内存、随进程消失、不落盘**；**没有确认服务的宿主一律拒绝** —— 原话：*"a host that cannot ask must never assume yes"* |

**删除是特殊的一档**：`own: true` 走**写账本**（路径 + mtime；用户改过的文件*"就不再是插件的了"*）；走 `shell.trashItem` 而**不是 `rm`**；**永不递归**（非空目录 ⇒ `INVALID_ARGUMENT`）；**速率刹车 50 次 / 60 秒**，超限弹一次理由为 `rate` 的确认。理由原文：*"Scope answers 'may this file go'; the brake answers 'this many, this fast?', which is the only thing that separates a cleanup from a wipe."*

**`fs.glob` 也是读**：被拒路径**从结果里省略**，且 `node_modules`/`.git`/`.venv`/`__pycache__` 永不遍历。理由原文：*"A name is a read too: what the plugin may not open, it may not learn the existence of."*

`isWholeTreePattern` 的实现只有一行：`value.replace(/[*/.]/g, "") === ""`（把通配符与分隔符剥掉，什么都不剩就是整树）。

> **一处实现细节**：规范说 glob "matched case-insensitively"，但代码里 `fsGlobIgnoresCase()` **只在 `win32` / `darwin` 为真**。**Oint 应当显式选定一种并写进规范** —— 跨平台行为不一致是插件 bug 的温床。

#### 2.1.4d 内置插件的形态（与 Oint 的 `resources/` 模式完全同构）

PI-Desktop 的真实内置插件放在应用目录 `resources/plugins` 下，路径经环境变量 `PI_DESKTOP_BUILTIN_PLUGINS_DIR` 传给宿主；**每次启动从随包清单重建那一行，只有"启用状态"与"激活范围"沿用用户的选择**；并且**内置插件不能被卸载**（`PLUGIN_INVALID: a bundled plugin cannot be uninstalled; disable it instead`）。真实存在的两个：`pi.browser`、`pi.file-manager`。

**这与 Oint 现有的内置技能完全同构**（住 `resources/skills`、可禁用不可删、升级即整包替换）。所以 §4.8 的"插件贡献物归入 `builtin` 一档"不是新发明，而是**把 Oint 已有的内置资源语义扩展到插件**。

**目录布局（可直接对齐）**：

```
~/.pi-desktop/                       # 可用 PI_DESKTOP_DATA_DIR 覆盖；不是 Electron userData
├── plugins/
│   ├── installed/<sanitize_id>/     # 解包后的插件
│   ├── disabled/                    # 被停用的
│   ├── data/<sanitize_id>/          # 插件私有数据（含 settings.json）
│   ├── logs/<id>.log                # 按插件分文件
│   ├── imported/<slug>/src/         # 导入的 pi 扩展
│   ├── cache/download/  cache/backup/    # 暂存与升级备份
│   ├── market/catalog.json
│   └── registry.json                # 全部插件行
```



原文（`plugin-development.md` §1）：

> Plugin entry code runs in a dedicated Node process. Panels run in sandboxed, context-isolated Electron windows with no Node integration. Calls from either surface cross a host-owned permission gateway.

- 插件进程拿到的全局是 **`pi`**；面板窗口拿到的**只有 `window.pluginBridge`**，原文明确：*"The panel does not receive the global `pi` object. It receives only `window.pluginBridge`, and arbitrary Electron IPC channels are unavailable."*
- 两个表面**走同一个宿主权限网关**。
- 宿主侧实现文件被规范点名：`apps/desktop/electron/main/plugin-runtime.ts`。

**它自己承认的边界**（原文，加粗是规范里的）：

> **Trust boundary:** the permission model gates the `pi.*` host API and panel bridge. **It is not yet an operating-system sandbox for raw Node APIs used by a plugin entry process.** Load development plugins and third-party packages only when you trust their source.

【推断】这句话的含义是：插件进程能 `require("node:fs")` 绕过 `pi.fs.*`。PI-Desktop 的缓解是"核心能力根本不给插件进程"（会话、凭据、SQLite 都在 host core / Rust 侧），而不是 OS 级沙箱。

#### 2.1.6 生命周期、预算与恢复 【规范】

状态机（`05-plugin-lifecycle.md` §2 原文）：

```
discovered → validated → installed → enabled → loaded → running
                                          ↘ load_error / disabled / install_error / invalid
```

**今天真正实现的只有 `onLoad` 与 `onUnload`**（原文：*"Only `onLoad` and `onUnload` are fired today. Other lifecycle names in the manifest are reserved for the planned full lifecycle."*）。其余五个 hook 是**声明了但不会触发** —— 这是一个反面教材：清单字段与运行时行为不一致时，作者会以为 `onInstall` 生效了。

预算（原文数值）：

| 项 | 预算 |
| --- | --- |
| 模块求值 + `onLoad` | **15s** |
| `onUnload` | **5s**（退出时 1.5s） |
| 服务 `service.start` | **5s** |
| 插件工具执行 | **110s**（插件侧超时） |
| 退出时整场 teardown | 3s，之后直接 kill |

重启策略（原文数值）：退避 `1s, 2s, 4s, 8s, 16s`，上限 30s，**最多 5 次**，存活 60s 视为健康并重置；`autoRestart: false` 可整体退出重启；**手动 enable/disable 永远压过 supervisor**。

启动 recovery（§5）：只加载 enabled 的插件，**单个失败不影响其它插件与主应用**。

**贡献点注册是事务性的**（§7 原文流程）：

```
begin → 注册 commands/tools/skills/themes/MCP servers(懒连接) → commit → 启动常驻服务
```

中途失败：**回滚这个插件的全部注册**。目的原文：*"Avoid a half-loaded state where 'the command exists but the tool does not'."*

审计事件（§8）：`plugin.install/uninstall/enable/disable/load.success/load.error/unload/crash` + `plugin.service.*`。

#### 2.1.7 分发与信任 【规范】

| 项 | 事实 |
| --- | --- |
| 格式 | `.piplug` = **store-only（不压缩）ZIP** |
| 上限 | **2,000 文件 / 50 MiB**；拒绝符号链接；拒绝路径穿越 |
| 完整性 | SHA-256（打印给作者，写进 release 说明） |
| **签名** | **明确不是当前的信任原语**（原文：*"Signatures are not the current trust primitive. Package SHA-256 and explicit permission review are the implemented baseline."*） |
| 市场 | 独立仓库 [`vastsa/pi-desktop-plugins`](https://github.com/vastsa/pi-desktop-plugins)，目录是独立仓库，**放进主仓库不等于发布** |
| 发布 | `pi-plugin publish` 产出 `submission.json`：`schemaVersion:1` + `pluginId`/`version`/`channel` + **source pin（repository/ref/commit/path）** + artifact（sha256/size）+ 权限 + `idempotencyKey`；**中心会自己按 forge 重新解析源，不信任提交的值** |
| devkit | `pi-plugin init / check / pack / publish`；`check` 与安装器**共用同一套规则**（原文：*"using the same rules as installation"*） |
| 脚手架 | 四个模板：`panel-basic` / `agent-tool-basic` / `skill-pack` / `full-demo` |

**热重载永不放大权限**（原文，写得非常干净）：

> Adding a permission to a loaded development plugin does not take effect through hot reload: PI-Desktop stops the reload and asks the user to load the folder again so the new grant can be reviewed. **Widening `manifest.fs` counts as adding a permission for this purpose.** Removing permissions takes effect on reload.

热重载细节：300ms 防抖，忽略 `.git`/`node_modules`/`dist`/`target`/编辑器临时文件；流程 `unload → validate → load`；**语法错误只卸载坏版本，watcher 继续活着**；最多同时监视 16 个开发插件。

#### 2.1.8 配额（值得直接抄的一组数字）【规范】

| 对象 | 上限 |
| --- | --- |
| 技能 | 每插件 **32** 个，单文件 **128 KiB**，description **240 字符** |
| 主题 | 每插件 **8** 个，单文件 **256 KiB** |
| 常驻服务 | 每插件 **4** 个 |
| provider | 每插件 **8** 个，每个 provider 的 models **1..64** |
| 全局快捷键 | 每插件 **8** 条 |
| 包 | **2,000 文件 / 50 MiB** |
| 主题资源 | 合计 **4 MB** |
| 开发插件监视 | 同时最多 **16** 个 |

#### 2.1.9 错误码 【规范】

宿主 API 失败抛带 `code` 的 `Error`：`PERMISSION_DENIED`、`NOT_FOUND`、`INVALID_ARGUMENT`、`TIMEOUT`、`UNSUPPORTED`、`LIMIT_EXCEEDED`、`RATE_LIMITED`。

#### 2.1.10 明确不要抄的两条

1. **`.piplug` 强制 store-only ZIP**。后果是普通 `zip` 打的包被安装器拒绝，作者必须用官方 devkit —— **实现细节泄漏到作者体验上**。Oint 应当接受标准压缩。
2. **`agentExtensions` 把 pi 的 `ExtensionAPI` 原样开放给插件**。规范自己写着 *"It is not sandboxed. The module runs in the agent process with the same access as the agent's own tools."*，且用 jiti 加载，所以 `.ts` 免构建。在 PI-Desktop 里代价可控（agent 在 sidecar）；**在 Oint 里等同于把第三方代码放进持有 SQLite 句柄、API Key 与 IPC 网关的主进程**（见 §3.3 约束 C），并且会与 Oint 自己的权限门抢同一批钩子（见 §3.4）。

#### 2.1.11 传输与进程模型（值得整段照抄的部分）【源码】

PI-Desktop 的插件宿主实现（`apps/desktop/electron/main/plugin-host-process.mjs`、`plugin-runtime.ts`）里有 **14 条与 Oint 约束无关、可以原样搬的机制**（**下面逐条列出，不再指向外部报告**）：

1. **每插件一个 `utilityProcess`，不共享运行时**；子进程只持有 callable，**父进程持有全部能力**。
2. **自定义 `{t: ...}` 帧协议**走 `process.parentPort`，**不是 JSON-RPC**：

   ```
   parent -> child  { t:"init", id, pluginId, pluginPath, main, manifest }
   parent -> child  { t:"call", id, method, payload, invocationId? }   // command.run | tool.execute | service.start | service.stop | lifecycle.unload
   child  -> parent { t:"call", id, api, args, invocationId? }         // 宿主 API 请求
   parent -> child  { t:"cancel", invocationId, reason }
   *      -> *      { t:"res", id, ok, value } | { t:"res", id, ok:false, error:{code,message} }
   parent -> child  { t:"event", event, ... }                          // push，无应答
   child  -> parent { t:"log", level, message }
   ```

3. **两个不相交的方法集**：子→父是 `api` 字符串（走 allowlist），父→子是 `method` 字符串（switch 分发，**显式 `default: UNSUPPORTED`**）。
4. **`AsyncLocalStorage` 承载调用上下文** —— 嵌套的 `pi.*` 调用自动继承 `invocationId`，插件不用自己传。**这是"这些调用只在某次工具执行期间合法"得以强制执行的机制**。
5. **每次调用一个 `AbortController`**，以 `ctx.signal` 交给插件；`{t:"cancel"}` 帧既 abort 信号、又把该次调用的所有在途宿主请求以 `PLUGIN_TOOL_ABORTED` 拒绝。
6. **UI 代码走独立的桥**（`window.pluginBridge.invoke(channel)`），**不复用主 API**：固定且带权限门的 channel 表 + 一个 `onPanelInvoke` 逃生口通到插件自己的进程。
7. **权限门的判定顺序**：`声明 ∩ 已授予` → 容器校验（`realpath`）→ **黑名单（覆盖一切）** → 声明的 scope → 原生确认弹窗。
8. **"开关"与"范围"分开声明**（`manifest.fs` / `manifest.net.domains`），**缺失即 fail-closed**；整树通配读可以、写与删禁止。
9. **命名空间靠构造而不是靠信任**：强制前缀（`plugin_<safe>_<tool>`、`plugin.<pluginId>.<command>`、`plugin:<pluginId>:<themeId>`）。
10. **按表面给不同预算**，不用一个全局超时：load **15s**、hook **5s**、command **30s**、tool **110s**、dispatch **150s**。
11. **重载不得放大权限**：把新清单与批准时的上限比对，有新增就以 `PERMISSION_DENIED` 停下；移除立即生效。
12. **devkit 是 check/pack 的唯一实现**，CLI、agent 工具、GUI 都调它 —— 所以"`check` 通过"蕴含"安装通过"。
13. **图标用封闭 token 集，不接受插件自带 SVG**（图标画在宿主 chrome 里）。
14. **两种刻意相反的 "unsupported" 语义**：宿主 API 遇到未实现的能力**抛错**（`UNSUPPORTED`），而外来 SDK（pi `ExtensionAPI`）的未支持成员**存在、什么都不做、返回文档化的中性值、绝不抛异常**（每个成员只发一次诊断）。

> **本节的机制只解决 T1/T2 的一半 —— 另外一半必须自己设计。** PI-Desktop 的**规范里根本没有任何 CSP 指令清单**：它的面板隔离靠 `sandbox: true` + 每插件独立 partition + 一个 `webRequest` 出站过滤器 + 拒绝设备权限 + 拒绝 `window.open`。
> **Oint 不一样**：Oint 有一份**成文且被单测钉住**的 CSP（§3.3 约束 A）。这是 Oint 的**优势**（有明确的、可测的边界），但也意味着 §4.7 的 webview 孤岛必须**自己写那份 CSP**，没有现成答案可抄。

**三个宿主实现里的坑（照抄时要避开）**【源码】：

1. **`HOST_API_ALLOWLIST` 不是唯一闸门，只是 `default:` 分支的兜底。** 有显式 `case` 的 API（`commands.*`、`agent.registerTool`、`speech.*`、`project.create`、`models.list`、`session.*`、`usage.listTurns`、`agent.complete`、`net.websocket.*`、`keyboard.*`）**完全绕过那个 Set**，只由 `assertPermission` 把关。所以文档里"不在 allowlist 上 = 不存在"**只对没有显式 case 的 API 成立**。
   → **Oint 必须让闸门只有一条路径**：`allowlist 检查 → 权限检查`，且**不允许任何分支跳过 allowlist**。这种"两条路都能到同一个能力"的形状是审计的噩梦。
2. **面板桥在 preload 里没有 channel allowlist** —— `channel` 是一个自由字符串，真正的门是主进程里的**发送方身份**（`pluginIdForSender(senderId)` 查一张 `Map<pluginId, BrowserWindow>`）+ 一个 30 多分支的 switch。
   → 这个做法**其实比"固定 channel 表"更强**（身份不可伪造），但要把"身份优先于 channel"写进规范，否则后来者会以为 preload 那张表是边界。
3. **`AsyncLocalStorage` 的调用上下文是取消与身份的载体，不是参数。** 取消走一个独立的 `{t:"cancel", invocationId}` 帧（**不是**请求 id），同时 abort `ctx.signal` 并拒绝该次调用的所有在途宿主调用。
   → Oint 的 `session.read`（"只允许读当前这次工具调用所在的会话"）**只能**用这个机制实现 —— 让插件传 session id 等于让它读任何会话。

**宿主的 API allowlist 是一个扁平的 `Set<string>`**（`HOST_API_ALLOWLIST`，定义在 `plugin-runtime.ts` 第 453 行），**里面没有权限映射** —— 权限是散落在各 switch 分支里的 `assertPermission(loaded, "<perm>")` 调用。【源码】

**子进程环境变量白名单**（`child-process-env.ts`）：`PATH, SystemRoot, windir, TEMP, TMP, TMPDIR, LANG, HOME, USER, USERPROFILE`，外加 `PI_PLUGIN_ID` 与 `NODE_ENV`；**空值直接省略而不是设成 `""`**；**没有 provider key**。【源码】

**宿主 API 规模：23 个命名空间 / 92 个方法**（`packages/plugin-sdk/src/index.ts` 的 `PluginHostApi` 与运行时一致）。命名空间：`app` `themes` `plugin` `commands` `speech` `ui` `project` `workspace` `desktop` `fs` `agent` `models` `session` `usage` `services` `bus` `clipboard` `shell` `browser` `net` `audio` `keyboard` `events`。【源码】

**错误码的完整并集**（`03-plugin-api.md` §4 + SDK）【规范】：

```ts
type PluginApiError = { code:
  | "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_ARGUMENT" | "TIMEOUT"
  | "UNSUPPORTED"           // 计划中的表面，或 audio 这种没有设备后端的能力
  | "LIMIT_EXCEEDED"        // 某个每插件上限满了
  | "RATE_LIMITED"          // 某个滑动窗口用尽了
  | "CONFIRMATION_REQUIRED" // 危险操作没带 confirm:true
  | "INTERNAL"
  message: string }
```

**一条对 Oint 特别有用的能力**：`pi.session.getLlmContext()` 让**工具执行期间**的插件读取当前会话的 LLM 上下文（**只能用 in-flight 的那次执行，插件不能传 session id**；子智能体行被剔除；本次调用自身从尾部摘掉；合计上限 **200k 字符**）。【规范】

> **这一组里 Oint 最该抄的四条**：#2（帧协议）、#4（`AsyncLocalStorage` 调用上下文）、#7（权限门顺序）、#9（命名空间靠构造）。**#10 的数字也直接可用。**

#### 2.1.12 真实生态（这一节是"插件系统做完之后长什么样"的实证）

> **这一节的价值在于它不是设计文档 —— 它是一个已经在运行的市场的快照。**

**市场是真的、活的**：`https://plugins.aiuo.net/catalog.json` 返回 HTTP 200，**31 个插件**。子代理下载了 `in.memcode.memory-0.1.0.piplug`（14,955 字节），**SHA-256 与目录逐字节吻合**，解包后是 `main.js` + `manifest.json` + `README.md`。这是真实的 shipped `manifest.json`：

```json
{"schemaVersion":1,"id":"in.memcode.memory","version":"0.1.0","author":"Memcode","main":"main.js",
 "contributes":{"agentTools":[{"name":"memcode_save_memory","risk":"high",
   "schema":{"type":"object","properties":{
     "text":{"type":"string","minLength":1,"maxLength":20000},
     "idempotency_key":{"type":"string","minLength":1,"maxLength":256}},
     "required":["text"],"additionalProperties":false}}]},
 "permissions":["agent.tool.register","net.fetch"],"net":{"domains":["memory.memcode.in"]},
 "engines":{"piDesktop":">=0.2.0"}}
```

注意 `contributes.agentTools[].risk` —— **每个工具自带一档风险**，与目录级的 `review.risk` 是两个独立信号。**Oint 的 `assessToolRisk` 目前对未知工具名一律 `high`（§4.6）**；PI-Desktop 让插件自己声明 `risk` 而由宿主展示，是一个值得考虑的中间态（但**不能**让插件声明的 `low` 直接决定放行 —— 那是自我声明，不是安全依据）。

**真实插件的形态分布**（31 个里）：

| 观察 | 数字 |
| --- | --- |
| 只用 `ui.panel` / `ui.view`（纯 UI，零高危权限） | 11 个 |
| 带 `agent.tool.register`（给模型加工具） | 12 个 |
| 带 `agent.extension`（**跑在 agent 进程内、不沙箱**） | 6 个 |
| 带 `fs.write` / `fs.delete` | 2 个 |
| `net.fetch`（出站） | 5 个 |
| `desktop.control`（操作系统级操作） | 3 个 |

**下载量最高的是 `pi.file-manager`（1555 次，权限只有 `fs.read` + `ui.view`）** —— 也就是说，**真实生态里最受欢迎的插件是权限最小、只贡献一个只读视图的那一类**。这条对 Oint 的路线图有直接含义：**§5 的 P3（只读声明式贡献面）不是"先做个简单的"，它就是要做的那一类。**

**内置插件只有两个**：`apps/desktop/resources/plugins/pi.browser`（`ui.view` + `agent.tool.register` + `browser.cdp`）与 `pi.file-manager`（`ui.view` + `fs.read`）。**`plugins/` 与 `resources/plugins/` 两个顶层目录都是 404** —— 真实路径在 `apps/desktop/resources/plugins/` 下。

**目录格式（可直接对齐）**：

```jsonc
// 顶层
{ "schemaVersion": 1, "providerId": "official", "catalogId": "pi-plugin-center",
  "name": "…", "homepage": "…", "updatedAt": "…", "generatedAt": "…",
  "policyVersion": "2026.09.2", "artifactBaseUrl": "…", "plugins": [ /* … */ ] }

// 每个插件
{ "id", "name", "author": "字符串（不是对象）", "description", "categories", "downloads",
  "homepage", "repository", "i18n": { "<locale>": { "name", "description", "safetyNotes?" } },
  "publisherId", "readmeMarkdown", "safetyNotes", "trust": "community", "verified": false,
  "versions": [ /* … */ ] }

// 每个版本
{ "version", "url", "shasum", "sizeBytes", "permissions", "minPiDesktop": ">=0.14.0",
  "publishedAt", "changelog", "yanked",
  "fs": { "read": { "root": "workspace", "scope": ["**"] } },   // ← 规范里没写，但真实存在
  "provenance": { "sourceRef": "v1.0.1", /* … */ },
  "review": { "decision": "approved", "risk": "medium",
              "policyVersion": "2026.09.2", "reviewedAt": "…" } }
```

**四个用户可切换的源**（Oint 的 P6 可以直接照这个形状）：`official`（默认，`plugins.aiuo.net`，走平台 resolve 接口）／`github` 备份／`mirror` 备份／`custom`；环境变量 `PI_DESKTOP_PLUGIN_MARKET_URL` 覆盖一切；**缓存按源分别 keyed**（所以切回去是即时的，且**切换源永远不会改变正在校验的那个 checksum**）。

**两条对 Oint 的 P6 有直接价值的机制**：

1. **两级完整性记录**：静态源用目录里的 `shasum`，官方源用 resolve 接口返回的 `sha256`；**同时校验摘要与声明的字节数**；镜像**按顺序尝试、任何一个网络/HTTP/摘要/大小不符就换下一个**。实测响应里还有三个**未写进规范**的字段（`counted` / `reason` / `resolvedAt`）—— 说明这个协议在文档之外还在长。
2. **目录刷新必须在下载之前**：URL 与 checksum 来自同一份快照，否则"目录是新的、包是旧的"这种错配没人能查。**离线安装可以用上一次有效的目录，但仍然按那份目录的 checksum 校验字节。**

**审核模型（发布侧，不是客户端）**：`submitted → ownership_verified → source_pinned → scanning → building → ai_review → policy_evaluated → approved → published`；其中——

- **归属校验**用 GitHub App OAuth（PKCE）+ 安装授权 + 角色校验，原话：*"Being logged in is never sufficient"*；
- **源固定**：`ref` 必须是完整的 40 位 commit 或 `refs/tags/<tag>`，而且 *"The worker re-resolves the commit, tree, and archive itself. **Client-supplied hashes are inputs to compare against, never trusted values.**"*；
- **两趟独立 AI 复核**：`primary` 与 `critic`，critic **从不接收 primary 的输出作为事实**；
- **只有 policy evaluator 能产出 `approved`**，模型报告里的 `deterministicGates` / `publishable` / `approved` 一律视为**建议文本并忽略**；
- 发布时**包与重新生成的 `catalog.json` 在同一个 commit 里**（否则会出现目录指向一个不存在的包）；
- **人工审核不是主路径** —— *"People handle incidents, appeals, and policy exceptions."*

**信任等级**：`verified`（中心运营方）／`community`（归属校验 + 自动审核通过，由 policy evaluator 设定）／`unknown`（**客户端默认**）。*"A publisher cannot assert any tier… The client renders anything it cannot attribute to the center as `unknown` and never upgrades a tier based on catalog text alone."* —— 实测：**31 个插件全部是 `community`，`verified` 全部为 `false`，没有任何签名，没有任何 `yanked: true`，也没有任何数值化的安全评分**（只有分档的 `review.risk`）。

**插件中心的 UI 信息架构（Oint P6 要照这个做）**：

- **只有两个页签：`已安装` 与 `市场`。** 规范文档 07 与更新的 `04-ux/01-ui-ia.md` **互相矛盾**（5 页签 vs 2 页签），**以 2 页签为准**，原话：*"only two tabs: Installed and Marketplace … **MCP, Skills, and Subagents are not tabs or sections of Extensions.**"* —— **这一条直接印证了本方案 §4.8 的核心边界**：插件页不吸收技能/MCP/子智能体面板，反过来也一样。
- **已安装**：搜索 + 结果数；分组为**需要注意 · 有更新 · 已启用 · 已停用**；每行两行式（名称 / id / 版本）；**权限 chip 按风险着色**，收在原生 `<details>` 里；一个作用域触发器；加载错误就地显示。
- **市场**：搜索 · 分类 · 卡片网格。**卡片只画一个字母组合字形 —— 渲染器不做任何远程图片加载**（D169）。**Oint 应当直接照抄这一条**：它同时解决"插件图标从哪来"与"不要为了一个图标引入外部请求"两个问题，而且与约束 A 的 `img-src` 完全一致。
- **详情面板**（右侧、scrim + Esc + 点外部关闭）：权限**按风险分组**并用白话解释 · 作者 · **版本是可选择的列表，驱动一个 sticky 的安装/更新按钮** · 更新时间 · **安全提示告警块** · README markdown · 仓库/主页链接**在内置浏览器里打开，而不是系统浏览器**。
- **权限弹窗**：分 High/Medium/Low 三段，并**把相对已安装版本新增的条目标记出来**，让升级无法静默扩权。
- **安装进度**：阶段映射 `resolve|download|verify|install|enable` + `mirror {n}/{N} · {source}` + 字节进度条 + 速度；**只在 resolve/download 阶段可取消**，Escape 在这两个阶段被锁住（*"a download is not dismissed by accident, a finished install is"*）；成功 2 秒后自动消失（**除非鼠标悬停**）；失败保留对话框，把每个试过的镜像作为 `<details>` 列出（源 + 错误），外加**复制详情**与**重试**。



### 2.2 DSH（DeepSeek Harness）—— 本机可读的 Cordis 实现

**这一节的价值在于它就在本机、可以随时复查**，而不是它的分发层。

#### 2.2.1 它是什么 【源码】

本机 `D:\DSH Desktop\resources\app\package.json` 的 `name`/`description` 原文：

```json
{
  "name": "dsh-plugin-desktop",
  "version": "2.0.13",
  "description": "DSH Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin"
}
```

即：**整个 Electron 外壳本身就是一个 Cordis 插件**。依赖里有完整的 Cordis 家族：

```
@deepseek-ai/cordis                    4.0.2
@deepseek-ai/cordis-plugin-loader      1.0.3
@deepseek-ai/cordis-plugin-group       1.0.2
@deepseek-ai/cordis-plugin-include     1.0.7
@deepseek-ai/cordis-plugin-hmr
```

以及 ~150 个 `@deepseek-ai/dsh-*` 功能包，其中与插件直接相关的：

| 包 | 作用（【推断】，名字自明） |
| --- | --- |
| `dsh-host-plugin-inventory` | 宿主侧插件清单 |
| `dsh-client-ui-settings-plugin-inventory` | 设置里的插件清单 UI |
| `dsh-client-ui-settings-plugins` | 插件设置面板 |
| `dsh-cordis-host-runner` / `dsh-cordis-client-runner` | 宿主/客户端的 cordis 运行器 |
| `dsh-tool-cordis` | **给模型一个操作 cordis 的工具** |
| `dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-hooks-codex` | **兼容 Claude Code 与 Codex 的 hook 协议** |
| `dsh-typert-protocol` / `dsh-typert-registry` | 宿主 → 客户端的类型化 RPC |
| `dsh-client-ui-slots` | 客户端 UI 插槽 |
| `dsh-community-market` / `dshmarket` | **两个市场实现** |
| `dsh-invariants` | 版本/不变量校验 |
| `dsh-scope` | 作用域 |

#### 2.2.2 配置即组合 【源码】

`cordis.patch.yml`（本机原文，逐字）：

```yaml
# Desktop Host operations compose around the existing Web bundle. Compatibility
# mode keeps upstream ownership of the browser carrier and rendered UI.
- insert:
    - id: desktop-shell
      name: dsh-plugin-desktop
      config:
        mode: compatibility
    - id: desktop-terminal
      name: dsh-plugin-desktop/terminal
      disabled: !!js process.platform === 'linux'
    - id: desktop-diagnostics
      name: dsh-plugin-desktop/diagnostics
    - id: desktop-notifications
      name: dsh-plugin-desktop/notifications
    - id: desktop-pnpm
      name: dsh-plugin-desktop/pnpm
    - id: desktop-profiles
      name: dsh-plugin-desktop/profiles
    - id: desktop-updates
      name: dsh-plugin-desktop/updates

# A desktop launch has no terminal operator waiting for the Web readiness line.
- id: web-runtime
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: true
    trustedHosts: []
```

三件事值得注意：

1. **插件是"配置里的一行"**：`id` + `name`（模块说明符）+ `config` + `disabled`。插件顺序、启停、参数全在一份 YAML 里。
2. **`name` 支持子路径**（`dsh-plugin-desktop/terminal`），与 `package.json` 的 `exports` 一一对应。
3. **`!!js` 是真正的 `eval`**（`disabled: !!js process.platform === 'linux'`）。这让配置文件本身变成了可执行代码 —— **Oint 明确不要抄这一条**。

`package.json` 里还有 `dsh.client.inject`（客户端插件要注入哪些包）与 `dsh.bundle.patch`（指向 patch 文件）两个私有字段 【源码】。

#### 2.2.3 插件模型：没有 `start`/`stop`，生命周期就是依赖可用性 【源码】

> 本节已按子代理对 `node_modules/@deepseek-ai/cordis/src/*.ts` 的逐行复查重写（cordis 与 `cordis-plugin-{loader,include,group,hmr}` 是**整个安装里唯一随包带 TS 源码的包**；其余 `dsh-*` 包**零 `.d.ts`**，`lib/types/*.js` 是 `export {}` 空壳）。

插件只有三种形态（`cordis/src/registry.ts:92-133`）：

```ts
type Plugin<T> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>
// 解析规则：typeof plugin === 'function' ? plugin : plugin.apply
// 报错文案：'invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin
```

**`apply` 就是全部**。没有 `start`/`stop` 方法契约，生命周期是 **fiber 状态**（`fiber.ts:147-154`）：

```ts
const enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }
// PENDING 等必需服务 / LOADING 回调在跑 / ACTIVE 已加载并已 provide
// FAILED 回调或配置抛错 / UNLOADING 正在跑 disposer / DISPOSED 已移除且不可重启
```

**最关键的一条**（`fiber.ts:611-623`）：fiber 用自己的依赖的 fiber uid 拼一个 **epoch 字符串**；epoch 一变就重新加载或卸载。

> **依赖可用性就是生命周期。** 一个插件在它所依赖的**服务被替换**时会被自动卸载并重新 apply。

**`ctx.effect` 是零残留的唯一来源**：所有 disposer 由它收集，`_unload()` **按注册的逆序**执行，**逐个 catch**（一个 disposer 抛错不阻塞其余）。`effect` 接受一个 disposer、一个 disposer 的 Promise、或一个（同步/异步）**生成器**逐次 yield 若干 disposer。重复调用同一个 disposer 是 no-op。

**另外两条对 Oint 有直接价值的机制**：

- **`ctx` 是一个 Proxy**（`context.ts:74`），读取未注入的属性会**抛错**（`reflect.ts:144`）：`cannot get property "${prop}" without inject`。**没有"静默 undefined"这条路** —— 与 §4.9 的"闸门必须只有一条路径"是同一个思路。
- **`ctx.provide(name, value)` 把服务注册在"隔离作用域里的一个 symbol 键"上，不是按名字注册**（`reflect.ts:277-305`）。重复 provide 同一作用域直接抛错：`service "${name}" has been registered at <${...fiber.name}>`。

#### 2.2.4 配置即组合：顶层是**数组**，patch **整体替换** 【源码】

**没有 `plugins:` 这个键** —— 配置文件是一个**顶层 YAML/JSON 数组**（`cordis-plugin-include/src/index.ts:261-263` 强制）：

```ts
interface EntryOptions {
  id: string          // 在所在 entry 树里的稳定 id
  name: string        // 被 import 的模块说明符
  config?: any
  group?: boolean | null      // 标记为嵌套分组
  disabled?: boolean | null   // 本行与全部后代都不运行
  inject?: Inject | null
  intercept?: Dict | null     // 扩展
  isolate?: Dict<true | string> | null
}
```

**id 是分层的**，分隔符是 `:`（`config/tree.ts:8`），`Entry.id = 父 id + ':' + 自己的 id`。

**patch 语义（`cordis-plugin-include/src/index.ts:58-128`）**，四条要点：

1. `insert` 无 `id` → 追加到顶层；带 `id` → 目标**必须存在且是 group**，否则 warn + 跳过；
2. 插入的行会被加进 id 表，所以**后面的 patch 可以定位前面刚插入的行**；
3. **非 insert 的 patch 整体替换目标行的 `config`，不做深合并** —— 所以覆盖一个组合包的配置时必须**重述所有需要保留的键**；
4. **匹配不上的 patch 只 warn、绝不让启动失败**；但**空文件或纯注释的 patch 文件会让启动失败**，必须写 `[]`。

组合顺序（高者胜）：各 bundle 的 patch → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。

**`!!js` 是真的 `eval`**（`loader/src/config/utils.ts:5-9`）：

```ts
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) { return eval(expr) }
`)
```

于是 `disabled: !!js process.platform === 'win32'` 合法，配置值还能读注入的服务：`host: !!js ctx.webStartup.host ?? '127.0.0.1'`。**Oint 明确不要抄这一条**（从网上抄一段配置等于执行任意代码）。

#### 2.2.5 已经踩过的坑：非法键 warn 后静默跳过 【推断 + 上一轮记录】

上一轮调研在 `C:\Users\31645\.dsh\profiles\web\cordis.patch.yml` 发现过一处**不存在的键 `- override:`**。按上面的 patch 实现，**匹配不上的 patch 只 warn、继续执行** —— 那份文件里的配置从未生效，而界面上看不出任何区别。

**教训（对 Oint 是硬规则）**：插件的**非法配置键必须报错，不能 warn 后跳过**。"配置写错了"和"配置生效了但没效果"在界面上长得一样，这种 bug 可以活很久。这条已写进 §4.4 规则 8。

#### 2.2.6 插件清单的数据模型只有四个字段，而且**两个平面都只读** 【源码】

`dsh-host-plugin-inventory/lib/index.js` 的 `list()` 逐条产出：

```js
{ entryId, moduleName, enabled: !entry.disabled, fiberPhase }   // 只有这四个
const FIBER_PHASE = { 0:"pending", 1:"loading", 2:"active", 3:"failed", 4:null, 5:"unloading" }
```

**没有版本、没有描述、没有来源、没有依赖、没有错误详情。** `README.zh.md` 自己写明了两条能力边界：

> 「**无来源与修改能力** —— 服务不识别条目由哪个 bundle、profile 或 override 引入，也不能在任一平面启用、停用、添加或移除插件。」
> 「**两个平面都只读**：标签页展示全局与预设的启停状态但都不修改。」

**用户真正的启停手段是改 YAML**（`- id: <entryId>` + `disabled: true`），配合 `patchReload: live` 免重启；桌面 bundle 的启停则是**写一个 JSON 状态文件 + 重启**（`%APPDATA%\DSH Desktop\plugin-management\state.json`）。

> **对 Oint 的含义**：PI-Desktop 的插件行显示了权限、贡献物、服务状态、加载错误、更新状态（§2.1.12）；DSH 的插件行只显示四个字段。**Oint 要做的是前者** —— 因为 Oint 的插件系统要跑第三方代码，"这一行为什么失败 / 它要什么权限"是必须能回答的问题。

#### 2.2.7 市场：npm 权威 + **刻意不做任何完整性校验** 【源码】

两个市场随包发布，机器级二选一（`%APPDATA%\DSH Desktop\desktop-market\state.json` 的 `requested` 字段）。`dsh-community-market` 的流程：渲染层只发 `sourceRecordId` + `itemId` → 宿主解析 npm 身份 → `GET registry.npmjs.org/<pkg>/latest` → 要求**同名的稳定精确版本** + 合法的 `dsh.bundle.patch` → 一次性 `previewId`（5 分钟 TTL，绑定 profile）→ **宿主拥有 argv** 的 `desktopPnpm.run()` → 对账进 `dsh.profile.bundles`。

**它自己的 `SECURITY.md` 原文**（这一节是全文最该被 Oint 记住的反面参照）：

> *"Repository equality, deprecation metadata, lifecycle scripts, engine ranges, **integrity metadata**, and provider verification flags do not block the operation."*
> *"Installed plugins and their dependency trees run locally with the user's permissions. The Market intentionally does not claim to inspect their code or dependencies for malicious behavior."*
> *"These rules constrain authority and identity. **They do not make a third-party plugin safe.**"*

没有签名、没有 attestation、没有回滚、没有安装快照。目录里的 `capabilities` 字段**只用作搜索分面**。

**沙箱状况：真实插件代码基本没有沙箱。** 插件就是普通 npm 包，被 Cordis loader `import()` 进**同一个进程**，拥有完整 Node 权限。`dsh-fs-sandbox` / `dsh-pwsh-sandbox` 沙箱的是**模型的工具调用**，不是插件代码。唯一的沙箱是给"模型现场写的动态 Cordis 包"用的 `node:vm`，而它自己的 README 也写明：**「沙箱隔离全局变量，但不是安全边界…对待动态包要像对待 bash 访问一样」**、**「沙箱只用于约束诚实代码，并非安全边界」**。`dsh-scope` 同样：**「该原语用于路由受信任的同进程插件；它不是沙箱或权限边界。」**

> **一句话定位 DSH**：它是"**全部信任**"那一端 —— 无能力系统、无完整性校验（且是刻意的）、插件与宿主同进程同权限。这在"插件是你自己选的、跑在你自己的开发机上"的前提下是自洽的。
> **Oint 的处境不同**（§3.3 约束 B/C：渲染层持 70 个方法、主进程持凭据与 SQLite），所以本方案取的是与它**相反**的一端。**但它的内核机制仍然值得抄** —— 见下面 §2.2.9。

#### 2.2.8 hook 桥：兼容 Claude Code 与 Codex 的外部命令协议 【源码】

`dsh-hook-protocol` 的定位（`package.json:3` 原文）：*"Shared Claude Code / Codex hook wire protocol: matcher engine, stdin/exit-code/stdout codec, multi-hook merge, and hook/* session events"*。

**一个 hook 就是一条外部命令程序。只有 `type: 'command'` 会执行** —— `http` / `mcp_tool` / `prompt` / `agent` 四种 handler 一律**跳过并 warn**。

**两个方言的事件并集（7 个）**：

```
claude-code (7): SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · Stop · SubagentStart · SubagentStop
codex       (5): PreToolUse · PostToolUse · SessionStart · UserPromptSubmit · Stop
```

**退出码语义（这是整套里最值得抄的一段）**：

| 退出码 | 语义 |
| --- | --- |
| **2** | **阻断**，`reason` 取 stderr |
| **0** | stdout **只在以 `{` 开头时**按 JSON 解析；JSON 坏了就退化成纯文本 stdout |
| **其它** | **非阻断失败**（记日志，操作继续） |
| **spawn 失败** | **非阻断**，`exitCode: undefined` —— `runHook` **永不抛错** |

合并优先级：`deny\|block → 3`、`ask → 2`、`approve\|allow → 1`；第一个 `continue: false` 粘住 `stop`。

**配置读不出来时：一行 warning + 零个 hook 注册 + agent 照常启动**（`hooks-claude-code/lib/index.js:148-151`）。

两个方言的**刻意差异**也值得看：codex 的 stdin **不带结尾换行**、**不加任何环境变量**、payload 是 snake_case、**只有 `SessionStart`/`UserPromptSubmit` 把纯文本 stdout 当上下文**、`PreToolUse` **没有 `allow`/`ask` 分支**；claude-code 则加**恰好一个**环境变量 `CLAUDE_PROJECT_DIR`，`${CLAUDE_PLUGIN_ROOT}` 是**解析期字符串替换**而不是环境变量。两者的 `transcript_path` 都是空/null —— 会话日志是 zstd 压缩的，hook 脚本读不了。

**注册 API：没有。** `dsh-hook-protocol` 的全部导出就是十几个纯函数（`runHook`、`parseHookOutput`、`matchesMatcher`、`mergeHookOutputs`…）。一个"hook handler"不过是挂在 harness 的 waterfall / serial / emit 事件上的一个 Cordis 监听器。

#### 2.2.9 这一节里 Oint 真正该抄的六条

| # | 机制 | 为什么 |
| --- | --- | --- |
| 1 | **一切副作用皆 effect，卸载零残留**（逆序执行 + 逐个 catch + 生成器逐次注册） | PI-Desktop 靠"注册返回 disposer"达到同一目的；DSH 的形态更强（连 Promise 与生成器都收）。**Oint 的 `buildTools` 已经天然是这个形状**（工具是数组），但要给插件注册补上同样的保证 |
| 2 | **hook 的失败语义永不阻断调用轮**（exit 2 才阻断；spawn 失败也是非阻断） | 直接决定 §4.9 的 `failureMode`：**权限类 hook 默认 fail-closed，其余默认 fail-open** |
| 3 | **配置读不出来 → 零 hook + 主流程照跑** | 与 Oint 的 `loadAgentResources` 已有的"技能加载失败按无技能继续"完全同一条原则 |
| 4 | **非法配置键必须报错**（§2.2.5） | 已写进 §4.4 规则 8 |
| 5 | **patch 整体替换 config、不做深合并**；**空 patch 文件启动失败，必须写 `[]`** | 一个"空文件"与"文件没生效"在界面上长得一样 —— 这是 §4.4 规则 8 的同一条教训 |
| 6 | **fail-loud 启动**：启动失败是一行带标签的信息 + **非零退出码**，点名失败的插件，并列出从未启动的条目**连同它在等的服务** | 与 §4.9 的"不允许静默失败"同一条 |

**另外一条仅供记录、Oint 不采用**：DSH 的客户端插件是**运行期用 `<script src>` 动态加载**的（`window.__ModuleLoader__.load({ id, factory })`，惰性 CJS：脚本执行只注册工厂，一切副作用在工厂闭包里、到物化时才跑），而外壳本身是**构建期静态打包的 ESM**。这套在 DSH 里成立是因为它的渲染层没有 Oint 那样的 CSP 与特权桥；**对 Oint，这条路被约束 A 堵死**（§3.3），只能在 `<webview>` 孤岛里用类似的思路（§4.7 形态二）。

### 2.3 Codex · Claude Code · MCP

> **必须告知的环境限制**：`web_search` 全程 401，因此**没有引用任何第三方来源**；`developers.openai.com` 对本环境 **403**（含 `/llms.txt`），所以 Codex 的结论**全部来自 `main` 分支源码** —— 它对"实现行为"是权威的，但**不是稳定性契约**。

#### 2.3.1 Codex：确实有完整插件系统（对本轮结论的修正）【源码】

`openai/codex` 的 `main` 上现在有 `codex-rs/core-plugins`（lib `codex_core_plugins`）、`codex-rs/plugin`、`codex-rs/utils/plugins`、`codex-rs/hooks`、`codex-rs/skills`；`codex-rs/core/src/config/mod.rs` 引入 `PluginLoadOutcome` / `PluginsConfigInput`，并由 `Feature::Plugins` / `Feature::RemotePlugin` 门禁。有市场、有**带原子回滚的安装缓存**、有 semver 版本目录、有管理员 allowlist。

**插件清单**（`.codex-plugin/plugin.json`，JSON camelCase）字段：`name`、`version`、`description`、`keywords`、`skills`、`mcpServers`、`apps`、`hooks`、`interface`、`extensions`；旧的 `commands` 在安装期被**自动迁移成 skills**。`interface` 子键是一组**纯展示元数据**：`displayName`、`shortDescription`、`longDescription`、`developerName`、`category`、`capabilities`、`websiteUrl`、`privacyPolicyUrl`、`termsOfServiceUrl`、`defaultPrompt`（最多 3 条、每条 ≤128 字符）、`brandColor`、`composerIcon`、`logo`、`logoDark`、`screenshots`。**一切路径字段必须以 `./` 开头、不得含 `..`、必须落在插件根内。**

**磁盘布局**（`$CODEX_HOME`）：

```
plugins/cache/<marketplace>/<plugin>/<version>/     # DEFAULT_PLUGIN_VERSION = "local"；agent-plugin 默认 "1.0.0"
plugins/data/<plugin>-<marketplace>/                # 插件私有数据
plugins/data/agent-plugins/<sha256-prefix>/
.codex-remote-plugin-install.json                   # {"schema_version":1,"remote_plugin_id":"..."}
```

**`config.toml` 键**：`plugins` → `PluginConfig{enabled, mcp_servers}` 与 `PluginMcpServerConfig{enabled, ema_auth, default_tools_approval_mode, enabled_tools, disabled_tools, tools}`；`marketplaces` → `MarketplaceConfig{last_updated, last_revision, source_type, source, ref, sparse_paths}`；`hooks` → `HooksToml{<events>, state{enabled, trusted_hash}}`。

> **这一条是本报告里最值得抄的单条设计**（配置注释原文）：`PluginMcpServerConfig` **刻意不含传输设置** —— *"plugin manifests own how the MCP server is launched, while host config owns enablement, auth, and tool policy."*
> **即：插件清单拥有"怎么启动"，宿主配置拥有"开不开、怎么鉴权、允许哪些工具"。** 这正是 Oint 需要的形状，也是 §6 缺口五/六的根治办法。

**管理员策略**：`requirements.toml` 的 `allow_managed_hooks_only = true`（**只在 requirements.toml 合法，不在 config.toml**）；`PluginRequirementsToml` 通过 `filter_plugin_mcp_servers_by_requirements()` 过滤插件贡献的 MCP server。【源码】
→ 对本地优先的 Oint，它对应的是"**用户在设置里对某个插件逐项收紧**"，正是 §4.5 能力求交要表达的东西。

**hook 事件**（TOML 字面键，12 个）：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`。handler 按 `type` 分四种：`command{command, commandWindows, timeout, async, statusMessage, additionalContextLimit}`、`mcp_tool{server, tool, input, timeout, statusMessage}`、`prompt{}`、`agent{}`。【源码】

**hook 信任**：`hooks.state.<key>.trusted_hash` + `bypass_hook_trust` —— **哈希绑定信任在 Codex 里是实装的**。【源码】

#### 2.3.2 最大的战略发现：清单格式正在收敛

**Codex 会去读 Claude Code 与 Cursor 的插件。**

```
DISCOVERABLE_PLUGIN_MANIFEST_PATHS =
  [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]
  // 另外 Root 级的 plugin.json 会被优先检查，但仅当其 $schema 是
  // https://agent-plugins.org/schemas/1.0.0/plugin.schema.json

MARKETPLACE_MANIFEST_RELATIVE_PATHS =
  [".agents/plugins/marketplace.json", ".agents/plugins/api_marketplace.json",
   ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]
```

而且 Codex 的 hook 引擎类型名就叫 **`ClaudeHooksEngine`**，直接复用 Claude 形状的 `HooksFile` / `HookEventsToml` 结构体。跨厂商标准 **Agent Plugins 1.0.0**（`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`）只强制 `["$schema","name"]` 且 **`additionalProperties: false`**。

**一个真实的设计分歧**：Claude Code **刻意忽略它不认识的一级字段**（原文理由：*"practical to maintain one manifest that doubles as a VS Code or Cursor extension manifest, an npm package.json, or an MCPB/DXT bundle manifest"*），而 Agent Plugins 是 `additionalProperties: false`。这个不兼容**正是** Codex 把 root `plugin.json` 当作独立格式、再用 `.codex-plugin/plugin.json` 覆盖而不是合并的原因。

> **对 Oint 的含义**：**清单形状存在跨厂商兼容压力**。§4.4 的"极简内核 + 反向域名扩展位"设计要预留一条：一旦 `$schema` 是 `agent-plugins.org/...`，就按那个格式读，**不要试图合并两套字段**。

#### 2.3.3 Claude Code：极简清单 + 命名空间 + 安全上的一些硬拒绝 【一手规范】

- `.claude-plugin/plugin.json` **只强制 `name`**。组件路径字段：`skills`（追加）、`commands`/`agents`/`workflows`/`outputStyles`/`experimental.themes`（**替换**）、`hooks`、`mcpServers`、`lspServers`、`experimental.monitors`、`experimental.evals`、`userConfig`、`channels`、`dependencies`。
- 目录约定：清单在 `.claude-plugin/` 内，**组件目录在插件根**（`skills/ commands/ agents/ workflows/ hooks/hooks.json bin/ scripts/ .mcp.json .lsp.json`）。文档把"把组件目录嵌进 `.claude-plugin/`"直接列为 *"Common mistake"*。
- **命名空间**：技能 `/plugin-name:skill-name`；agent `my-plugin:review:security`；MCP 工具 `mcp__plugin_<plugin-name>_<server-name>__<tool>`；MCP hook 的 `server` 写作 `plugin:<plugin-name>:<server-name>`。
- **三条值得照抄的安全硬拒绝**：插件 agent 的 frontmatter 里 **`hooks`、`mcpServers`、`permissionMode`、`initialPrompt` 从插件来源会被忽略**；插件根之外的路径穿越被拒；依赖安装用 `--ignore-scripts` + 冻结 lockfile + 60s 超时。
- **hook 退出码语义**：**exit 2 阻断且 JSON 无法覆盖**；**exit 1 不阻断**。
- marketplace：`.claude-plugin/marketplace.json`，必填 `name` / `owner{name,...}` / `plugins`；支持 `metadata.pluginRoot`、`renames`（改名或置 `null`）、`strict`；**17 个保留 marketplace 名**。
- **它自己的安全定性**（原文）：*"Plugins and marketplaces are highly trusted components that can execute arbitrary code on your machine with your user privileges."* 它靠信任 + 管理员 allowlist（`strictKnownMarketplaces`、`blockedMarketplaces`、`disableSideloadFlags`），**不是能力沙箱**。

> **对 Oint 的含义**：`permissionMode` 这类字段**必须从插件来源忽略** —— 否则一个插件就能通过自己的 agent 定义把审批门关掉。Oint 的 `SubagentDefinition` 里没有 `permissionMode` 字段，这条今天天然成立，但要在**清单校验**里显式拒绝这类键（§4.4 规则 8）。

#### 2.3.4 MCP 作为扩展基座：它**不**覆盖什么 【一手规范】

**两条对旧材料的修正**：当前规范版本是 **`2026-07-28`**（不是 `2025-06-18`）；而且 **MCP 已经无状态** —— 原文 *"There is no negotiation handshake. Every request carries its protocol version, and the server accepts or rejects each request independently."* 版本与能力随每次请求走 `_meta`；**Roots / Sampling / Logging 在 `2026-07-28` 被 SEP-2577 废弃**（*"new implementations SHOULD NOT adopt it"*），三种客户端原语里只有 **Elicitation** 还活着。

| 领域 | MCP 覆盖？ | 精确的边界 |
| --- | --- | --- |
| **UI 贡献**（面板/侧栏/状态栏） | **否**，只有对话内联 UI | 唯一机制是 MCP Apps 扩展（`io.modelcontextprotocol/ui`）：宿主控制的沙箱 iframe 里**在对话中内联渲染 HTML**。**没有**面板/侧栏/状态栏这类贡献点 |
| 主题 / 配色 | **否** | 规范里唯一的 `theme` 是 `Icon.theme`（图标**背景**的 light/dark） |
| 用户斜杠命令 | **部分**（Prompts） | 但 MCP **没有 `/` 前缀约定、没有命名空间、没有与宿主内置命令的冲突解决** |
| 生命周期钩子 | **不在规范里** | Interceptors WG 已成立，**SEP-1763 仍是 Draft**，且其 charter **明确把"客户端特有的 hook 引擎"排除在外**。今天没有任何可用形态 |
| 快捷键 | **否** | 规范的功能枚举与官方扩展注册表里都没有 |
| 打包 / 依赖 / 版本 / 市场 | **部分，只有元数据** | MCP Registry 只托管元数据，**不托管代码、不解析依赖**，且原文说它 *"is **not** intended to be directly consumed by host applications"* |
| 设置 / 配置 UI | **否** | 最接近的是 elicitation 的表单模式：绑定在单次在途请求上的扁平 JSON Schema，不是持久设置面 |
| 权限 / 信任 / 沙箱 | **部分** | MCP 原文：*"**cannot** enforce these security principles at the protocol level"*。它规定的是宿主侧同意规则（调用前显式同意、注解*"untrusted unless they come from trusted servers"*）。**MCP 不沙箱化 server 进程本身** |

**结论（三方独立收敛）**：Codex 与 Claude Code 各自都是"**MCP 客户端 + 一套更丰富的插件清单**"，用后者补齐 MCP 拒绝指定的宿主 chrome 层，**然后又把 MCP server 重新暴露为插件的一个组件**（`mcpServers` / `.mcp.json`）。**MCP 是工具与上下文的基座；插件清单是其余一切的基座。** 而且**两者都没有对插件代码做能力沙箱**。

---

## 3. Oint 现状：扩展面与硬约束

> 本节全部为**逐文件一手证据**，关键行号可直接复查。

### 3.1 已经具备的"类插件"机制

| 机制 | 层级 | 第三方可扩展 | 证据 |
| --- | --- | --- | --- |
| **MCP server** | **配置级（唯一的真插件）** | ✅ | `shared/contracts/mcp.ts:43` `McpServerConfig`；`:129` `qualifyMcpToolName`（`mcp__<serverId>__<tool>`）；连接池 `pisdk/mcp-servers.ts:142` |
| 技能 | 文件级 | ⚠️ 只能加数据，零 UI | `SKILL.md`，三层目录 `pisdk/resources.ts:33` `resolveSkillDirs` |
| 魔法提示 | 文件级 | ⚠️ 同上 | `resources.ts:93` `resolvePromptTemplateDirs` |
| 子智能体定义 | 混合 | ⚠️ 部分 | `resources.ts:127` `resolveSubagentDirs`；内置 7 个写在代码里 |
| 网络搜索 provider | **编译期常量** | ❌ | `shared/contracts/web.ts:9`：`WEB_SEARCH_PROVIDERS = ["searxng","tavily","exa","serper","brave"] as const` |
| 右侧面板 / 设置分栏 / 工具渲染器 / 斜杠命令 / 搜索命令 / 快捷键 | **编译期** | ❌ | 见 §3.2 |

**一句话**：只有 MCP 是"外部代码 + 数据驱动"的真插件；技能/提示/子智能体是"数据驱动、零 UI 扩展"；其余全部硬编码。

### 3.2 加一个扩展点今天要动几处

这是"该不该做插件系统"最硬的论据 —— 它把"加功能很烦"量化成了文件数。

| 想做的事 | 处数 | 具体位置（已复查） |
| --- | --- | --- |
| **加一个右侧面板视图** | **5** | ① `renderer/stores/ui-store.ts:23` 的 `RightPanelView` 联合；② `:34-45` 的 `RIGHT_PANEL_VIEWS`（`as const satisfies`）；③ `features/right-panel/panel-meta.ts:16-34` 的 `RIGHT_PANEL_VIEW_META`（**穷举 `Record`，漏项直接编译失败**）；④ `features/right-panel/RightSidebar.tsx` 的分发 switch；⑤ `renderer/hooks/useGlobalShortcuts.ts` 的快捷键 switch |
| **加一个设置分栏** | **4 + 1 隐式** | ① `ui-store.ts:93-103` 的 `SettingsSection`；② `:109-121` 的 `SETTINGS_SECTIONS`；③ `features/settings/SettingsModal.tsx:39-54` 的 `SECTIONS`；④ `:66-89` 的 `renderPanel` switch；**隐式第 5 处**：`features/search/SearchModal.tsx` 用 `` t(`settings.${section}`) `` 拼键，**依赖"section id 恰好等于 i18n 键名"这条没写下来的约定** |
| **加一个工具渲染器** | **4，且都在同一个大文件里** | ① `features/chat/ToolParts.tsx`（**1610 行**）的 `TOOL_ICONS`；② 同文件 `TOOL_LABELS`；③ `features/chat/tool-presentation.ts`（**1328 行**）的 `resolveToolDetail` 有序 if 链；④ `ToolParts.tsx` 的 `ResolvedDetail` if 链；要"独立显示"还得逐条 `useAssistantToolUI` 注册（**hook 顺序固定，不能在循环里调**） |
| 加一条事件流 | 3 层 | `shared/contracts/api.ts` → `src/preload/index.ts` → `src/main/ipc/*` 并在 `ipc/registry.ts` 注册 |
| 加一个搜索命令 | 2 | `SearchModal.tsx` 的 actions Map + entries 数组 |

**当前规模（已复查）**：`shared/contracts/ipc.ts` 约 **100 个通道**；`src/preload/index.ts` **174 行**；`shared/contracts/api.ts` **307 行**；`ipc/registry.ts` 注册 **23 个域**。

### 3.3 四条决定架构的硬约束

#### 约束 A：CSP 把"运行期加载第三方渲染代码"这条路堵死了

`src/main/app/window.ts:96-117` `buildContentSecurityPolicy()`，生产形态实值：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
media-src 'self' data: blob:; worker-src 'self' blob:;
object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'
```

以**响应头**下发（`window.ts:128-138`）。没有任何 `unsafe-inline` / `unsafe-eval`，`connect-src 'self'` 断远程拉取，`object-src` 与 `frame-src` 都是 `'none'`（**iframe 沙箱路线也堵死**）。`window.test.ts` 用单测钉死了"prod 不含 unsafe"。

> **含义**：插件的 UI 代码**不能**从磁盘 `eval` 进主渲染进程，也不能远程注入。这与 PI-Desktop 的做法（每个面板一个独立 Electron 窗口 + 自带 HTML + `window.pluginBridge`）**不是同一件事** —— 那条路在 Oint 里只剩 **`<webview>`**（`window.ts:271` 已经开了 `webviewTag`）。

#### 约束 B：渲染层是特权进程，不是沙箱

`window.ts:260-272`：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` + `webviewTag: true`。渲染层没有 Node，但 preload 通过 `contextBridge` 暴露了整套白名单 API（`src/preload/index.ts`，174 行）。

关键在于**这些方法本身有没有守住边界**。`IPC.settings.write` 直接 `saveSettings(next)`，**没有任何写侧校验**（`src/main/ipc/settings.ts:10-11`）—— 渲染层可以写 `permissionMode: "full"` 且缓存立即更新，**审批链当场失效**。今天这没问题（渲染层代码是我们自己的）；**一旦有任何第三方代码进入渲染层，`window.oint` 就是全套权限**。

#### 约束 C：主进程是唯一特权进程，也是唯一不能放插件的地方

会话运行表（`pisdk/runtime.ts`）、SQLite 句柄（`session-store.ts`）、`safeStorage` 解密结果（`settings/store.ts`）、MCP 连接池（`pisdk/mcp-servers.ts:474` 的 `getMcpServers()` 单例）、浏览器 `WebContents`（`browser/service.ts`）、PTY（`terminal/service.ts`）—— 全在主进程。**插件跑进主进程 = 插件拿到这一切**，且一个死循环能让 agent 与 UI 一起挂。

#### 约束 D：i18n 门禁禁止运行期注入语言包

`en-US.ts` 用 `satisfies Messages` 做类型闭合（**漏译 = 编译错误**），`scripts/check-i18n.mjs` 抓的是**编译期字面量键**。因此**插件文案只有两条路**：

- (a) 插件自带 `i18n` 字段，宿主按当前语言取用（**与 PI-Desktop 的契约 locale 方案同构**，见 §2.1.2），缺省回落到清单里的默认名；
- (b) 内置插件在构建期并入语言包。

**绝对不要让插件传一个 i18n key 进来** —— i18next 缺键会原样返回键名，界面上会直接显示 `plugin.summary.title`。

### 3.4 pi 内核给的钩子面（0.87.0 实测）

> 上一轮报告基于 0.85.1，引用 11 个钩子。**本轮已就 0.87.0 复查，仍是 11 个**（`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`）。

```ts
export interface HookMap {
  before_run:        { event: { prompt; resources },              result?: { messages? } }
  before_drive:      { event: { operation: "run"|"compaction"|"navigation" }, result: void }
  before_run_end:    { event: { runId; messages },                result?: { followUp? } }
  transform_context: { event: { messages; systemPrompt },         result?: { messages?; systemPrompt? } }
  before_request:    { event: { model; step; attempt; streamOptions }, result?: { streamOptions? } }
  before_payload:    { event: { model; payload },                 result?: { payload } }
  after_response:    { event: { status?; headers?; message },     result?: { message? } }
  before_tool:       { event: { toolCallId; toolName; args },     result?: { args?; block?: { reason; terminate? } } }
  after_tool:        { event: { toolCallId; toolName; args; content; details?; isError; usage? },
                       result?: { content?; details?; isError?; usage?; terminate? } }
  before_compaction: { event: { reason; preparation; customInstructions? }, result?: { decline?; compaction? } }
  before_navigation: { event: { targetId; preparation; customInstructions? }, result?: { decline?; summary? } }
}

export interface Hooks {
  on<TName extends HookName>(name: TName, handler: HookHandler<TName>, options?: { id?: string }): () => void;
}
```

Oint 今天用了 3 个：`before_tool`（权限门）、`after_tool`（重复调用守卫）、`transform_context`（注入提醒）。`Hooks.on()` **返回 unsubscribe 函数**，所以"注册即得 disposer"这条纪律在内核层已经成立。

另有 `AgentHarnessOptions` 的 `toProviderMessages`、`entryProjectors`、`resources`，以及 `ToolContext` / `ExecutionEnv`（`agent-harness.d.ts:617-635`）。

> **含义**：第三方"策略插件"不需要新造钩子总线 —— pi 已经给了。Oint 需要造的只是**"谁能注册进来、注册进来之后受什么约束"**。这把工作量从"造一套中间件框架"降到"造一层信任与注册"。
>
> **但同时**：`before_tool` 的返回值**可以改 `args`**（`:556-557`）。让第三方改写工具参数、而 Oint 的审批发生在改写之前，就是一个干净的绕过。这是 §4.6 "不向插件开放 pi 钩子"的直接理由。

### 3.5 现在**没有**的东西（已 grep 确认）

- 全仓 `utilityProcess` / `MessagePort` / `MessageChannel`：**零命中**（只有 `@vitejs/plugin-react` 的注释）。
- 全仓 `setPermissionRequestHandler` / `setPermissionCheckHandler`：**零命中**。
- 没有任何插件相关的目录、合约或 IPC 域。

**结论：插件系统是彻底的绿地。**

### 3.6 一处可以直接复用的既有价值

`pisdk/resources.ts` 的文件头注释已经写明了它的存在理由：

> 为什么单独放一个文件：ipc 下的各列表通道（设置面板用）与 pisdk runtime（装配 AgentHarness 时把技能与提示模板注入 harness）必须看到同一批目录，否则「面板里显示的」和「实际注入的」会悄悄漂移。

三个解析函数各自已经有**四个消费者**：

| 消费者 | 技能 | 提示 | 子智能体 |
| --- | --- | --- | --- |
| 设置面板列表 | `ipc/skills.ts` | `ipc/prompts.ts` | `ipc/subagents.ts` |
| 运行时装配 | `runtime.ts:941` `loadAgentResources` | `runtime.ts:963` | `runtime.ts:1020` `loadSubagentCatalog` |
| **路径守卫允许根** | `runtime.ts:1091` `sessionAllowedRoots` | 同左 | 同左 |
| 单测 | `resources.test.ts` | 同 | 同 |

**这就是 P3 成本极低的原因**：把"插件贡献的技能目录"追加进 `resolveSkillDirs` 的返回数组，**四处自动跟着走**。

> ⚠️ 但有一处必须同步改：`sessionAllowedRoots`（`runtime.ts:1091-1112`）当前放行的是 `cwd` / `data/skills` / `data/prompts` / `data/subagents` / `tmpdir` + 内置资源目录。**插件目录不在里面时，症状是"目录存在却 0 个技能"**，而且 diagnostics 里只有一行 `list_failed`。这个坑 Oint 已经踩过一次（内置技能加进来时），注释里写得很清楚。

---

## 4. 设计

### 4.1 五条设计原则（按优先级）

1. **主进程是唯一的权限执行点。** 插件能做的一切特权操作，最终都收敛到主进程的一个 IPC 处理函数上，走既有的 `gateTool` / `validatePathAccess` / settings 校验。**插件运行时本身不做权限判断。**
2. **能力分档，默认拒绝。** 一个插件声明多少能力就只拿到多少；**没写的 = 没有**，不存在"通配默认"。
3. **Oint 拥有 UI 骨架，插件只提供内容。** 面板的尺寸、焦点、键盘作用域、错误边界由 Oint 掌握（直接来自约束 A）。
4. **插件的贡献物不进入既有的功能面板。** 技能面板不新增"插件"页签，MCP 面板不混入插件声明的 server。管理入口收敛到**插件自己的那一行**。详见 §4.8。
5. **失败必须是局部的、可见的。** 一个插件崩溃不能影响 agent；一个插件超时不能挂住一轮对话；每一个被拒绝的调用都要有一条可读原因，而不是静默失败。

### 4.2 能力三档（本方案与 PI-Desktop 最大的分歧）

PI-Desktop 是**单层**插件模型：每个插件 = 一个 Node 进程 + 一块自带 HTML。**Oint 不这么做**，理由不是审美：

- 它的插件 UI 跑在独立窗口里（`window.pluginBridge` + 沙箱窗口），Oint 的渲染层持有 70 个方法的特权桥且 CSP 禁止运行期第三方脚本 —— 要复刻得先造一套窗口/协议/桥，成本高而收益集中在一个次要面上。
- 它的插件进程能 `require("node:fs")`（规范自认），靠"核心能力不在插件进程里"兜底。Oint 的核心能力（SQLite、凭据、审批门）**本来就在主进程且不给插件进程**，这一条是天然成立的 —— 但只有把"插件到底能请求什么"显式列出来才有意义。

于是：

```
┌ T0 · 声明式（无代码）───────────────────────────────────────┐
│ 插件 = 一个目录 + oint-plugin.json + 数据文件                 │
│ 贡献：skills/ · prompts/ · subagents/ · mcpServers            │
│ 执行者：宿主（模型读到的还是同样的数据）                       │
│ 新增攻击面：0（这些数据模型今天已经在读）                      │
│ 成本：≈1 周    覆盖：技能包 / 提示包 / 子智能体包 / MCP 包      │
└──────────────────────────────────────────────────────────────┘
┌ T1 · 进程外工具与命令（有代码，窄 API）─────────────────────┐
│ 每插件一个 Electron utilityProcess + 类型化 RPC               │
│ 贡献：agentTools · commands · hostHooks（只读/只 block）      │
│ 宿主注入全局 `oint`，**不注入任何凭据**                        │
│ 工具调用经主进程 gateTool（与内置工具同一条门）                 │
│ 成本：≈1.5 周                                                 │
└──────────────────────────────────────────────────────────────┘
┌ T2 · UI（有代码，隔离渲染）─────────────────────────────────┐
│ 形态一（默认）：描述式 —— 插件返回 JSON，宿主用白名单组件渲染    │
│ 形态二（少数）：<webview> 孤岛 —— 独立 partition + 自定义协议  │
│                 + 自带 CSP，**不挂 preload、拿不到 window.oint**│
│ 成本：≈2 周                                                   │
└──────────────────────────────────────────────────────────────┘
```

**T0 是必做，T1 是主体，T2 是可选。** 一个插件可以只声明 T0。

### 4.3 进程模型

```
┌─ Renderer（sandbox，零特权）──────────────────────────────────┐
│  React 19 · 宿主渲染所有 UI 骨架与面板外壳                    │
│  插件 UI = 宿主白名单组件渲染的「描述」（T2 形态一）           │
│           或 <webview> 孤岛（T2 形态二，无 preload）          │
└───────────────┬───────────────────────────────────────────────┘
                │ preload（现有白名单 + 插件域通道）
┌───────────────┴───────────────────────────────────────────────┐
│  Main（唯一权限执行点）                                        │
│  ├─ 既有：AgentHarness / SQLite / gateTool / path-guard        │
│  ├─ PluginRegistry：清单加载、能力求交、生命周期、审计          │
│  └─ CapabilityBroker：插件来的每个请求 → 过门 → 转发            │
└───────────────┬───────────────────────────────────────────────┘
                │ MessagePort + 类型化 JSON-RPC
┌───────────────┴───────────────────────────────────────────────┐
│  PluginHost：每插件一个 utilityProcess                         │
│  ├─ 完整 Node，但**不注入凭据、不注入 OINT_HOME**               │
│  ├─ 只拿到 broker 给的窄 API 对象                              │
│  └─ 可被 kill() 做超时熔断                                     │
└───────────────────────────────────────────────────────────────┘
```

**为什么是 `utilityProcess`**：Electron 官方定位就是 *"host for example: untrusted services, CPU intensive tasks or crash prone components"*；有完整 Node（能跑 npm 依赖）、`MessagePort` 可用、可 `kill()` 熔断。

| 备选 | 判定 | 理由 |
| --- | --- | --- |
| 渲染进程 | 排除 | 见约束 B —— 等于重演 Obsidian 的处境 |
| 主进程 | 排除 | 见约束 C |
| `worker_threads` | 不作安全边界 | 只防卡 UI；Node 权限模型不继承到 worker |
| `node:vm` | 不作安全边界 | Node 官方：*"is not a security mechanism."* |
| WASM/WASI | **二期评估** | 最强隔离，但要自建 host 函数层；先把能力化 RPC 做干净 |

**必须如实告知的限制**：`utilityProcess` 内的插件仍能 `require("node:fs")`。这与 PI-Desktop 自认的缺口同源（§2.1.5）。三条缓解，按落地顺序：

1. **核心能力全部不给插件进程** —— 会话读写、SQLite、凭据、审批都在主进程，插件只能走 RPC 请求（天然成立）；
2. **插件进程不注入任何 API Key、不注入 `OINT_HOME`，也不继承主进程环境变量**（§6 缺口三/五的同一套白名单）；
3. 二期对"不可信插件"档位引入 WASM 或 OS 级隔离。

**并且要在插件安装页把这句话原样告诉用户** —— PI-Desktop 的做法值得抄（§2.1.5 的原文引述），隐瞒这条比缺口本身更糟。

#### 4.3.1 RPC 的六条具体形态（照抄 PI-Desktop，§2.1.11）

| # | 机制 | 为什么必须有 |
| --- | --- | --- |
| 1 | **每插件一个 `utilityProcess`，子进程只持有 callable，父进程持有全部能力** | 插件代码**永远拿不到宿主对象**，也 `require` 不到宿主模块 |
| 2 | **自定义 `{t:...}` 帧协议**走 `process.parentPort`，**不是 JSON-RPC 2.0** | 帧判别式比 JSON-RPC 的 `jsonrpc/method/params` 信封更窄、更难伪造；`cancel` / `log` 这类非请求帧也有位置 |
| 3 | **两个不相交的方法集**：子→父是 `api` 字符串（走 allowlist），父→子是 `method` 字符串（switch 分发，**显式 `default: UNSUPPORTED`**） | 一个集合放双向方法名，等于让插件猜宿主内部方法名 |
| 4 | **`AsyncLocalStorage` 承载调用上下文** | 嵌套的 `oint.*` 调用自动继承 `invocationId`，插件不用自己传 —— **这是"这些调用只在某次工具执行期间合法"唯一可强制执行的实现方式**（Oint 的 `session.read` 就需要它） |
| 5 | **每次调用一个 `AbortController`**，以 `ctx.signal` 交给插件 | 与 pi 的 `AgentHarnessTool.execute` 已有的 abort 语义对齐；`{t:"cancel"}` 同时 abort 信号与拒绝在途宿主请求 |
| 6 | **子进程环境是显式白名单** | 见 §6 缺口三/五。PI-Desktop 的白名单：`PATH, SystemRoot, windir, TEMP, TMP, TMPDIR, LANG, HOME, USER, USERPROFILE` + `OINT_PLUGIN_ID` + `NODE_ENV`；**空值省略而不是设成 `""`** |

**宿主 API 的 allowlist 做成扁平 `Set<string>`（点分名），权限映射单独放**（PI-Desktop 的形状）。理由：把 api→permission 塞进同一个结构，会让人以为"在表里 = 有权限"，而真实判定是 `声明 ∩ 已授予`。

### 4.4 清单 `oint-plugin.json`

设计目标：**极简内核 + 能力带范围 + 反向域名扩展位**。

```jsonc
{
  "$schema": "https://oint.dev/schemas/plugin/1.0.0.json",
  "schemaVersion": 1,
  "id": "dev.example.web-summarizer",     // 反向域名：^[a-z0-9]+(\.[a-z0-9_-]+)+$
  "name": "Web Summarizer",
  "version": "1.0.0",                     // semver
  "description": "把当前浏览器标签页抓成一份带引用的摘要",
  "apiVersion": "1",                      // 宿主插件 API 版本，第一天就带
  "engines": { "oint": ">=0.2.0" },       // 这是 DSH 缺的那一环

  "i18n": {                               // 契约 locale：en + zh-CN，缺省回落到扁平字段
    "en":    { "name": "Web Summarizer", "description": "..." },
    "zh-CN": { "name": "网页摘要",       "description": "..." }
  },

  "main": "./dist/main.js",               // 只有 T1/T2 插件才有；T0 插件可省
  "entrypoints": { "onLoad": "onLoad", "onUnload": "onUnload" },

  "contributes": {
    "skills":      [{ "path": "skills/release-notes.md", "id": "release-notes" }],
    "prompts":     ["prompts/"],
    "subagents":   ["subagents/"],
    "mcpServers":  [{ "id": "docs", "transport": "stdio", "command": "npx",
                      "args": ["-y", "@example/docs-mcp"],
                      "env": { "DOCS_TOKEN": { "setting": "docsToken" } } }],
    "agentTools":  [{ "name": "summarize_url", "description": "…",
                      "risk": "medium", "schema": { /* JSON Schema */ },
                      "timeoutMs": 110000 }],
    "commands":    [{ "id": "summarizePage", "title": "总结当前页", "keywords": ["summary"] }],
    "rightPanels": [{ "id": "summary", "title": { "en": "Summary", "zh-CN": "摘要" },
                      "icon": "file-text", "order": 10 }],
    "settings":    [{ "key": "maxChars", "title": "最长字符数", "type": "number", "default": 4000 }]
  },

  "permissions": ["skills.contribute", "prompts.contribute", "mcp.server.local",
                  "agent.tool.register", "ui.panel"],

  "fs":  { "read":  { "root": "workspace", "scope": ["**/*"] },
           "write": { "root": "pluginData", "scope": ["cache/**"] } },
  "net": { "domains": ["api.example.com"] },

  "activationEvents": ["onStartup", "onCommand:summarizePage"]
}
```

**八条校验规则（全部在安装/启用时同步执行）**：

1. `schemaVersion` 必须等于宿主支持的版本；`id` 匹配反向域名文法；`apiVersion` 必须在宿主支持列表内 —— **不支持 = 拒绝加载并给出可读原因，不是崩溃**。
2. `permissions` 每一项必须在宿主的已知能力表里；**未知能力 = 校验失败**（防止将来删除能力后旧清单静默通过）。**唯一的例外是 `skills`**：PI-Desktop 把它做成"缺权限只跳过不拒绝"，理由是"它早于权限门存在"。**Oint 不抄这个例外** —— 一个会静默跳过的贡献点，作者无从知道自己的技能为什么没生效。
3. **`fs.write` / `fs.delete` 的 scope 不得含整树通配**（`**` / `**/*` / `*/**` / `./*`），`fs.read` 可以。
4. **`net.domains` 不得含裸 `*`**；省略/空/非法 = 零出站。
5. `contributes` 里声明的每一项，必须与运行时实际注册的项**双向对齐** —— 声明了没注册 = 警告；**注册了没声明 = 拒绝注册**。这条把清单变成可审计的事实来源，而不是装饰。
6. `main` / 一切相对路径必须落在插件目录内（路径穿越校验），且 `main` **必须是已构建的 JS** —— 宿主不装依赖、不编译 TypeScript。
7. **贡献点需要对应权限，缺权限 = 校验失败**（逐条映射，见 §4.5）。**没有例外。**
8. **非法键必须报错，不能 warn 后跳过**（DSH 的教训，§2.2.3）。`unknown keys` 在根对象与 `contributes` 两个层级都要检查。
   **对称的一条：不要发布自己没实现的清单字段。** PI-Desktop 的 `activationEvents` / `engines` / `entrypoints` / `homepage` / `repository` / `icon` 六个字段被文档化了、真实例子里也写了，但**校验器的结构体里一个引用都没有** —— 作者会照着文档写 `onCommand:` 触发器，然后奇怪插件为什么没被激活。**Oint 的规则：清单里每个字段都必须有消费者，没有就报 `UNSUPPORTED`**（而不是静默忽略）。
9. **清单拥有"怎么启动"，宿主配置拥有"开不开、怎么鉴权、允许哪些工具"。** 这是 Codex 在 `PluginMcpServerConfig` 上的原话立场（§2.3.1）：*"plugin manifests own how the MCP server is launched, while host config owns enablement, auth, and tool policy."*
   **落到 Oint 的三条具体规则**：(a) 插件的 `mcpServers[].env` / `headers` **只能引用插件自己的 settings**（`{ "setting": "<key>" }`），**宿主的进程环境与 provider 密钥永不透传**；(b) 在插件行上可以逐 server 启用/停用，也可以逐工具 allow/deny；(c) 传输方式与命令由清单决定，**用户在设置里改不了它** —— 想换就禁用这个插件。
   这条同时是 §6 缺口五/六的**根治办法**：一旦"启动方式"只来自清单且被校验过（`command` 是单个可执行 token、不是 shell 串），那两个缺口就从"用户自担风险"变成"结构上不可能"。
10. **清单形状用 Agent Plugins 1.0.0 作为可移植核心，而不是"预留兼容位"。**
    **这一条已被后续调研升级**（见 `docs/research/agent-plugins-1.0.0.md`）：那个标准**已经发布且已被 10 个客户端实现**（VS Code / Cursor / GitHub Copilot / ChatGPT & Codex / Kiro / Grok Bot / OpenHands / Hermes Agent / OpenClaw / NanoClaw）。
    所以口径从"将来可能要兼容"改成"**现在就这么做**"：
    - 插件根用标准 `plugin.json`（只需 `$schema` + `name`），**`skills/` 与 `mcp.json` 用标准固定位置**，取消本方案早期的 `contributes.skills` / `contributes.mcpServers`；
    - Oint 自己的贡献面（`id`、`apiVersion`、`engines`、`contributes.*`、`permissions`、`fs`、`net`）**全部移进 `extensions.dev.oint`**；
    - **不认识的 `extensions.*` 命名空间按标准忽略且不校验其值**（标准 §8.1 是 MUST）；
    - 根上的未知顶层字段按标准"报告 + 忽略"，但**在 `oint-plugin check` 里升级为错误** —— 运行时宽松、作者工具严格。

    **三处成本极低的原因**：(a) Oint 的技能管线**已经是这个标准的一部分**（pi 的 `Skill` 类型注释原文写着 *"as suggested by agentskills.io"*，而那正是 Agent Plugins 委派的对象），技能侧**零改动**；(b) MCP 侧是一个约 40 行的适配器，插入点 `effectiveMcpServerConfigs` / `resolveMcpServerEntries` 已经存在；(c) `resources/**/*` 已经在 `electron-builder.yml` 的 `files` 与 `asarUnpack` 里，随包分发标准 schema **零配置改动**。

    **额外收益**：标准对 `command` 的硬要求（*"MUST preserve `command` as one token and pass `args` separately"*）**正好是 §6 缺口六要修的东西** —— 采纳标准等于把那个安全修复变成"为了合规"，更容易推动。

    ⚠️ **采纳时要记住的一条风险**（详见 `docs/research/agent-plugins-1.0.0.md` §1.5）：**格式很好，但机构很薄** —— 规范**没有 tag、没有 release**（"1.0.0" 可被 `main` 上任何编辑静默改变），最近 20 次提交**全部由同一个人**完成，且它把技能格式的全部权威委派给了**一个没有版本号、没有章程、单一厂商控制**的 Agent Skills 规范。所以：**把 schema 钉在一个 commit 上随包分发**（照抄标准自己 `specification-source.json` 的做法），**清单校验手写规则而不是直接喂官方 schema**（该 schema 有两处已知缺陷，其中一个会让 Go/Rust 校验器无法编译），并把"用哪个版本的发现规则"做成 `$schema` 驱动的开关。

### 4.5 能力表与范围

对齐 PI-Desktop 的三档风险，但**按 Oint 的真实能力面裁剪** —— Oint 没有主题系统、没有 widget、没有全局快捷键注册表，所以那几项直接不做。

| 风险 | 能力 | 授予时机 |
| --- | --- | --- |
| **Low** | `skills.contribute` · `prompts.contribute` · `ui.panel` · `notify` · `storage`（插件私有 KV） | 安装时告知，不单独确认 |
| **Medium** | `subagents.contribute` · `fs.read`（受限 scope） · `clipboard.write` · `session.read` · `mcp.server.remote` | **首次使用时确认一次** |
| **High** | `fs.write` · `fs.delete` · `agent.tool.register` · `commands.register` · `mcp.server.local` · `net.fetch` · `shell.openExternal` · `hostHooks.register` | **逐次确认**（或用户在插件行上显式改为"始终允许"） |

**能力求交公式**（照抄 PI-Desktop 的语义）：

```
运行时可见能力 = 清单声明 ∩ 用户已授予
```

用户在插件行上撤销一项后，**即使清单仍写着也立即失效**。

**每一次访问的五步判定顺序**（照抄 PI-Desktop，顺序本身是设计的一部分）：

```
1. 声明 ∩ 已授予        → 不满足即 PERMISSION_DENIED（最先，最便宜）
2. 容器校验（realpath） → 逃出插件根 / 逃出 scope 根即拒绝
3. 固定黑名单           → 覆盖一切，压过上面两步
4. 声明的 scope         → 不在 scope 内不是错误：弹一次运行期确认
5. 原生确认弹窗         → 危险操作额外要求 confirm
```

**第 3 步必须排在 scope 之前**：否则"用户在 `fs` 里声明了 `**/*`"就能读到 `.env`。PI-Desktop 的黑名单是 `.env*`、SSH 与云凭据、`*.pem`、`.git/**`、以及**它自己的数据目录**；**Oint 的黑名单要包含 `~/.oint/settings.json`、`permission-rules.json`、`sessions-index.json`、`sessions/**`、`plugins/grants.json`** —— 理由与 §6 缺口一完全一致。

**`realpath` 这一步不能省**：Oint 的 `path-guard` 今天**不做 realpath**（README 已自述），所以一个指向 `.env` 的符号链接可以绕过字符串前缀判断。**这是 P4 的硬前置**。

**范围对象**：

```ts
interface PluginFsPolicy {
  read?:  { root?: "workspace" | "pluginData" | "userSelected"; scope?: string[] };
  write?: { root?: "workspace" | "pluginData"; scope?: string[] };
  delete?: { root?: "pluginData"; own?: boolean; scope?: string[] };
}
```

三条 fail-closed 规则（照抄，理由见 §2.1.4）：

- `fs` 块缺失 / 某个 mode 缺失 / `scope` 为空 → **没有常驻可达范围**，每次访问都落到运行期确认；
- 写与删不得使用整树通配；
- `root: "userSelected"` 的句柄只活在内存里，插件进程退出即失效。

**固定黑名单**（无论声明什么都被拒，且不出现在 `glob` 结果里）——这一条对 Oint 尤其重要，因为 `grep`/`glob` 今天**不走路径守卫**（§6 缺口一）：

```
~/.oint/settings.json · permission-rules.json · sessions-index.json · sessions/** · plugins/grants.json
.env* · **/.ssh/** · **/*.pem · .git/**
```

**出站白名单**：`net.domains` 是宿主拥有的**每一条出站路径**的唯一白名单 —— 包括插件工具里的 `oint.net.fetch`、插件声明的远程 MCP 端点、以及 T2 webview 孤岛自己的 `fetch`/`<img>`/`<script>`。重定向逐跳重新校验。

### 4.6 插件能拿到什么

在插件进程里注入一个全局 `oint`，**方法全部是 RPC 代理，不是本地实现**：

```js
export async function onLoad(ctx) {
  // 工具：schema 由宿主校验，执行回主进程过 gateTool
  const disposeTool = await oint.tools.register({
    name: "summarize_url",                     // 清单里声明过的名字
    description: "Fetch a URL and return a short summary.",
    schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute({ url }, ctx) {
      const res = await oint.net.fetch(url);   // 走 net.domains 白名单
      return { content: [{ type: "text", text: summarize(res.body) }] };
    },
  });

  // 命令：注册后进 `/` 菜单与 Ctrl+K
  const disposeCommand = await oint.commands.register({
    id: "summarizePage", title: "总结当前页", run: async () => { /* ... */ },
  });

  // 面板：只提交数据，宿主渲染（T2 形态一）
  const disposePanel = await oint.ui.registerPanel({
    id: "summary", title: { en: "Summary", "zh-CN": "摘要" },
    render: (state) => ({ kind: "markdown", text: state.lastSummary }),
  });

  // 私有存储：只碰自己的 data 目录
  await oint.storage.set("lastRun", Date.now());

  // 宿主事件：**只读**，不能改 args，只能 block
  oint.events.on("session.tool-before", (e) => (e.toolName === "bash" ? { block: "本插件禁用 bash" } : undefined));

  return () => { disposeTool(); disposeCommand(); disposePanel(); };
}
```

**API 面的五条纪律**：

1. **一切注册返回 disposer**，宿主同时把它们挂在插件的生命周期上 —— `onUnload` 漏写不会导致残留。（pi 的 `Hooks.on()` 已经返回 unsubscribe，这条在内核层已经成立。）
2. **不暴露裸 `fs` / `child_process` / `net`。** 只给 `oint.fs.*`（受限 scope）、`oint.net.fetch`（白名单域）、`oint.shell.openExternal`。
3. **不暴露 `settings.write`。** 插件要配置就用 `oint.plugin.getSettings()/setSettings()`，落盘到自己的命名空间，**碰不到 `permissionMode`**（§6 缺口二）。
4. **不向插件开放 pi 的 `HookMap`。** 三个理由：(a) Oint 的权限门、重复调用守卫、提醒注入已经占了 `before_tool` / `after_tool` / `transform_context`，再挂第三方钩子会让**执行顺序变成一个安全问题**；(b) `before_tool` 的返回值**可以改 `args`**（`agent-harness.d.ts:556-557`，已复查），而 Oint 的审批发生在改写之前 —— 插件改写参数就是一个干净的绕过；(c) pi 在 0.85→0.87 之间还在改，第三方写死在这个接口上会随上游漂移而碎。**需要策略类扩展时，用宿主自己的窄钩子**：由宿主在 pi 钩子**之前/之后**执行，且**宿主钩子无权改 args、只有权 block**。
5. **`apiVersion` 第一天就带**，且宿主对不认识的 API 版本**拒绝加载并给出可读原因**，而不是让插件在运行时崩。

**工具在模型侧的呈现**：插件工具**必须命名空间化**，否则与内置工具撞名。方案（与 MCP 同款形状）：

```
PLUGIN_TOOL_PREFIX = "plugin__"
模型看到的工具名 = plugin__<pluginKey>__<清单里声明的 name>
权限规则前缀     = plugin__<pluginKey>__*
```

`pluginKey` = 插件 id 里的 `[^a-zA-Z0-9_]` 替换为 `_`（`__` 是分隔符，因此 key 内不得含 `__`）。**三段形状是刻意的** —— 权限层的 `matchesPermissionRule`（`permissions.ts:154-171`）已经支持 `*` 结尾的前缀匹配，所以"按插件授权 / 免审批"这条链路**一行都不用改**（与 MCP 走 `mcp__<serverId>__*` 完全同构）。

**风险分级**：`assessToolRisk`（`permissions.ts:119-126`）对**未知工具名一律返回 `high`** —— 所以插件工具天然落在"要审批"那一档，**这是正确的默认值，不要为插件工具加例外**。想让某个插件的工具免审批，走用户在插件行上点"始终允许"写 `plugin__<key>__*` 规则。

### 4.7 UI 扩展点

**改造前**：每种 UI 扩展点都是一张硬编码表 + 一个 switch（§3.2）。
**改造后**：一张 `ExtensionPoint` 注册表，**宿主内置项与插件贡献项走同一条路**。

| 扩展点 | 改造动作 | 插件能做什么 |
| --- | --- | --- |
| 右侧面板 | `RightPanelView` 从字面量联合改为 `string`；`RIGHT_PANEL_VIEWS` / `RIGHT_PANEL_VIEW_META` / `RightSidebar` 的 switch 三处合并为 `panelRegistry: Map<string, PanelDescriptor>`；**内置六项（review/files/file/subagent/browser/terminal）在启动时注册进去** | 注册新面板（`ui.panel`）。**面板外壳由宿主渲染** |
| 设置分栏 | 同上：`SettingsSection` + `SETTINGS_SECTIONS` + `SECTIONS` + `renderPanel` switch 合并为 `settingsRegistry`；**同时修掉 `SearchModal` 的拼键依赖** —— 改成读注册表里的 `labelKey` 字段 | 注册设置页，**只能读写自己的命名空间** |
| 工具渲染器 | 把 `ToolParts.tsx`（1610 行）的 `TOOL_ICONS` / `TOOL_LABELS` / `ResolvedDetail` 与 `tool-presentation.ts`（1328 行）的 `resolveToolDetail` if 链抽成 `toolRendererRegistry: Map<string, ToolRenderer>`；**顺带把这两个大文件拆开** | 为**自己注册的工具**提供渲染器。**不能**覆盖内置工具的渲染 |
| 命令面板 | `SearchModal` 的 actions Map + entries 数组合并为 `commandRegistry` | 注册命令；自动进 Ctrl+K |
| 全局快捷键 | `useGlobalShortcuts` 的 switch 改为查 `commandRegistry` 的 `shortcut` 字段 | 注册快捷键，**由宿主检测冲突并拒绝** |
| 斜杠命令 | `buildSlashCommands` 增加第三个来源：插件贡献的 prompts 目录 | 贡献 prompts 目录 |

**插件 UI 的两种形态**：

1. **描述式（默认，覆盖 80%）**：插件返回 JSON 描述，宿主用白名单组件渲染。**零 CSP 风险，零沙箱需求，插件的 UI 代码根本不进渲染进程。**
   这是 PI-Desktop 的 `scenicThemes` 已经验证过的形态（§2.1.3 的引文），只是把它从"主题画廊"推广到所有面板。
   白名单描述类型建议先做四种：`markdown` / `table` / `keyValue` / `list`，加一个 `action`（按钮 → 回插件的一个 channel）。
2. **`<webview>` 孤岛（少数）**：复杂面板走独立 partition 的 `webview`（Oint 已开 `webviewTag`，`window.ts:38-56` 有 `hardenWebviews`），配**自定义协议** `oint-plugin://<pluginId>/...` 加载插件自带 HTML、**自带 CSP `default-src 'none'`**。**不挂 preload** —— 所以插件 UI 拿不到 `window.oint`，只能通过宿主注入的 postMessage 桥与插件进程通信。
   ⚠️ **前置条件**：必须先补 `setPermissionRequestHandler`（§6 缺口四），否则 guest 页面按 Electron 默认可能直接拿到摄像头/麦克风/地理位置。

> **i18n 的硬约束**（约束 D）：插件文案只有两条路 —— 自带 `i18n` 字段（契约 locale `en` + `zh-CN`，缺省按字段回落到扁平字段），或内置插件在构建期并入语言包。**绝对不要让插件传 i18n key 进来。**

### 4.8 插件的贡献物**不进入**既有功能面板（核心边界）

这是本设计里最容易做错、也最需要先定下来的一条。

| 既有分栏 | 今天显示什么 | 插件化之后 | 插件贡献物去哪了 |
| --- | --- | --- | --- |
| 设置 → 技能 | 系统（内置 8 个）+ 用户 | **不加"插件"页签** | 只进系统提示的技能索引 |
| 设置 → 子智能体 | 系统（内置 7 个）+ 用户 | **不加"插件"页签** | 只进系统提示的子智能体索引 |
| 设置 → 提示模板 | 系统 + 用户 | **不加"插件"页签** | 只进 `/` 斜杠菜单 |
| 设置 → MCP | 用户自己配的 server | **不混入插件声明的 server** | 由宿主连接，工具以 `mcp__<server>__<tool>` 进工具表 |
| 工具图标/词条表 | 内置工具 | **只为插件自己的工具加渲染器** | 工具表 + 系统提示的工具指导 |

**一句话**：既有面板回答"**用户自己配了什么**"；插件贡献物回答"**模型这一轮能看到什么**"。两者是不同的维度。

**四条理由**：

1. **删不掉的东西不该出现在可管理的列表里。** 技能面板有"删除"按钮、MCP 面板有"移除"按钮。插件的技能与 MCP **不属于用户** —— 它们的生命周期跟着插件走。放进面板就得回答"在这里删了会怎样"（DSH 的经验：删了下次插件重载又回来）。**不显示，就没有这个问题** —— 与 Oint 今天对内置技能的处理完全一致（内置技能住 `resources/skills`、可禁用不可删除，所以它在"系统"页签里）。
2. **一个插件贡献 12 个 MCP server 时，MCP 面板会被淹没。** 面板是给人做配置用的；插件声明的 server 是给模型用的。
3. **技能的真正消费点在系统提示词。** Oint 今天的技能链路是 `resolveSkillDirs` 扫目录 → `loadAgentResources` 过滤禁用 → `formatSkillsForSystemPrompt` 生成索引 → 注入系统提示。**插件贡献的技能走完全相同的这条链**，只是多一个目录来源。
4. **管理插件的正确位置是插件自己的行。** 一个插件就是一行，行上显示：它贡献了什么（技能 3 / MCP 1 / 工具 2）、启用了没有、有没有加载错误。**要看细节就在那一行展开**，而不是去五个分栏里找它的碎片。

**三个必须给出的例外**：

- **(a) 全局禁用开关必须仍然有效。** `settings.disabledSkillNames` / `disabledSubagentNames` 的匹配范围**扩展到插件贡献物**（按 `name` 匹配，与今天一致），并且**插件行上的"禁用"直接把它的全部贡献从装配里摘掉**。这比"在技能面板里逐条禁用插件的技能"更符合直觉，也不需要新 UI。
- **(b) "系统 / 用户"二分法要延伸，不新增第三档。** 插件贡献物**归入 `builtin`**（它们与内置技能同性质：随包或随插件分发、不可在面板删除、升级即更新）。`SkillSource = "builtin" | "user"`（`shared/contracts/skills.ts`）**保持两个值不变** —— 新增 `"plugin"` 会让每个消费者的 switch 都要加分支，而三者的管理语义本来就是同一个。
- **(c) 网络搜索 provider 的表单暂不通用化。** `WebPanel.tsx` 今天把 5 家 provider 的表单硬编码了。**建议先保持现状**（内置 provider 享有内置待遇），把"插件声明 settings schema → 宿主生成表单"作为独立的一件事，不要和插件系统捆绑。**但要在文档里写清楚"这是内置插件的特权"**，否则第一个第三方 provider 插件就会问"为什么我不能有自己的表单"。

**判定方法**（写进代码注释）：**这块 UI 的主语是谁？**"插件管理"的主语是插件 → 可以；"技能管理"的主语是用户技能 → 不可以。

### 4.9 生命周期、错误隔离与降级

```
discovered → validated → installed → enabled → loaded → running
                                          ↘ load_error / invalid / disabled / crashed
```

- **事务性加载**：`begin → 全部注册 → commit → 启动常驻服务`。中途失败**回滚该插件的全部注册**，消除"命令在但工具不在"的半加载态。
- **按表面给不同预算**（照抄 PI-Desktop 的数字，不要用一个全局超时）：

  | 表面 | 预算 |
  | --- | --- |
  | 模块求值 + `onLoad` | **15s** |
  | 每个宿主钩子 | **5s** |
  | 命令 `run` | **30s** |
  | 插件工具 `execute` | **110s** |
  | 宿主侧派发总预算（包住上面的 110s） | **150s** |
  | `onUnload` | **5s**（应用退出时 1.5s / 插件，整场 teardown 3s） |

  超时 → `kill()` 插件进程 → 标 `crashed`。**`onUnload` 是 best-effort** —— 插件自己的清理绝不该成为"应用退不出去"的原因。
- **错误码用一个封闭并集**（照抄并裁剪，与 pi/工具层的错误语义对齐）：

  ```ts
  type PluginApiErrorCode =
    | "PERMISSION_DENIED"      // 声明 ∩ 已授予 不满足，或黑名单命中
    | "NOT_FOUND" | "INVALID_ARGUMENT"
    | "TIMEOUT"                // 宿主侧超时
    | "UNSUPPORTED"            // apiVersion 里存在但本版宿主没实现
    | "LIMIT_EXCEEDED"         // 每插件配额满了
    | "RATE_LIMITED"           // 滑动窗口用尽
    | "CONFIRMATION_REQUIRED"  // 高危操作缺确认
    | "INTERNAL";
  ```

  另需三个**插件专属**的终态码：`PLUGIN_DISABLED`、`PLUGIN_CRASHED`、`PLUGIN_TOOL_ABORTED`（用户停止本轮时在途调用被拒）。
- **闸门必须只有一条路径。** PI-Desktop 的 `HOST_API_ALLOWLIST` **只是一个 `default:` 分支的兜底** —— 有显式 `case` 的 API（`commands.*`、`agent.registerTool`、`session.*`、`net.websocket.*` …）**完全绕过它**，只由 `assertPermission` 把关（§2.1.11 的坑 1）。
  **Oint 的规则**：每一次宿主调用都走**同一个** `dispatch(api, args)` 函数，函数体**固定**是 `allowlist 检查 → 能力求交检查 → （可选）scope 检查 → 执行`，**不允许任何分支跳过前两步**。理由很实际：两处都能到达同一个能力，审计就永远说不清"到底哪个检查生效了"。
- **"未支持"要有两种刻意相反的语义**（照抄 PI-Desktop 的取舍，它做对了这件事）：
  - **宿主 API 的未实现 = 抛 `UNSUPPORTED`** —— 插件作者必须立刻知道，而不是拿到一个 `undefined`；
  - **外来 SDK 的未支持成员 = 存在、什么都不做、返回文档化的中性值、只发一次诊断、绝不抛异常** —— 理由是 *"so an extension that only uses supported members works even if it also touches unsupported ones"*。
  Oint 的 T0/T1 只有第一条适用（没有外来 SDK）；**但如果将来支持"导入 pi 扩展"，第二条就是必须的**。
- **崩溃隔离**：一个插件崩只标它自己；用 `app.getAppMetrics()` 的 `serviceName` 辨识。**服务重启退避 `1s, 2s, 4s, 8s, 16s`，上限 30s，最多 5 次，存活 60s 视为健康并重置**（照抄这套数值，它是被实践过的）。
- **手动启停永远压过 supervisor**：显式 enable/disable 清掉待执行的重启定时器与计数。
- **热重载永不放大权限**：reload 前把新清单与批准时的快照比对，任何**新增**能力中断 reload 并返回 `PERMISSION_DENIED`；移除能力立即生效。**放宽 `fs` 范围也算新增权限**（照抄 PI-Desktop 的口径）。
- **不允许静默失败**：清单里声明了但运行时没注册 = **警告**；运行时注册了但清单没声明 = **拒绝注册**。宿主 API 失败一律抛带 `code` 的错误（`PERMISSION_DENIED` / `NOT_FOUND` / `INVALID_ARGUMENT` / `TIMEOUT` / `UNSUPPORTED` / `LIMIT_EXCEEDED` / `RATE_LIMITED`）。
- **审计**：`plugin.install / uninstall / enable / disable / load.success / load.error / unload / crash`，字段含 `pluginId` / `version` / `source` / `ts` / `errorCode?` / `exitCode?`。落进应用日志，可在插件行上看。

**配额**（机制必须在 P3 就有，数字可以后调）：

| 对象 | 上限（建议） |
| --- | --- |
| 技能 | 每插件 32 个，单文件 128 KiB，description 240 字符 |
| 提示模板 | 每插件 32 个 |
| 子智能体定义 | 每插件 16 个 |
| MCP server | 每插件 8 个 |
| 工具 | 每插件 32 个 |
| 包 | 2,000 文件 / 50 MiB |
| 同时监视的开发插件 | 16 个 |

**理由**：一个插件能把系统提示撑爆。技能索引进的是**每一轮**的请求体，32 个技能 × 240 字符描述已经是 7.7 KB 的常驻开销。

### 4.10 安装、分发与信任

| 项 | 决定 |
| --- | --- |
| 目录 | `~/.oint/plugins/installed/<id>/`、`data/<id>/`（插件私有可写区，**跨更新持久**）、`dev/`（开发引用，不拷贝） |
| 内置插件 | `<appPath>/resources/plugins/**`。**`electron-builder.yml` 的 `files:` 已经有 `resources/**/*` 且已 `asarUnpack`** —— 所以这一条**零配置改动**，且外部进程能读到真实路径（`resolveBuiltinSkillDir` 的 `.unpacked` 回落逻辑可复用） |
| 格式 | `.ointplug` = **标准 ZIP**（上限 2,000 文件 / 50 MiB；禁符号链接与路径穿越；根必须有 `oint-plugin.json`） |
| 完整性 | SHA-256（**如实告知：这不是签名**） |
| 签名 | **二期**。在此之前靠 source pin（repository + ref + commit + path）+ 人工审核 |
| 信任绑定 | **哈希绑定**：清单 + 权限集一起哈希，任一项变化 → 回到待审、默认不启用。**这条从第一天就要有**，因为后补极难。<br>⚠️ **这是本方案少数几处"比参照物更严"的地方**：PI-Desktop 的信任绑定在**权限集**上而不在代码哈希上（运行时没有任何 `digest`/`sha256` 使用，唯一带代码强制上限的是开发插件热重载）；真正给出可抄实现的是 **Codex 的 `hooks.state.<key>.trusted_hash`**（§2.3.1） |
| 本地开发 | 目录可直接引用 + watcher（300ms 防抖，忽略 `.git` / `node_modules` / `dist`） |
| 开发工具 | `oint-plugin init / check / pack`。**`check` 必须复刻安装器的每一条规则** —— "check 通过即安装通过" |
| 市场 | 独立仓库 + `catalog.json`；默认源可在设置里改。**先做本地目录安装，市场放二期** |

> **明确不要抄的一条**：PI-Desktop 的 `.piplug` 强制"未压缩 ZIP"，导致必须用自家 devkit 打包、普通 `zip` 打的包会被拒 —— **实现泄漏到作者体验上**。Oint 接受标准压缩。

> **一条从 DSH 学到的教训**：插件的**非法配置键必须报错**。DSH 的 cordis loader 对不存在的键只 warn 然后静默跳过，那份配置活了很久没人发现，因为"配置写错了"和"配置生效了但没效果"在界面上长得一样。

### 4.12 贡献面的优先级：按 4,214 个真实插件的需求排序

> 依据见 `docs/research/real-plugin-survey.md` —— 那份文件统计了 **DSH 社区目录 4,183 个插件**（近 30 天 **616 万次下载**）与 **PI-Desktop 官方 31 个**，并归纳出插件只做**十件事**。
> 这一节把那份统计翻译成"Oint 先做哪个贡献面"。

#### 4.12.1 十类原型 × Oint 现状

| 原型 | 需求（30 天下载） | Oint 现状 | 结论 |
| --- | --- | --- | --- |
| **1 改界面** | ★★★★★（`DSH-better-sidebar` 28.6 万） | 右侧六视图 + 设置十分栏，**全部硬编码** | **P1 注册表化就是做这个** |
| **10 元插件**（市场/治理） | ★★★★★（`dsh-market` **40.2 万，全生态第一**） | 无 | P6 |
| **2 补模型短板**（视觉/搜索/语音） | ★★★★★（`modlens` 10 万、`modsearch` 3.6 万） | `read_image`/`web_*`/`browser_*` 有；**provider 写死 5 家**；**语音无** | **provider 是可扩展面的第一顺位**（见 4.12.2） |
| **7 会话数据管理** | ★★★★☆（`skill-explorer` 19.4 万、`archive-manager` 6.9 万） | 归档/分组/分支/搜索/技能面板**已有** | 覆盖良好，缺"导入外部会话" |
| **8 接入外部服务**（IM/远程/云） | ★★★★☆（`remote-web-ui` **19.6 万**） | **完全没有** | 真真空（见 4.12.2） |
| **4 上下文与用量** | ★★★★☆（`billion-context` 14.7 万、`dsh-context` 10.8 万） | **已经内置**：`context-meter` / `context-breakdown` / `cost-meter` / `session-stats`；压缩由 pi 内核负责 | **不需要插件** —— Oint 已覆盖 DSH 下载量第 7、第 8 的插件所做的事 |
| **3 记忆** | ★★★★☆（`hindsight` 5.1 万；DSH 第三大类 195 个） | **只有静态 `AGENTS.md`** | 真真空（见 4.12.2） |
| **5 给 agent 加工具** | ★★★★☆ | MCP 已是一等公民（34 预设 + 网关聚合） | 基本覆盖，缺 T1 原生工具 |
| **6 约束/编排 agent 行为** | ★★★☆☆（`agent-teams` 6 万、`permission-rules` 6.2 千） | `agentMode` + 七个子智能体预设，**均不可扩展** | **收益最高也最危险**（见 4.12.3） |
| **9 模型与账号接入** | ★★★☆☆（`codex-subscription` 1.3 万） | 两种 OpenAI 格式写死 | 真真空 |

#### 4.12.2 三个有下载量证据的真真空

**(a) 网络搜索 provider 不可扩展 —— 第一顺位。**
`dsh-free-search`（7 个引擎、1.85 万下载）与 `modsearch`（3.66 万）证明这是刚需；而 Oint 的 `WEB_SEARCH_PROVIDERS`（`shared/contracts/web.ts:9`）是**编译期常量**，第三方加不了引擎。
**为什么它是第一顺位**：`WebSearchProviderImpl` 接口（`main/web/types.ts:101`）**本来就是一个完美的插件契约** —— `{ id, available(): boolean, search(req): Promise<Result> }`，无状态、无特权、纯函数式。把它变成插件贡献点，**是全仓最干净的插件化候选**，而且它落在 P3（T0 声明式）就能做，不需要等 T1 的进程外宿主。

**(b) 记忆 —— 第二顺位。**
DSH 的 `memory` 是第三大类（**195 个插件、27 万次下载**），PI-Desktop 有 4 个记忆插件；Oint 只有静态的 `AGENTS.md`。这一类的实现形态很清楚（本地存储 + 检索 + 每轮注入），而且**与 Oint 已有的"技能索引进系统提示"是同一条链路**，可以复用 P3 的机制。

**(c) 通知与远程 —— 第三顺位。**
`dsh-remote-web-ui` 19.6 万、`dsh-im` 4.9 万（9 种 IM 渠道）、PI-Desktop 的 `pi.agents-anywhere`（手机端远程控制）。Oint 完全没有。这一类需要 T1（后台服务 + `net.fetch`），排在后面。

#### 4.12.3 一类必须**刻意窄化**的：约束/编排 agent 行为

真实生态证明它有价值（`dsh-agent-teams` 6 万、`dsh-agency-agents` 6.2 万、`dsh-permission-rules` 6.2 千、`cn.star.grok-enhance` 的"重复失败 3 次就拦住"）。但它要求把宿主钩子开放给插件。

**§4.6 纪律 4 的结论不变**（不开放 pi 的 `HookMap`）。**而真实生态正好给出了正确形状的样本**：

> `dsh-permission-rules` 挂在 `tools/pre-execute` 瀑布上，对工具名/参数/路径/agent 身份做 **allow / deny / ask** 判定 —— **它只判定，不改写任何东西**。

这正是本方案 §4.6 说的"**宿主钩子无权改 args、只有权 block**"。**抄这个形状，不抄 pi 的 `before_tool`（那个能改 args）。**

#### 4.12.4 一份可对照的"Oint 已内置"清单

值得记下来：**Oint 现有的内置功能已经覆盖了 DSH/PI-Desktop 生态里下载量最高的一批插件**——

| DSH / PI-Desktop 的热门插件 | 下载量 | Oint 的对应内置能力 |
| --- | --- | --- |
| `DSH-better-sidebar`（侧栏工作台：文件/终端/Git/子代理） | 28.6 万 | 右侧面板六视图（审查/文件/文件查看器/子智能体/浏览器/终端） |
| `dsh-git-graph` / `pi.gitlens`（Git 图谱与 GitLens） | 18.4 万 / 449 | `ReviewPanel` + `reviewable-diff` + `code-diff` |
| `pi.file-manager`（文件管理器） | 1,575（PI-Desktop 第一） | `FilesPanel` + `FileViewPanel` + `file-tree` |
| `dsh-context`（上下文洞察） | 10.8 万 | `context-meter` + `context-breakdown` |
| `billion-context`（上下文压缩） | 14.7 万 | pi 内核的 `compaction`（阈值/溢出/手动三条路径） |
| `dsh-cost-meter` / `usage-dashboard`（用量计费） | 7.3 万 / 208 | `cost-meter` + `stats-pills` + `session-stats` |
| `dsh-skill-explorer` / `dsh-skills-manager`（技能管理） | 19.4 万 / 6.5 万 | 设置 → 技能（三层来源 + 禁用 + zip 导入） |
| `dsh-archive-manager`（归档会话） | 6.9 万 | 侧栏归档 + 置顶 + 项目分组 |
| `dsh-mcp-connector`（MCP 管理） | 1.5 万 | 设置 → MCP（系统预设 34 个 + 网关聚合） |
| `dsh-agency-agents`（子代理专家） | 6.2 万 | 子智能体七预设 + `Task` 系列 |

> **这张表的用处**：它说明 **Oint 的插件系统不该以"补齐 DSH 有而我没有的"为目标** —— 那一栏大部分已经内置了。真正的目标是 **"让用户能改我内置的东西"（原型 1 → P1 注册表化）+ "补我确实没有的"（4.12.2 的三个真空）**。

**⭐ 一份更强的验证来自 pi 生态**（npm 真实月下载量）：

| pi 扩展 | 月下载 | Oint 的对应内置能力 |
| --- | --- | --- |
| `pi-mcp-adapter` | **1,013,749** | MCP（34 预设 + 网关聚合） |
| `pi-subagents` | **455,454** | 子智能体（7 预设 + `Task` 系列 + 报告投递） |
| `pi-web-access` | **429,774** | `web_search` + `web_fetch` |
| `@juicesharp/rpiv-ask-user-question` | 203,682 | `ask_user` + 提问卡 |
| `@juicesharp/rpiv-todo` | 159,088 | `todo` + 独立折叠面板 |
| `billion-context` | 151,038 | pi 内核的 `compaction` |
| `pi-background-tasks` | 103,218 | 作业四件套（`bash_background`/`job_output`/`job_list`/`job_kill`） |

> **这七件事 Oint 一件不缺，而且是内置的。** pi 用户要花几十万次月下载去补的能力，Oint 用户开箱就有。
> **含义有两层**：(a) 它**验证了 Oint 的既有路线** —— 把子智能体、todo、提问卡、后台作业、上下文压缩做成内置而不是留给插件，这个选择是对的；(b) 它**给出了插件系统的正确定位** —— 不是"补内核"，而是**"接管我不打算内置的部分"**（见 4.12.2 的三个真空）。
>
> **pi 生态暴露的四个次级真空**（`docs/research/real-plugin-survey.md` §4.3）：**实时 LSP/linter 反馈**（`pi-lens` 9.3 万）、**`/goal` 自主目标 + 独立完成度审计**（三个竞品合计 15 万；**DSH 把它做成了内置的 `dsh-tool-goal`** —— 两个生态独立收敛，说明这是真需求）、**交互式计划评审**（`@plannotator/pi-extension` 7.7 万）、**第三方模型 provider**（`pi-provider-litellm` 3.7 万）。


### 4.11 一个必须做对的小东西：把限制告诉用户

PI-Desktop 在作者指南最显眼处写了：

> **Trust boundary:** the permission model gates the `pi.*` host API and panel bridge. **It is not yet an operating-system sandbox for raw Node APIs used by a plugin entry process.**

Oint 的 T1 插件有同样的性质。**这一句必须出现在插件安装页上**，措辞要一样直白。隐瞒这条边界比边界本身更糟 —— 用户会以为"我拒绝了 fs.write，它就写不了文件"。

---

## 5. 落地路线图

> 每期都有**明确的完成判据**。P1 是杠杆最大的一步，P0 是唯一不可跳过的一步。

### P0 · 修缺口（1–2 天）

修 §6 的六个缺口。**产出：提权链关闭。**

判据：`grep` 越界读被拒；`settings.write` 的非法值被归一化；`bash` 子进程环境变量是白名单；MCP 子进程同样；`shell: true` 不再拼接字符串。

### P1 · 注册表化（2–3 天）

把 §4.7 的六处硬编码表改成注册表，**内置项先走通**。

判据：
- 加一个右侧面板 = **改 1 处**（注册一行）；
- `RIGHT_PANEL_VIEW_META` 的穷举 `Record` 消失，但"漏注册"仍有测试兜住（启动时断言内置 6 个视图全部已注册）；
- `SearchModal` 不再拼 `settings.${id}` 键；
- 全部既有测试绿。

**这一期不依赖插件系统的任何其他部分**，且立刻改善日常维护。

### P2 · 清单 + 宿主骨架（3–4 天）

清单 schema + 校验器、`plugin-registry.ts`（发现/校验/启用状态）、`IPC.plugins.*` 域、设置里的"插件"分栏（**用 P1 的注册表加，验证注册表好用**）、审计日志。此时**能加载一个什么都不做的插件**。

判据：放一个目录进 `~/.oint/plugins/dev/`，设置里出现一行；清单里写一个非法权限，那一行显示可读的失败原因；禁用后重启仍是禁用。

### P3 · T0 声明式贡献面（2–3 天）—— **第一个有真实价值的插件类**

- `resolveSkillDirs` / `resolvePromptTemplateDirs` / `resolveSubagentDirs` 追加"每个已启用插件的对应子目录"；
- **`sessionAllowedRoots` 同步追加**（漏了就是"目录存在却 0 个技能"）；
- MCP：插件声明的 server 并入 `effectiveMcpServerConfigs`，`McpServerSource` 增加 `"plugin"`；
- 配额机制；
- 插件行展开显示"贡献了什么"。

判据（**这三条是 §4.8 原则的第一次真正检验**）：
- (a) 插件的技能**没有**出现在设置 → 技能的列表里；
- (b) 它**确实**进了系统提示的技能索引（用一个真实会话验证，或跑 `probe:plugins`）；
- (c) `disabledSkillNames` 禁用它时**两条路一致**（既不在索引里，也不可被 `lane.skill` 取到）。

### P4 · T1 进程外工具与命令（5–7 天）

`utilityProcess` 宿主 + MessagePort 上的类型化 JSON-RPC + 能力 broker + 环境变量白名单 + 插件工具注册进 `buildTools` 的 `extraTools` 位 + 命名空间化 + 审计 + 崩溃退避。

判据：
- 一个 echo 工具插件能被模型调用，且**弹出审批卡**（走的是 `assessToolRisk` 的 unknown → high）；
- 用户点"始终允许"后写进 `permission-rules.json` 的是 `plugin__<key>__*`；
- 插件进程里 `process.env` **看不到** API Key 与 `OINT_HOME`；
- 插件死循环被 110s 超时 kill，**会话不受影响**，插件行显示 `crashed`。

### P5 · T2 UI（5–8 天）

描述式面板（`markdown` / `table` / `keyValue` / `list` + `action`）+ `<webview>` 孤岛（自定义协议 + 自带 CSP + `setPermissionRequestHandler`）。

判据：一个插件能开一个只读面板并用 `markdown` 描述渲染出一段内容；webview 孤岛里 `window.oint === undefined`。

### P6 · 分发与生态（3–5 天）

`.ointplug` 打包/安装/卸载、`oint-plugin check/pack` CLI、市场 catalog 格式 + 手动添加源、哈希信任绑定。

**catalog 的形状直接照 PI-Desktop 的实测格式**（§2.1.12 有三层字段的完整清单）—— 它已经在跑、有 31 个真实插件，重造一个只会更差。四条具体的：

1. **四个可切换的源**：默认官方 / GitHub 备份 / 镜像 / 自定义（自定义 URL 可配），外加一个环境变量覆盖一切（对齐 Oint 已有的 `OINT_HOME` 覆盖模式）。**缓存按源分别 keyed** —— 这样切回上一个源是即时的，而且**切换源永远不会改变正在被校验的那个 checksum**。
2. **两级完整性记录**：静态源用目录里的 `shasum`，官方源用 resolve 接口返回的 `sha256`；**同时校验摘要与声明的字节数**；多镜像**按顺序尝试**，任何一个网络/HTTP/摘要/大小不符就换下一个。
3. **目录必须在下载之前刷新** —— URL 与 checksum 来自同一份快照。离线安装可以用上一次有效的目录，**但仍按那份目录的 checksum 校验字节**。
4. **信任等级由签发方决定，不由目录文本决定**：默认渲染 `unknown`，**永不根据 catalog 里的文字升级等级**。PI-Desktop 实测 31 个插件全是 `community`、`verified` 全为 `false`、**零签名、零数值化安全评分** —— 所以 sha256 + 权限审查就是当前的信任原语，**要如实这么写**。

**插件页的 UI 只做两个页签：`已安装` / `市场`**（§2.1.12 给了完整信息架构）。**不要把技能、MCP、子智能体塞进这个页面** —— PI-Desktop 的更新版信息架构文档明确写了这一条，它是 §4.8 核心边界的外部印证。

**卡片只画字母组合字形，渲染器不做任何远程图片加载** —— 与约束 A 的 `img-src 'self' data: blob:` 完全一致，同时省掉"插件图标从哪来"这个问题。

判据：
- `check` 通过即安装通过（**同一条规则表**，CLI / GUI / agent 工具三处共用一份实现）；
- 卸载会问"是否保留数据"；
- 装一个**权限升级**的新版本时，弹窗把新增权限标出来，且**不点确认就装不上**；
- 把一个包的一个字节改掉，安装被拒且给出可读原因。

**总工期**：单人约 **4–6 周**。MVP = P0 + P1 + P2 + P3。

> **P6 的一条排序建议**（来自 PI-Desktop 的 roadmap，它的原则是 *"Local plugins usable → developer-friendly → marketplace distribution → signing and auto-update"*）：**市场排在签名与自动更新之前**，而**本地插件运行时排在市场之前**。PI-Desktop 的文档把"Marketplace before local plugin runtime"明确列为**被否决的架构选项**，理由是"Premature expansion"。Oint 的对应结论就是 §5 这个顺序本身。

### 5.1 测试与冒烟（Oint 已有强测试文化，必须跟上）

| 层 | 内容 |
| --- | --- |
| 单测（`vitest --project node`） | 清单校验器的每一条规则各一个用例；能力求交；fs scope 匹配（含整树通配必须被拒）；命名空间化与权限前缀匹配；配额 |
| 单测（`vitest --project ui`） | 插件行渲染；描述式渲染的四种 kind；注册表"内置 6 项全部已注册"的启动断言 |
| 冒烟（CDP 驱动真实 Electron） | 新增 `scripts/probe-plugins.mjs` + `npm run probe:plugins`，对齐既有的 `probe:system`：用独立 `OINT_HOME`、不碰本机数据。覆盖：装一个技能插件 → 启用 → 真实会话里技能进了索引 → 禁用 → 索引里消失 → 卸载 |

> 参照 `probe:system` 的既有形态（README 第 223 行）：它"用独立 `OINT_HOME`，不碰本机数据"，并在**真实界面**里验设置面板的两个页签。插件冒烟应当同款。

---

## 6. 插件落地前必须修的既有缺口

以下六项**今天就需要修**（不是为插件而修），但在有第三方代码之后严重性会跃升。判据只有一条：**谁能控制那个字符串**。

### 缺口一：`grep` / `glob` 零确认越界读 —— **P0，最高优先**

`src/main/pisdk/tools/search.ts:8-11` 的注释原文：

> `path` 只决定「检索根」，**不是**围栏：可以是工作目录之外的任意绝对路径……因此这里不调用 `validatePathAccess`

而 `permissions.ts:60-83` 的 `LOW_RISK_TOOLS` 包含 `grep` 与 `glob`，`gateTool` 对 `low` **直接 `return undefined` —— 连审批卡都不创建**。

**后果**：`grep { path: "C:\\Users\\<u>\\.oint", pattern: "apiKey" }` 是一次**零确认**的凭据读取。`settings.json` 是文本、远小于 1 MiB 的过滤阈值，唯一的拦截是二进制嗅探。

**为什么 README 说 C-1 已修但问题仍在**：`sessionAllowedRoots`（`runtime.ts:1091-1112`）确实**不包含** `dataDir()` 本身，也有测试钉住 `settings.json` / `permission-rules.json` / `sessions-index.json` 不可经 `read`/`write`/`edit` 读取。**但 grep/glob 走的是另一条完全不受守卫的路。**

**修法**（推荐前者）：给 `resolveSearchRoot` 增加 `validatePathAccess(root, sessionAllowedRoots(cwd, appPath))`。检索本来就该限定在工作区内；把 grep/glob 移出 `LOW_RISK_TOOLS` 会把"找一段代码"变成点卡地狱。

### 缺口二：`settings.write` 无写侧校验 —— **P0**

`src/main/ipc/settings.ts:10-11`：

```ts
ipcMain.handle(IPC.settings.write, async (_event, next: Settings) => {
  await saveSettings(next);
```

`settings/store.ts` 的 `save()` 直接 `JSON.stringify(toPersisted(next))`，而 `toPersisted` 是 `{...settings, services, webSearch}` —— **任意额外键会被 spread 落盘**。所有校验（`normalizePermissionMode` 非法回落 `default`、`clampInt`、`normalizeMcpServers`）**只在 `load()` 生效**。

**后果**：渲染层可以写 `permissionMode: "full"`，缓存立即更新，**审批链当场失效**。今天渲染层是我们自己的代码，所以不是漏洞；一旦有任何第三方代码进入渲染层它就是。

**修法**：(a) 把 `mergeWithDefaults` 的归一化逻辑在 `save()` 里也跑一遍（**最小改动，立刻消除一整类问题**）；(b) 插件**永远不给 `settings.write`**，只给插件命名空间的读写。

### 缺口三：`exec` 全量继承环境变量 —— **P0**

`exec-env.ts` 的路径守卫**只覆盖路径类方法**；`exec` 原样透传（注释自述"路径守卫在这一层**不构成任何限制**"）。且没有传 `shellEnv`，**子进程继承整个主进程环境** —— 包括 `OINT_HOME` 与进程里存在的各类凭据。

**后果**：一次批准后的 `cat ~/.oint/settings.json` 即可读走凭据；若用户对 `cat` 点过"始终允许"，规则写的是 `{toolName:"bash", pattern:"cat"}`，**永久放行所有 `cat` 调用**。

**修法**：`createExecEnv` 显式构造 `shellEnv` 白名单（`PATH` / `HOME` / `USERPROFILE` / `TEMP` / `LANG` 等），**剔除 `OINT_HOME` 与一切 `*_API_KEY` / `*_TOKEN`**。

### 缺口四：没有 `setPermissionRequestHandler` —— **P1**

全仓 `grep setPermissionRequestHandler|setPermissionCheckHandler` **零命中**（本轮已复查）。webview guest 用独立分区（`BrowserPanel.tsx`）、**不套应用 CSP**（`window.ts:125-126` 是刻意的），且没有权限请求处理器 —— 按 Electron 默认，guest 页面可能直接获得摄像头 / 麦克风 / 地理位置 / 通知等能力。

**与插件的关系**：T2 形态二的 webview 孤岛会**直接继承**这条缺口。

**修法**：给 guest 分区装 `setPermissionRequestHandler`，默认 `deny`，用一张显式 allowlist 放行（如 `fullscreen`、`clipboard-read`）。

### 缺口五：MCP 子进程继承全量环境变量 —— **P0**

`src/main/mcp/transport.ts:97`：

```ts
env: { ...process.env, ...config.env },
```

**今天为什么不是漏洞**：MCP server 是**用户自己在设置面板里填的**。**一旦 `mcpServers` 能由第三方插件提供，提供者就从"用户"变成了"插件作者"。**

**修法**：改为显式白名单 + 叠加 `config.env`。这与 PI-Desktop 的做法一致（§2.1.2 的 `{ "setting": "<key>" }`：*"the host environment is never passed through"*）。

### 缺口六：MCP 子进程 `shell: true` 与引号化漏洞 —— **P0**

`src/main/mcp/transport.ts:66-101`：

```ts
function quoteForShell(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}
// ...
const useShell = process.platform === "win32";
const command = useShell ? quoteForShell(config.command) : config.command;
```

判据正则**不含 `%` 与 `!`**，而这两个恰是 `cmd.exe` 的变量展开与延迟展开字符。代码注释自己写着"真正有歧义的参数（含 % 或 !）建议写成 .cmd 脚本再调用"，即**这个洞是被知道并接受的**。

**今天为什么不是漏洞**：`command` / `args` 由用户自己填，风险自担。**一旦 `mcpServers` 由插件提供，`command` 就变成"插件作者可控、以用户权限经 shell 执行"的字符串。**

**修法**：`command` 是**单个可执行 token，不是 shell 命令串** —— 只在确认目标是 `.cmd`/`.bat` 时才经解释器，且**不做字符串拼接**。这与 PI-Desktop 的规则一致（§2.1.3：*"`stdio` requires `command` (bare PATH name or plugin-relative, never absolute)"*）。

### 缺口七：路径守卫不做 `realpath` —— **P0（本轮新增）**

`README.md` 自己在"仍有未修的越界读写路径"一节里列了这一条：**路径守卫不做 realpath**。也就是说 `validatePathAccess` 是**纯字符串前缀判断**，一个指向禁区的符号链接可以合法地通过它。

**为什么它是 P0**：§4.5 的五步判定里第 2 步就是"容器校验（`realpath`）"。**这一条不修，插件的 `fs` scope 就是纸面上的** —— 插件在自己的 data 目录里放一个指向 `~/.oint/settings.json` 的符号链接，scope 检查会通过。

**今天为什么影响有限**：能创建那个符号链接的只有用户自己（或模型经由已批准的 `bash`）。

**修法**：`validatePathAccess` 在比较前对目标做一次 `realpath`（对不存在的路径做"最近存在祖先"的 realpath，否则新建文件的路径永远解析失败）；`grep`/`glob` 的 `root` 同样处理（与缺口一同一个调用点）。

### 缺口优先级汇总

| 缺口 | 优先级 | 不修的后果 | 与插件的关系 |
| --- | --- | --- | --- |
| 一 · grep/glob 越界读 | **P0** | 零确认读走 `settings.json` | 今天就可利用，与插件无关 |
| 二 · `settings.write` 无校验 | **P0** | 渲染层可写 `permissionMode: "full"` | 插件进渲染层则直接提权 |
| 三 · `exec` 全量环境 | **P0** | 子进程读走凭据 | 同 |
| 四 · 无 `setPermissionRequestHandler` | P1 | guest 获得摄像头/麦克风等 | T2 webview 孤岛继承 |
| 五 · MCP 全量环境 | **P0** | 第三方 MCP server 读走凭据 | **采纳插件声明 MCP 的前置条件** |
| 六 · `shell: true` 引号化 | **P0** | 插件可控字符串经 shell 执行 | **同上** |
| 七 · 路径守卫无 `realpath` | **P0** | 符号链接绕过一切路径判断 | **插件的 `fs` scope 会变成纸面规则** |

**修完的判据（可写成测试）**：

- `grep { path: "~/.oint", pattern: "apiKey" }` 被拒（缺口一）；
- `IPC.settings.write` 传 `{ permissionMode: "full", 任意新键: 1 }` 后，落盘文件里 `permissionMode` 被归一化、**未知键不落盘**（缺口二）；
- `bash -c "env"` 的输出里没有 `OINT_HOME` / `*_API_KEY` / `*_TOKEN`（缺口三）；
- MCP 子进程同样（缺口五）；
- 插件 `fs` 目录里的符号链接指向黑名单路径时被拒（缺口七）。

---

## 7. 明确的非目标

| 不做 | 理由 |
| --- | --- |
| 插件跑进主进程 | 约束 C：插件与 SQLite 句柄、API Key、IPC 网关共处一室 |
| 插件跑进渲染进程 | 约束 B + 约束 A：`window.oint` 是整套权限，CSP 也不允许 |
| 向插件开放 pi 的 `HookMap` | §4.6 纪律 4 的三条理由 |
| 让插件**替换**内置工具实现 | 内置工具只能被 hook **包裹与拦截**，不能被替换 —— 这正是 opencode 的反面（它明确"plugin tool takes precedence"） |
| 插件的技能/MCP 进既有设置面板 | §4.8 |
| 运行期 eval 插件 UI 代码 | 约束 A |
| 用 `!!js` 那样的配置求值 | DSH 的教训：从网上抄一段配置等于执行任意代码 |
| 插件传 i18n key 进来 | 约束 D：i18next 缺键会原样显示键名 |
| 强制未压缩 ZIP | PI-Desktop 的反面教材 |
| 第一天就做签名 | 先把权限审查与哈希绑定做对；签名是二期 |

---

## 8. 未决问题（需要产品决策，不是技术问题）

1. **插件是否允许在渲染进程跑代码？** 本方案的建议是**不允许**（描述式 UI + webview 孤岛）。如果产品上必须允许（例如希望插件能深度定制面板交互），则必须先解决约束 B（`window.oint` 的 70 个方法需要按插件能力逐项开放），工作量数倍于本方案。
2. **市场由谁审核？** PI-Desktop 靠 source pin + 人工审核（独立仓库 `vastsa/pi-desktop-plugins`）。**在做出决定之前，市场应当保持"用户手动添加源"的形态。**
3. **是否兼容 Agent Plugins 1.0.0 那类极简清单？** 本方案的清单已经按"极简内核 + 反向域名扩展位"的形态设计（§4.4）：如果将来要兼容，只需把 `contributes` / `permissions` / `fs` / `net` 挪进 `extensions.dev.oint`。**这是一个低成本的可选项，不必现在决定。**
4. **是否要一个插件间消息总线（PI-Desktop 的 `contributes.bus`）？** 本方案**没做**：Oint 的插件数量在可预见期内不会大到需要插件互相通信，而总线会引入"谁能给谁发消息"这一整类新问题。等有真实需求再说。

---

## 附录 A · 来源索引

| 来源 | 类型 | 用于本方案的结论 |
| --- | --- | --- |
| Oint 源码（本仓库，逐文件 `read`/`grep`） | 一手源码 | §3 全部、§6 全部、§4.7 的改造点 |
| `D:\DSH Desktop\resources\app\package.json` + `cordis.patch.yml` | 一手安装产物 | §2.2.1 / §2.2.2 的清单、依赖、配置形态 |
| `D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\cordis\src\*.ts` + `cordis-plugin-{loader,include,group,hmr}\src\*.ts` | **随包 TS 源码**（本机唯一带源码的包） | §2.2.3 / §2.2.4 的插件模型、fiber 状态机、epoch、`ctx.effect`、`EntryOptions`、patch 算法、`!!js` 的 `eval` 实现 |
| `D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-{host-plugin-inventory,hooks-claude-code,hooks-codex,hook-protocol,community-market,dshmarket}\lib\*.js` + 各自的 `README.zh.md` | 一手 runtime + 官方中文说明 | §2.2.6 / §2.2.7 / §2.2.8 的清单四字段、市场流程与 `SECURITY.md` 原文、hook 退出码语义与方言差异 |
| `vastsa/PI-Desktop`：`docs/spec/07-plugins/README.md`、`02-plugin-manifest-schema.md`、`05-plugin-lifecycle.md`、`README.md` | 官方规范原文 | §2.1 的清单/贡献点/权限/生命周期 |
| `vastsa/PI-Desktop`：`docs/plugin-development.md` | 官方作者指南 | §2.1 的进程模型、预算、配额、信任边界、热重载、错误码、不要抄的两条 |
| **`docs/research/agent-plugins-1.0.0.md`**（81 KB） | 一手抓取（站点 MDX 原文、两份官方 JSON Schema、章程、维护者名单、`FUTURE_CONSIDERATIONS.md`） | **§4.4 规则 10 的采纳依据**：1.0.0 规范全貌、10 个兼容客户端、Agent Skills 格式、与 Oint 的逐字段差距、五处修订 + 五处新增 |
| **`docs/research/agent-plugins-governance.md`**（64 KB） | 子代理一手抓取（GitHub `.atom` 订阅源 + `codeload` tarball + 本地 diff） | **规则 10 的风险依据**：零 tag/release、bus factor 1、Vercel 起源、schema 缺陷 #76/#77、1.1 的五个 PR |
| **`docs/research/real-plugin-survey.md`**（56 KB） | **两份活的插件目录本地统计**：DSH `awesome-dsh-plugin.com/plugins.json`（4,183 个）+ PI-Desktop `plugins.aiuo.net/catalog.json`（31 个） | **§4.12 全部**：十类能力原型、需求强度、三个有下载量证据的真真空、以及"Oint 已内置"对照表 |
| **`docs/research/pi-extension-inventory.md`**（57 KB） | 子代理一手抓取（`pi.dev/packages` 目录逐页 + npm registry 交叉核对） | real-plugin-survey §4 的 pi 部分：仓库搬家、5,697 个包的市场、真实月下载量、ExtensionAPI 各表面 |
| `openai/codex` `main`：`codex-rs/core-plugins/*`、`codex-rs/plugin/src/lib.rs`、`codex-rs/core/src/config/mod.rs`、`codex-rs/exec-server-protocol/src/protocol.rs` | 一手源码 | §2.3.1 / §2.3.2 |
| `api.github.com/repos/vastsa/PI-Desktop` | 一手 API | 产品定位、star 数、license |
| `agent-plugins.org/schemas/1.0.0/plugin.schema.json` | 中立规范 | §2.3.2 的 `additionalProperties: false` |
| `modelcontextprotocol.io/specification/2026-07-28/*` | 官方规范 | §2.3.4 |

**已确认取不到的内容（UNVERIFIED）**：

- **Codex**：官方插件文档（`developers.openai.com` 对本环境 **403**，含 `/llms.txt`）；`Feature::Plugins` 在发行版里是否默认开；`SKILL.md` 的 frontmatter 键；CLI 子命令名与插件管理 UI；IDE 扩展的贡献点；`PluginManifestMcpServers::Object(String)` 的反序列化位置；`PluginRequirementsToml` 的完整字段定义。
- **Claude Code**：插件能否贡献快捷键或任意 UI 面板/webview（清单与目录布局里都没有，但"没有"不等于"产品里没有"）；`channels` 与 `claude plugin eval` 的完整 schema；30+ 事件里一部分的 hook JSON 输出 schema（抓取时被截断）。
- **MCP**：快捷键原语在 `schema.ts` 里的"穷尽缺席"是**推断**而非读完生成 schema 的证明；Interceptors（SEP-1763）的实际 schema 未取。
- **DSH**：**本轮已复查到源码级**（§2.2 已按 cordis 的 `src/*.ts` 重写）。仍然取不到的：**整个安装里零 `.d.ts`**（900 个 `.d.ts.map` 但 `.d.ts` 计数为 0），所以 `SlotMap` / `ComposedProps` / `WebBootGraph` / `HookPoint` 这些 README 引用的具名联合类型**不在磁盘上**；typert 的**物理传输细节**（分帧、鉴权、流式、重连）只读了协议/注册表/loader/门面，没读 `dsh-api-gateway` 实现；`dsh-tools` / `dsh-commands` / `dsh-skill` / `dsh-mcp-client` / `dsh-subagent` / `dsh-llm` 六个包的注册签名**只部分读**；本机没有任何 `hooks.json` 实例（两个 hook 桥在随包的 `cordis.patch.yml` 里都没挂载）。

**两处文档漂移（建议顺手修掉）**：

- `README.md` 第 140 行引用了 `docs/architecture-review-0.87.md`，但 `git ls-files docs` 里**没有这个文件**。
- `docs/plugin-system-report.md` 引用的 `docs/research/dsh-plugin-architecture.md`、`docs/research/dsh-client-plugin-architecture.md`、`docs/agent-plugins-standard-report.md` 也**都不在仓库里**。

**引用不存在的证据文件比没有引用更糟。** 建议要么补回、要么删掉引用。

> **本文件本身已执行过这条纪律**：调研期间产生的 6 份 PI-Desktop 子代理报告、1 份 Codex 报告与原始抓取缓存（`docs/research/pi-desktop-raw/`、`.scratch/plugin-survey/`）已全部移除；它们的结论**已内联到 §2.1 / §2.2 / §2.3 / §4.3.1**，附录 A 里不再保留指向已删文件的条目。
> `docs/research/` 现在只留 4 份**被本文件或 `real-plugin-survey.md` 实际引用**的证据文件（见上表）。

---

## 附录 B · 与上一轮报告的差异清单

| # | 上一轮 | 本轮 | 依据 |
| --- | --- | --- | --- |
| 1 | Codex = MCP + hooks + config | Codex 有真插件系统（`core-plugins` crate、`Feature::Plugins`、插件贡献 MCP、管理员 allowlist） | `codex-rs` 源码 |
| 2 | 清单以 Agent Plugins 为标准 | PI-Desktop 用私有 `manifest.json`（35 权限 / 15 贡献类） | PI-Desktop 规范原文 |
| 3 | P3 需要"扩展 `resolveSkillDirs` + 同步 `sessionAllowedRoots`" | 同，但补充：**三个解析函数各有四个消费者**，所以是"改一处、四处生效" | Oint 源码 |
| 4 | 六处硬编码扩展点 | 同，但补上**当前规模实值**（`ToolParts.tsx` 1610 行 / `tool-presentation.ts` 1328 行 / 100 个 IPC 通道 / 23 个 IPC 域） | Oint 源码 |
| 5 | pi 0.85.1 的 11 个钩子 | **已在 0.87.0 复查，仍是 11 个**；补上 `before_tool` 可改 `args` 的行号证据 | `agent-harness.d.ts:485-604` |
| 6 | — | 新增：**能力三档（T0/T1/T2）** 的设计与理由 | 本方案 §4.2 |
| 7 | — | 新增：**"非法键必须报错"** 这条来自 DSH 实际踩坑的规则 | §2.2.3 |
| 8 | — | 新增：**插件工具命名空间化方案**（`plugin__<key>__<tool>`，复用既有前缀匹配权限规则） | §4.6 |
