# Oint 插件系统调研与改造报告

> 调研对象：本仓库（Oint，Electron 44 + React 19 + `@earendil-works/pi-agent-core@0.85.1`）
> 参照对象：DeepSeek Harness（本机 `D:\DSH Desktop\resources\app\`，`@deepseek-ai/dsh@0.1.5-rc.2` + vendored Cordis 4.0.2）、
> `vastsa/PI-Desktop`（pi 生态内的桌面客户端，插件系统已交付）、OpenAI Codex + Agent Plugins 1.0.0、Claude Code、
> opencode、Cline、Zed、Raycast、VS Code、Obsidian。
> 时效：2026-09。所有外部结论均标注来源类型（源码 / 官方文档 / 推断）。

---

## 0. 摘要

**结论：Oint 现在没有插件系统，而且它的架构在三个具体位置上一旦长到第七个功能就会开始互相绊住。** 但它的底座——主进程独占 Agent 运行时、渲染进程零特权、类型化 IPC、路径守卫 + 审批门——恰好是插件系统最需要的那层地基，只是这层地基从来没有被当成"宿主"来设计过。

本报告的判断分四句：

1. **该抄 pi-desktop，不该抄 DSH。** pi-desktop 是 pi 生态里**唯一**把"用户如何发现、安装、授权、更新、卸载插件"这一整层做完的产品；DSH 的 cordis facet 是**实验态**（`PI_EXPERIMENTAL=1` 门禁、示例插件 `private: true` 且 npm 404）。DSH 真正值得抄的是它的**服务可用性驱动加载**与 **effect 零残留**两条内核机制，而不是它的分发层。
2. **Oint 的插件系统必须是"进程外 + 声明式 + 默认拒绝"，而不是"进程内 + 代码优先 + 全权限"。** 理由不是审美，而是 Oint 的既有安全资产（`sandbox: true` 渲染进程、`path-guard`、三模式审批）会在插件跑进主进程的那一刻**整体作废**——因为主进程持有 SQLite 句柄、API Key 与 IPC 网关。
3. **插件是一个自足的贡献单元：它内部的技能、MCP、工具、提示模板不进既有的功能面板，唯一出口是系统提示词与工具表的装配。** 既有面板回答"用户自己配了什么"，插件贡献物回答"模型这一轮能看到什么"——两者是不同的维度。可删列表里不该出现删不掉的东西。详见 §3.9。
4. **在写第一行插件代码之前，必须先修几个既有缺口**（`grep`/`glob` 零确认越界读、`settings.write` 无写侧校验、`exec` 与 MCP 子进程全量继承环境变量、`shell: true` 的引号化漏洞）。这些缺口在"只有内置工具"时是设计取舍，在"有第三方代码"时是提权链——§6 给出文件级证据。

**给决策者的最小可行切片（MVP）**：清单 + 能力默认拒绝 + `utilityProcess` 宿主 + 一条类型化 RPC + 只读贡献面（skills / prompts 文件 + 一个右侧面板 slot）。**不开放**工具执行、不开放 fs 写、不开放网络，直到 §6 的缺口修完。

**与 pi-desktop 的关系**：它是主要参照物，但两者在**对 pi 底层能力的开放程度**、**贡献物进不进面板**、**UI 扩展形态**、**清单标准化**四处做了不同选择。**其中"不把 pi 的 `ExtensionAPI` 开放给插件"是 Oint 必须坚持的差异**——否则 `before_tool` 的权限门会被插件钩子绕过。逐条对照见 §4。

---

## 1. 现状：Oint 有什么，缺什么

### 1.1 已经具备的"类插件"机制

| 机制 | 层级 | 能否被第三方扩展 | 证据 |
| --- | --- | --- | --- |
| **MCP server** | **配置级（唯一的真插件）** | ✅ 是 | `shared/contracts/mcp.ts:21` `McpServerConfig`；`mcp__<serverId>__<tool>` 命名（`:94`）；连接池 `pisdk/mcp-servers.ts` |
| 技能 Skills | 文件级 | ⚠️ 只能加数据，零 UI 扩展 | `SKILL.md`，三层目录优先级 `pisdk/resources.ts:33` |
| 魔法提示 Prompts | 文件级 | ⚠️ 同上 | `${dataDir}/prompts/*.md`，`resources.ts:83` |
| 子智能体定义 | **混合**：内置代码级 / 用户文件级 / 临时运行期 | ⚠️ 部分 | `shared/contracts/subagent.ts:19` `SubagentSource` |
| 网络搜索 provider | **代码级（编译期常量）** | ❌ | `shared/contracts/web.ts:9` `WEB_SEARCH_PROVIDERS`，5 家写死 |
| 右侧面板 / 设置分栏 | **代码级** | ❌ | 见 §1.2 |
| 工具渲染器 | **代码级** | ❌ | `ToolParts.tsx`（1569 行单文件） |
| 权限规则 | 文件级 | ❌（数据不是代码） | `permission-rules.json` |

**一句话**：只有 MCP 是"外部代码 + 数据驱动"的真插件；技能/提示/子智能体是"数据驱动但零 UI 扩展"；其余全部是编译期硬编码。

### 1.2 扩展一个功能今天要动几处

这是"该不该做插件系统"最硬的论据——它把"加功能很烦"量化成了文件数。

| 想做的事 | 要改的文件数 | 具体位置 |
| --- | --- | --- |
| 加一个右侧面板视图 | **5 处** | `ui-store.ts:4`（类型）+ `:15-26`（顺序表）；`panel-meta.ts:16-34`（穷举 Record，**漏项直接编译失败**）；`RightSidebar.tsx:271-283`（分发 switch）+ `:8-15`（import）；`useGlobalShortcuts.ts:26-59`（快捷键 switch）；两个语言包 |
| 加一个设置分栏 | **4 处 + 1 处隐式** | `ui-store.ts:74-84` + `:90-102`；`SettingsModal.tsx:39-54`（SECTIONS）+ `:66-89`（renderPanel switch）；**隐式第 5 处**：`SearchModal.tsx:187-201` 用 `t(\`settings.${section}\`)` 拼键，**依赖「section id 恰好等于 i18n 键名」这条没人写下来的约定** |
| 加一个工具渲染器 | **4 处，且必须改同一个 1569 行文件** | `ToolParts.tsx:91-127`（`TOOL_ICONS`）+ `:132-167`（`TOOL_LABELS`）；`tool-presentation.ts:1117-1222`（有序 if 链）+ `:577-600`（`ToolDetail` 联合加 kind）；`ToolParts.tsx:1271-1309`（`ResolvedDetail` if 链）；要"独立显示"还得 `useAssistantToolUI` 逐个注册（`:1477-1498`，**hook 顺序固定，不能在循环里调**） |
| 加一条事件流 | **3 层** | `shared/contracts/api.ts` → `src/preload/index.ts` → `src/main/ipc/*` 注册 |
| 加一个搜索命令 | **2 处** | `SearchModal.tsx:101`（actions Map）+ `:204-213`（entries 数组） |

### 1.3 三条决定架构的既有约束

**约束 A：CSP 把"运行期加载第三方渲染代码"这条路彻底堵死。**

`src/main/app/window.ts:96-117` 的 `buildContentSecurityPolicy()`，生产形态实值：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
media-src 'self' data: blob:; worker-src 'self' blob:;
object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'
```

以**响应头**下发（`window.ts:128-138`）。没有任何 `unsafe-inline` / `unsafe-eval`，`connect-src 'self'` 断远程拉取，`object-src` 与 `frame-src` 都是 `'none'`（iframe 沙箱路线也堵死）。而 `window.test.ts:36-41` 用单测钉死了"prod 不含 unsafe"。

> **含义：插件 UI 代码只能构建期打包**（打进 `dist/assets/*.js` 即满足 `'self'`）。运行期从磁盘 eval、或远程注入 `<script>`，一律被拦。
> 这不是缺陷——它就是"渲染层持特权桥"这个威胁模型下的正确设计。但插件系统必须接受它，**不要去动 CSP**。

**约束 B：渲染层是特权进程，不是沙箱。**

`window.ts:260-272`：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` + `webviewTag: true`。渲染层没有 Node，但 preload 通过 `contextBridge` 暴露了约 70 个白名单方法（`src/preload/index.ts:10-171`）。

关键在于**这些方法本身有没有守住边界**。`IPC.settings.write` 直接 `saveSettings(next)`，**没有任何写侧校验**（`src/main/ipc/settings.ts:10-11`）——渲染层可以写 `permissionMode: "full"` 且缓存立即更新（`settings/store.ts:478-486`），审批链当场失效。今天这没问题，因为渲染层代码是我们自己的；**一旦有任何第三方代码进入渲染层，`window.oint` 就是全套权限**。

**约束 C：主进程是唯一特权进程，也是唯一不能放插件的地方。**

`src/main/pisdk/runtime.ts:1070-1075` 的会话运行表、`session-store.ts` 的 SQLite 句柄、`settings/store.ts` 的 `safeStorage` 解密结果、`mcp-servers.ts:380` 的共享连接池、`browser/service.ts` 的 `WebContents`——全在主进程。插件跑进主进程 = 插件拿到这一切，且一个死循环能让 agent 与 UI 一起挂。

### 1.4 运行时的真实扩展面（pi 给的能力比想象的多）

`@earendil-works/pi-agent-core@0.85.1` 的 `HookMap`（`dist/harness/agent-harness.d.ts:485-604`）已经有 11 个类型化钩子，**且其中若干个能改数据、能拦截**：

```ts
before_tool:      { args?, block?: { reason, terminate? } }     // 权限门就挂在这里
after_tool:       { content?, details?, isError?, usage?, terminate? }
transform_context:{ messages?, systemPrompt? }                   // Oint 用它注入重复调用提醒
before_run:       { messages? }
before_payload:   { payload }        // 改请求体
after_response:   { message? }
before_compaction / before_navigation: { decline? }
```

Oint 今天只用了 3 个：`before_tool`（`runtime.ts:2111-2119` 权限门）、`after_tool`（`:2132-2174` 重复调用守卫）、`transform_context`（`:2187-2199` 注入提醒）。

另有 `AgentHarnessOptions` 的 `toProviderMessages`、`entryProjectors`、`resources`（`agent-harness.d.ts:617-635`），以及 `HarnessEvent` 约 30 种事件。

> **含义：第三方"策略插件"不需要新造钩子总线**——pi 已经给了。Oint 需要造的只是"谁能注册进来、注册进来之后受什么约束"。这把工作量从"造一套中间件框架"降到"造一层信任与注册"。

---

## 2. 参照系统的对比与取舍

### 2.1 七方对比表

| 项目 | 插件单元 | 清单 | 运行位置与隔离 | 权限模型 | 分发 |
| --- | --- | --- | --- | --- | --- |
| **pi-desktop** | 目录 + `manifest.json` + `main` 模块 | `schemaVersion:1` + 反向域名 `id` + `contributes`（15 类） + `permissions` + `fs`/`net` **带范围** | **每插件独立 `utilityProcess`** + JSON-RPC broker + `HOST_API_ALLOWLIST` | **开关 ∩ 范围**，未声明=拒绝；热重载**永不放大权限** | `.piplug`（store-only ZIP + sha256）+ 独立市场 repo + `catalog.json` |
| **DSH** | npm 包（cordis facet） | `package.json` 的 `dsh` 字段 + profile bundles + Loader entry | **与宿主同进程同权限** | **无**（插件级零权限声明、零版本校验） | pnpm 透传 + 两个市场插件 |
| **Codex** | Agent Plugins 目录 | `plugin.json`（**只强制 `$schema` + `name`**）+ `skills/` + `mcp.json` + `extensions.com.openai` | MCP 子进程；hooks 是 shell 命令（**逃出沙箱**） | 沙箱三模式 + 审批枚举；**hook 用哈希绑定信任、插件 hook 默认跳过** | `codex plugin add` + marketplace.json（7 层配置优先级） |
| **Claude Code** | 目录 | `.claude-plugin/plugin.json`（**只强制 `name`**，缺省时自动发现） | 同进程；command hook 全用户权限 | 四层 settings + `enabledPlugins`；**官方直言"插件是高信任组件，可执行任意代码"** | marketplace.json（7 种 source）+ 保留名防冒名 |
| **opencode** | TS 模块 | 无专用清单；`opencode.json` 数组 | 同 agent server 进程，无沙箱 | `permission` 匹配 + `permission.ask` 钩子可改写 | npm（Bun 自动装） |
| **Zed** | Git 仓库 + `extension.toml` → **WASM** | `extension.toml` + `[[capabilities]]` | **WASI 沙箱**：只 preopen 自己目录、env 仅 `PWD`/`RUST_BACKTRACE`、无 socket、100ms epoch 抢占 | 清单 allowlist ∩ 用户授予；**仅 3 种能力** | `zed-industries/extensions` PR + 人工审核 |
| **VS Code** | 目录 + `package.json` | `engines.vscode` + `contributes`（~40 类） + `activationEvents` | **独立 extension host 进程**（但官方：*"same permissions as VS Code itself"*） | Workspace Trust + 未声明能力的扩展默认禁用 | Marketplace / Open VSX |
| **Obsidian** | 目录（`main.js` + `manifest.json`） | `id`/`name`/`version`/`minAppVersion`/`isDesktopOnly` | **与应用同进程** | 只有 Restricted Mode 总开关；官方：*"cannot reliably restrict plugins to specific permissions"* | `community.obsidian.md` 自助提交 + 自动扫描 + 安全评分卡 |

### 2.2 三个必须内化的结论

**结论一：进程隔离解决的是稳定性，不是权限。** 七家全部收敛到"独立进程"，但没有一家把它当权限边界。VS Code 说得最直白：*"The extension host has the same permissions as VS Code itself."* Raycast：*"not further sandboxed"*。**安全边界必须显式建造**——默认拒绝的能力清单 + 能力化 RPC——不能从隔离机制里"继承"。

**结论二：Zed 是唯一真正削减能力的样本，但它自己的默认值是反例。** WASM/WASI 沙箱确实做到了"默认无文件系统、无网络"（`wasm_host.rs` 只 preopen 扩展自己的工作目录，`FsPerms::ReadWrite`；env 只有 `PWD` + `RUST_BACKTRACE`；`epoch_interruption` 100ms 防死循环）。**但 `assets/settings/default.json` 默认授予 `process:exec` 且 `command = "*"`, `args = ["**"]`——这让 WASM 沙箱的价值归零**（一条 `process:exec` 就能 spawn 出无约束的真实进程）。**默认必须是拒绝，不是通配。**

**结论三：pi 生态里只有 pi-desktop 交付了这一整层。** pi 内核本身刻意不做 MCP、子代理、权限弹窗、plan mode、内建 todo、后台 bash，README 明写 *"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access."* 上游的 `ExtensionAPI` 是**进程内、全权限、代码级**的；pi-desktop 补上了**进程外、声明式、权限受控的用户级**那一层。这正是 Oint 需要补的那一层。

### 2.3 值得直接照抄的六条

从 pi-desktop（最贴近的类比物）与 Codex/Claude Code（最成熟的 manifest 与信任模型）里挑出的六条，按价值排序：

1. **权限 = 开关 + 范围，两件事都要，且范围 fail-closed。** `fs.read` 说能不能碰文件，`manifest.fs.read.scope` 说能碰哪些；`net.fetch` 说能不能发请求，`net.domains` 说能发给谁；**不写 = 没有**。再叠一条**不对称规则：读可以宽，写必须窄**（pi-desktop 原文理由是 *"the egress allowlist is what makes a broad read safe and nothing makes a broad write safe"*）。
2. **哈希绑定信任。** Codex 的 hook 信任记在**当前哈希**上，插件更新后自动回到待审状态、默认跳过。这是"插件升级偷偷加恶意 hook"的干净解法——比"首次安装弹一次窗"强得多。
3. **清单极简 + 反向域名 extension namespace。** Agent Plugins 1.0.0 只强制 `$schema` + `name`，厂商私有能力塞进 `extensions.com.<vendor>`。**可移植内核 + 客户端私有扩展**，既不锁定生态又能塞下自家 UI 元数据。
4. **热重载永不放大权限。** reload 前把新 manifest 与批准时的快照比对，任何**新增**能力都中断 reload 并拒绝；移除能力立即生效。把"开发便利"和"用户同意"解耦得很干净。
5. **支持矩阵 + 惰性拒绝。** pi-desktop 把上游 API 分成 Supported / Deferred / **Unsupported**，不支持的成员**存在但什么都不做、返回文档化的中性值、发一次诊断、绝不抛异常**——原文理由：*"so an extension that only uses supported members works even if it also touches unsupported ones"*。
6. **事务性加载。** `begin → register 全部贡献 → commit → 启动常驻服务`，中途失败回滚该插件的全部注册，消除"命令在但工具不在"的半加载态。DSH 的 `ctx.effect` 是同一件事的更强形态（一切副作用皆 effect，卸载零残留）。

### 2.4 明确不要抄的五条

1. **不要照抄 DSH 的"插件无权限声明"。** 插件即宿主代码、同进程同 Node 权限、零版本校验——这套只在"插件全是你自己写的"前提下成立。Oint 要跑第三方就必须补 DSH 没有的东西。
2. **不要照抄 pi-desktop 的"manifest 权限在加载时自动授予"。** 它自己承认这是未强制项，后果是"用户必须主动取消勾选才有效"。
3. **不要照抄 opencode 的"插件工具可覆盖内置工具"**（*"the plugin tool takes precedence"*）。Oint 应反过来：`bash`/`read`/`write`/`edit` 只能被 hook **包裹与拦截**，不能被替换实现。
4. **不要照抄 DSH 的 `!!js` 配置求值。** 那是 profile patch 文件里的完整 `eval`——从网上抄一段配置等于执行任意代码。
5. **不要把上游演进中的 API 直接暴露给第三方。** pi 在 0.86 → 0.87 之间就在改，pi-desktop 不得不锁版本 + 打 pnpm patch。第三方插件写死在 `ExtensionAPI` 上会随上游漂移而碎——**只承诺一个子集，并把这个子集当自己的 API 长期维护**。

---

## 3. Oint 插件系统设计

### 3.1 设计原则（五条，按优先级）

1. **主进程是唯一的权限执行点。** 插件能做的一切特权操作，最终都收敛到主进程的一个 IPC 处理函数上，走既有的 `gateTool` / `validatePathAccess` / `settings` 校验。插件运行时本身不做权限判断。
2. **插件是自足的贡献单元，内部构成不进入既有的功能面板。** 插件的技能、MCP、工具、提示模板**不在设置里的对应分栏中出现**（技能面板只列用户/项目/内置三层，MCP 面板只列用户自己配的 server）。它们**唯一的出口是系统提示词与工具表的装配**。详见 §3.10——这条决定了整个 UI 面的形状。
3. **默认拒绝，没有隐式能力。** 清单不写的 = 拿不到。没有"通配默认"。
4. **宿主拥有 UI 骨架，插件只提供内容。** 面板的尺寸、焦点、键盘作用域、错误边界由 Oint 掌握；插件提交的是受限描述或一个隔离的渲染单元。（这一条直接来自 CSP 约束 A 与 opencode 的 `session.panel` 经验。）
5. **失败必须是局部的、可见的。** 一个插件崩溃不能影响 agent 运行；一个插件超时不能挂住一轮对话；每一个被拒绝的调用都要在界面上有一条可读的原因，而不是静默失败。

### 3.2 进程模型

```
┌─ Renderer（sandbox，零特权）─────────────────────────────────┐
│  React 19 · 宿主渲染所有 UI 骨架与面板外壳                    │
│  插件 UI = 宿主白名单组件渲染的「描述」+ 可选 <webview> 承载   │
└──────────────┬──────────────────────────────────────────────┘
               │ preload（现有白名单 + 插件域通道）
┌──────────────┴──────────────────────────────────────────────┐
│  Main（唯一权限执行点）                                       │
│  ├─ 既有：AgentHarness / SQLite / 审批门 / 路径守卫           │
│  ├─ PluginRegistry：清单加载、能力求交、生命周期、审计         │
│  └─ CapabilityBroker：插件来的每个请求 → 过 gate → 转发       │
└──────────────┬──────────────────────────────────────────────┘
               │ MessagePort + 类型化 JSON-RPC（不是裸 ipcRenderer）
┌──────────────┴──────────────────────────────────────────────┐
│  PluginHost：每插件一个 Electron utilityProcess              │
│  ├─ 完整 Node 环境（能跑 npm 依赖），但**不注入任何凭据**      │
│  ├─ 只拿到 broker 给的窄 API 对象，拿不到 require('fs') 的授权 │
│  └─ 可被 kill() 做超时熔断；serviceName 进 app.getAppMetrics  │
└─────────────────────────────────────────────────────────────┘
```

**为什么是 `utilityProcess` 而不是主进程 / 渲染进程 / worker / vm：**

| 方案 | 判定 | 理由 |
| --- | --- | --- |
| 渲染进程 | **排除** | 见约束 B——破沙箱或把边界挪到 preload，等于重演 Obsidian 的处境 |
| 主进程 | **排除** | 见约束 C——插件与 SQLite 句柄、API Key 共处一室 |
| `utilityProcess` | **✅ 采用** | Electron 官方定位：*"host for example: untrusted services, CPU intensive tasks or crash prone components"*；完整 Node、`MessagePort` 可直连渲染进程、可 `kill()` 熔断 |
| worker_threads | 不作安全边界 | 只防卡 UI；Node 权限模型**不继承到 worker** |
| `node:vm` | 不作安全边界 | Node 官方：*"is not a security mechanism. Do not use it to run untrusted code."* |
| WASM/WASI | **二期评估** | 最强隔离，但要自建 host 函数层；先用 utilityProcess 把能力化 RPC 做干净 |

**必须如实告知的一条限制**：`utilityProcess` 内的插件仍能 `require("node:fs")` 并绕过 `pi.fs.*` 这一层 API 门。这与 pi-desktop 自己承认的缺口同源（ADR 0008 D009，*"the remaining gap that matters"*）。三条缓解措施，**按落地顺序**：

- (a) 核心能力（会话读写、SQLite、凭据、审批）**全部不给插件进程**——它们本来就在主进程，插件只能走 RPC 请求，这一点是天然成立的；
- (b) 插件进程**不注入任何 API Key、不注入 `OINT_HOME`**，也不继承主进程环境变量（见 §6 缺口三）；
- (c) 二期对"不可信插件"档位引入 WASM 或 OS 级隔离。

### 3.3 清单（`oint-plugin.json`）

设计目标：**极简内核 + 反向域名扩展位 + 能力带范围**。字段名尽量与 Agent Plugins / pi-desktop 对齐，降低将来的迁移成本。

```jsonc
{
  "$schema": "https://oint.dev/schemas/plugin/1.0.0.json",
  "id": "dev.example.web-summarizer",   // 反向域名，全局唯一，也是存储/审计作用域
  "name": "Web Summarizer",
  "version": "1.0.0",
  "description": "把当前浏览器标签页抓成一份带引用的摘要",
  "apiVersion": "1",                     // 宿主插件 API 版本，第一天就带
  "engines": { "oint": ">=0.2.0" },      // 见 §3.7：这是 DSH 缺的那一环

  "main": "./dist/main.js",              // utilityProcess 入口（必须已构建为 JS）
  "entrypoints": { "onLoad": "onLoad", "onUnload": "onUnload" },

  "contributes": {
    "commands":    [{ "id": "summarizePage", "title": "总结当前页" }],
    "rightPanels": [{ "id": "summary", "title": "摘要", "icon": "file-text" }],
    "agentTools":  [{ "name": "summarize_url", "description": "…", "risk": "medium" }],
    "skills":      ["./skills"],          // 目录贡献：风险最低，推荐一等公民
    "prompts":     ["./prompts"]
  },

  "permissions": ["ui.panel", "agent.tool.register", "session.read", "net.fetch"],

  "net":  { "domains": ["api.example.com"] },              // fail-closed，裸 * 在安装时被拒
  "fs":   { "read":  { "root": "workspace", "scope": ["**/*"] },
            "write": { "root": "pluginData", "scope": ["cache/**"] } },

  "activationEvents": ["onStartup", "onCommand:summarizePage"]
}
```

**五条校验规则（全部在安装/启用时同步执行）：**

1. `id` 必须匹配 `^[a-z0-9]+(\.[a-z0-9_-]+)+$`；`apiVersion` 必须在宿主支持列表内（不支持 = 拒绝加载并给出可读原因，**不是崩溃**）。
2. `permissions` 里的每一项必须在宿主的已知能力表里；**未知能力 = 校验失败**（防止将来删除能力后旧清单静默通过）。
3. `manifest.fs.write.scope` 不得含 `**` / `**/*` / `*/**` / `./*`（照抄 pi-desktop 的不对称规则）；`manifest.net.domains` 不得含裸 `*`。
4. `contributes` 里声明的每一项，必须与运行时实际注册的项**双向对齐**——声明了没注册 = 警告；注册了没声明 = 拒绝注册。这条把清单变成可审计的事实来源，而不是装饰。
5. `main` 必须落在插件目录内（路径穿越校验），且**必须是已构建的 JS**——宿主不装依赖、不编译 TypeScript。

### 3.4 能力表（默认拒绝）

分三档，对齐 pi-desktop 的风险分级但按 Oint 的实际能力面裁剪：

| 风险 | 能力 | 授予时机 |
| --- | --- | --- |
| **Low** | `ui.panel`、`ui.command`、`notify`、`storage`（插件私有 KV） | 安装时告知，不单独确认 |
| **Medium** | `fs.read`（受限 scope）、`clipboard.write`、`session.read`、`skills.contribute`、`prompts.contribute` | **首次使用时确认一次** |
| **High** | `fs.write`、`fs.delete`、`agent.tool.register`、`net.fetch`、`shell.openExternal`、`mcp.register` | **逐次确认**（或用户在设置里显式改为"始终允许"） |

**能力求交公式**（照抄 pi-desktop）：`运行时可见能力 = 清单声明 ∩ 用户已授予`。所以用户在设置里撤销一项后，即使清单仍写着也立即失效。

### 3.5 API 面（插件在 `utilityProcess` 里拿到的东西）

全局注入一个 `oint` 对象，**方法全部是 RPC 代理**，不是本地实现。命名与 Oint 既有概念对齐，避免另造词汇：

```js
export async function onLoad() {
  // 命令：注册后出现在命令面板与全局快捷键里
  await oint.commands.register({
    id: "summarizePage",
    title: "总结当前页",
    run: async () => { /* ... */ },
  });

  // Agent 工具：schema 由宿主校验，执行回主进程过权限门
  await oint.agent.registerTool({
    name: "summarize_url",
    description: "Fetch a URL and return a short summary.",
    parameters: { url: { type: "string", required: true } },
    async execute({ url }, ctx) {
      const res = await oint.net.fetch(url);       // 走 net.domains 白名单
      return { content: [{ type: "text", text: summarize(res.body) }] };
    },
  });

  // 贡献面：面板只提交描述，宿主渲染
  await oint.ui.registerPanel({
    id: "summary",
    title: "摘要",
    render: (state) => ({ kind: "markdown", text: state.lastSummary }),
  });

  // 事件订阅：只订阅清单里声明过的类型
  oint.events.on("session/tool-call", (e) => { /* ... */ });

  // 私有存储：读写自己的 data 目录，碰不到别人的
  await oint.storage.set("lastRun", Date.now());
}

export async function onUnload() { /* 清理；宿主也会强制回收全部注册 */ }
```

**API 面的四条纪律：**

- **一切注册返回 disposer**，宿主同时把它们挂在插件的生命周期上——`onUnload` 漏写不会导致残留。（DSH 的 `ctx.effect` 是这条的最佳实现，Oint 用简单版即可。）
- **不暴露裸 `fs` / `child_process` / `net`。** 只给 `oint.fs.*`（受限 scope）、`oint.net.fetch`（白名单域）、`oint.shell.openExternal`。
- **不暴露 `settings.write`。** 插件要配置就用 `oint.plugin.getSettings()/setSettings()`，落盘到自己的命名空间，**碰不到 `permissionMode`**（见 §6 缺口二）。
- **`apiVersion` 第一天就带**，且宿主对不认识的 API 版本**拒绝加载并给出可读原因**，而不是让插件在运行时崩。（opencode V1→V2 的教训原文：*"V1 plugin implementations do not run in V2"*。）

### 3.6 UI 扩展点

在既有结构上做**最小侵入的注册表化**，不新造一套 UI 框架。

**改造前（现状）**：每种 UI 扩展点都是一张硬编码表 + 一个 switch。
**改造后**：一张 `ExtensionPoint` 注册表，宿主内置项与插件贡献项走**同一条路**。

| 扩展点 | 改造动作 | 插件能做什么 |
| --- | --- | --- |
| 右侧面板 | `RightPanelView` 从字面量联合改为 `string`；`RIGHT_PANEL_VIEWS` / `RIGHT_PANEL_VIEW_META` / `TransientPanel` switch 三处合并为一个 `panelRegistry: Map<string, PanelDescriptor>`；内置六项在启动时注册进去 | 注册新面板（`ui.panel`）。**面板外壳由宿主渲染**（`PanelSection` / `PanelEmpty` / `PanelError` 已存在，`panel-view.tsx`） |
| 设置分栏 | 同上：`SECTIONS` + `renderPanel` switch 合并为 `settingsRegistry`。**同时修掉 `SearchModal.tsx:187-201` 的拼键依赖**——改成读注册表里的 `labelKey` 字段而不是拼 `settings.${id}` | 注册设置页（`ui.settings`），**只能读写自己的命名空间** |
| 工具渲染器 | 把 `ToolParts.tsx` 里的 `TOOL_ICONS` / `TOOL_LABELS` / `ResolvedDetail` 与 `tool-presentation.ts` 的 `resolveToolDetail` if 链抽成 `toolRendererRegistry: Map<toolName, ToolRenderer>`；**顺带把 1569 行的 `ToolParts.tsx` 拆开** | 为**自己注册的工具**提供渲染器。**不能**覆盖内置工具的渲染（只允许 hook 包裹） |
| 命令面板 | `SearchModal.tsx:101` 的 actions Map + `:204-213` 的 entries 数组合并为 `commandRegistry` | 注册命令；自动进 Ctrl+K 搜索 |
| 全局快捷键 | `useGlobalShortcuts` 的 switch 改为查 `commandRegistry` 的 `shortcut` 字段 | 注册快捷键，**由宿主检测冲突并拒绝** |
| 斜杠命令 | `buildSlashCommands`（`slash-commands.ts:51-68`）增加第三个来源：插件贡献的 prompts 目录 | 贡献 prompts 目录（`prompts.contribute`） |

**插件 UI 的三种形态**（按能力递增，按风险递增）：

1. **描述式（默认，覆盖 80%）**：插件返回 JSON 描述，宿主用白名单组件渲染。零 CSP 风险，零沙箱需求。
2. **`<webview>` 承载（少数）**：复杂面板走独立分区 `webview`（Oint 已有 `webviewTag: true` 与 `hardenWebviews`，`window.ts:38-56`），配 `Content-Security-Policy: default-src 'none'`。**注意**：需要补 `setPermissionRequestHandler`（见 §6 缺口四）。
3. **构建期打包（内置/官方插件）**：走 `check-unwired` 与 `check-i18n` 的既有门禁，等同内置代码。

> **i18n 的硬约束**：`check-i18n.mjs` 抓的是**编译期字面量**键，且 `en-US.ts` 用 `satisfies Messages` 做类型闭合（漏译 = 编译错误）。**运行时注入语言包在这套门禁下不可行。** 因此插件文案只有两条路：(a) 插件自带 `i18n` 字段，宿主按当前语言取用，**缺省回落到清单里的默认名**；(b) 官方插件在构建期并入语言包。**绝对不要让插件传一个 i18n key 进来**——i18next 缺键会原样返回键名，界面上会直接显示 `plugin.summary.title`。

### 3.7 生命周期、错误隔离与降级

```
discovered → validated → installed → enabled → loaded → running
                                            ↘ load_error / invalid / disabled
```

- **事务性加载**：`begin → 全部注册 → commit → 启动常驻服务`。中途失败回滚该插件的全部注册。消除"命令在但工具不在"。
- **预算**：模块求值 + `onLoad` 15s；每个 hook 5s；工具调用 110s（与 pi-desktop 同档）。超时 → `kill()` 插件进程 → 标记 `crashed`。
- **`failureMode` 写在注册里**（照抄 Cline 的策略字段）：`blocking | async`、`timeoutMs`、`retries`、`failureMode: fail_open | fail_closed`、`maxConcurrency`。**权限类 hook 默认 `fail_closed`**（超时 = 拒绝），其余默认 `fail_open`。
- **崩溃隔离**：一个插件崩只标它自己；`app.getAppMetrics` 里用 `serviceName` 辨识。**服务重启退避** `1s, 2s, 4s, 8s, 16s`，上限 30s，最多 5 次，存活 60s 视为健康并重置。
- **热重载永不放大权限**：重载前把新 manifest 与批准时的快照比对，任何**新增**能力中断重载并返回 `PERMISSION_DENIED`；移除能力立即生效。
- **支持矩阵 + 惰性拒绝**：宿主 API 分成 Supported / Deferred / Unsupported。Unsupported 的成员**存在但什么都不做、返回中性值、发一次诊断、绝不抛异常**。

### 3.8 安装、分发与信任

| 项 | 决定 |
| --- | --- |
| 目录 | `<dataDir>/plugins/installed/<id>/`、`disabled/`、`data/<id>/`（插件私有可写区，**跨更新持久**） |
| 格式 | `.ointplug` = ZIP；上限 2000 文件 / 50 MiB；禁符号链接与路径穿越；根必须有 `oint-plugin.json` |
| 完整性 | sha256（**如实告知：这不是签名**） |
| 签名 | **二期**。在此之前，市场的准入靠 source pin（repo + ref + commit + path）+ 人工审核 |
| 信任绑定 | **哈希绑定**：清单或 hook 定义变化 → 回到待审、默认跳过。**这条从第一天就要有**，因为后补极难 |
| 本地开发 | 目录可直接引用 + watcher（300ms 防抖，忽略 `.git`/`node_modules`/`dist`） |
| 开发工具 | `oint-plugin init / check / pack`。**`check` 必须复刻安装器的每一条规则**——"check 通过即安装通过" |
| 市场 | 独立仓库 + `catalog.json`；默认源可在设置里改。**先做本地目录安装，市场放二期** |

> **一条从 pi-desktop 学到的反面教训**：`.piplug` 强制"未压缩 ZIP"，导致必须用自家 devkit 打包、普通 `zip` 打的包会被拒——**实现泄漏到作者体验上**。Oint 应当接受标准压缩。

### 3.9 插件的贡献物**不进入既有功能面板**（核心边界）

这是本设计里最容易做错、也最需要先定下来的一条。

#### 3.9.1 规则

**插件是一个自足的贡献单元。它内部的技能、MCP、工具、提示模板，不在设置里的对应分栏中出现。**

| 既有分栏 | 今天显示什么 | 插件化之后**不变** | 插件贡献物去哪了 |
| --- | --- | --- | --- |
| 设置 → 技能 | 系统（内置 8 个）+ 用户（数据目录） | **不加"插件"页签** | 只在系统提示的 `<available_skills>` 索引里出现 |
| 设置 → 子智能体 | 系统（内置 7 个）+ 用户 | **不加"插件"页签** | 只在系统提示的 `<available_subagents>` 索引里出现 |
| 设置 → 提示模板 | 系统 + 用户 | **不加"插件"页签** | 只在 `/` 斜杠菜单里出现 |
| 设置 → MCP | 用户自己配的 server 列表 | **不混入插件声明的 server** | 由宿主连接，工具以 `mcp__<server>__<tool>` 进工具表 |
| 设置 → 网络搜索 | 5 家 provider（编译期常量） | 见 §3.9.3 的例外说明 | 成为插件贡献的 provider |
| 工具图标/词条表 | 内置 27 个工具 | **只为插件自己的工具加渲染器** | 工具表 + 系统提示的工具指导 |

**一句话**：既有面板回答的是"**用户自己配了什么**"；插件贡献物回答的是"**模型这一轮能看到什么**"。两者是不同的维度，混在一起会让"这个技能是谁给的、我能不能删"变成一道需要解释的题。

#### 3.9.2 为什么这样做

1. **删不掉的东西不该出现在可管理的列表里。** 技能面板有"删除"按钮、MCP 面板有"移除"按钮。插件的技能与 MCP **不属于用户**——它们的生命周期跟着插件走。放进面板就得回答"在这里删了会怎样"（DSH 的经验：删了下次插件重载又回来）。**不显示，就没有这个问题**——与 Oint 今天对内置技能的处理完全一致（内置技能住 `resources/skills`、可禁用不可删除，所以它在"系统"页签里而不是"用户"页签）。
2. **一个插件贡献 12 个 MCP server 时，MCP 面板会被淹没。** 面板是给人做配置用的；插件声明的 server 是给模型用的。
3. **技能的真正消费点在系统提示词。** Oint 今天的技能链路是：`resolveSkillDirs` 扫三层目录 → `loadAgentResources` 过滤禁用 → `formatSkillsForSystemPrompt` 生成索引 → 注入系统提示（`runtime.ts:863-902, 811-837`）。插件贡献的技能**走完全相同的这条链**，只是多一个目录来源。
4. **管理插件的正确位置是插件自己的行。** 一个插件就是一行，行上显示：它贡献了什么（技能 3 个 / MCP 1 个 / 工具 2 个）、启用了没有、有没有加载错误。**要看细节就在那一行展开，而不是去五个分栏里找它的碎片。**

#### 3.9.3 三个必须给出的例外

规则要成立，这三处不能含糊：

**(a) 全局禁用开关必须仍然有效。** 用户要能说"这个插件的所有技能都别进提示词"。做法：`settings.disabledSkillNames` / `disabledSubagentNames` 的匹配范围**扩展到插件贡献物**（按 `name` 匹配，与今天一致），并且**插件行上的"禁用"直接把它的全部贡献从装配里摘掉**。这比"在技能面板里逐条禁用插件的技能"更符合直觉，也不需要新 UI。

**(b) 网络搜索的 provider 表单需要处理。** `WebPanel.tsx`（16 KB）今天把 5 家 provider 的表单硬编码了。插件化之后有两个选择：

- **保持现状**：内置的 web 搜索插件仍然有自己那张定制表单（它是"内置插件"，享有内置待遇）；
- **通用化**：插件声明 `settings` schema，宿主生成表单（pi-desktop 的做法，见 §6.2 对比表）。

**建议先保持现状**——把 provider 表单通用化是一件独立的事，不该和插件系统捆绑。**但要在文档里写清楚"这是内置插件的特权，第三方插件只能用通用设置表单"**，否则第一个第三方 provider 插件就会问"为什么我不能有自己的表单"。

**(c) "系统 / 用户"这个既有的二分法要延伸，而不是新增第三档。** Oint 的技能面板今天用 `SkillSource = "builtin" | "user"`（`shared/contracts/skills.ts`），子智能体用 `SubagentSource = "builtin" | "user" | "temp"`。插件贡献物**归入 `builtin`**（它们与内置技能一样：随包或随插件分发、不可在面板删除、升级即更新）。**不要新增 `"plugin"` 这个 source**——那会让每个消费者的 switch 都要加分支，而三者的管理语义（可禁用、不可删、由宿主更新）本来就是同一个。

#### 3.9.4 对装配代码的具体影响

只有一处需要改，而且改动很小。今天 `resolveSkillDirs`（`pisdk/resources.ts:33`）返回三个目录：

```ts
// 现状
[`${dataDir()}/skills`, `${workingDir}/.oint/skills`, resolveBuiltinSkillDir(appPath)]
```

插件化后扩展为「内置目录 + 每个已启用插件的 `skills/` 子目录」：

```ts
// 目标（顺序即优先级，与今天同一条规则：先出现者胜）
[
  `${dataDir()}/skills`,              // 用户
  `${workingDir}/.oint/skills`,       // 项目
  resolveBuiltinSkillDir(appPath),    // 内置
  ...enabledPlugins.map(p => p.skillsDir),  // 插件（每个插件内部再按 Agent Plugins 的固定位置发现）
]
```

**四个消费者会自动跟着走**（因为它们都读同一个 `resolveSkillDirs`）：`ipc/skills.ts` 的列表、`runtime.ts` 的 `loadAgentResources`、`sessionAllowedRoots` 的允许根、以及 `runtime.test.ts` 的断言。**这正是 `resources.ts` 当初被抽出来的价值**（它的文件头注释写明了理由："面板看到的与运行时注入的必须同源"）。

> ⚠️ 一处必须同步：`sessionAllowedRoots`（`runtime.ts:1017-1038`）要把插件的 `skills`/`prompts`/`subagents` 目录也加进允许根，否则技能会被路径守卫拒绝——表现为"目录存在却 0 个技能"，且只有 diagnostics 里能看到。这个坑 Oint 已经踩过一次（内置技能加进来时），注释里写得很清楚。

#### 3.9.5 与 §3.6 UI 扩展点的关系

需要澄清一个容易混淆的点：**§3.6 说的是"插件可以注册 UI 扩展点"（面板、命令、快捷键），§3.9 说的是"插件贡献的**数据**不进既有面板"。两者不矛盾**：

- 插件**可以**注册一个属于它自己的右侧面板（`ui.panel`）——那是它的 UI；
- 插件**不可以**把自己的技能塞进"设置 → 技能"的列表里——那不是它的 UI。

判定方法很简单：**这块 UI 的主语是谁？** "插件管理"是插件的主语 → 可以；"技能管理"是用户技能的主语 → 不可以。

### 3.10 分阶段路线图

| 阶段 | 内容 | 前置条件 | 产出 |
| --- | --- | --- | --- |
| **P0 · 修缺口** | 修 §6 的六个缺口（含 MCP 子进程环境变量与 `shell: true` 引号化） | 无 | 提权链关闭 |
| **P1 · 注册表化** | 把 §3.6 的六处硬编码表改成注册表（**内置项先走通**） | P0 | "加面板 = 改 1 处"，插件系统有了接入点 |
| **P2 · 清单 + 宿主骨架** | 清单校验、能力求交、`utilityProcess` 宿主、类型化 RPC、审计日志 | P1 | 能加载一个什么都不做的插件 |
| **P3 · 只读贡献面** | `skills.contribute`、`prompts.contribute`、`ui.panel`（描述式）、`commands`；**`resolveSkillDirs` 扩展插件目录 + `sessionAllowedRoots` 同步** | P2 | **第一个有真实价值的插件类**（技能包 / 提示包 / 只读面板） |
| **P4 · 工具与网络** | `agent.tool.register`（**全部经主进程 `gateTool`，不开放 pi 钩子**——§4.2）、`net.fetch`（域白名单）；**贡献物配额机制**（技能数 / 单文件大小 / description 长度上限） | P3 | 工具类插件 |
| **P5 · 分发与生态** | `.ointplug`、市场、哈希信任、脚手架 CLI | P4 | 生态闭环 |

**P1 是杠杆最大的一步**：它不依赖插件系统的任何其他部分，且立刻改善本仓库的日常维护（今天加一个面板要动 5 个文件）。**P0 是唯一不可跳过的一步。**

**P3 是"§3.9 原则"第一次真正被检验的地方**：技能贡献面打通后，要确认三件事成立——(a) 插件的技能**没有**出现在设置 → 技能的列表里；(b) 它**确实**进了系统提示的 `<available_skills>` 索引；(c) 现有的 `disabledSkillNames` 禁用它时**两条路一致**（既不在索引里，也不可被 `lane.skill` 取到）。

---

## 4. 与 pi-desktop 插件系统的区别

pi-desktop（`vastsa/PI-Desktop`，0.15.x）是 pi 生态里唯一交付了完整用户级插件系统的产品，也是本设计最主要的参照物。但**两者在四个地方做了不同的选择**，这些差异不是"谁更好"，而是"面向的产品不同"。逐条列出，避免实现时误抄。

### 4.1 总览

| 维度 | pi-desktop | Oint（本设计） | 差异性质 |
| --- | --- | --- | --- |
| **上游关系** | 自建 agent sidecar（Node） + Rust host-core，pi 只是 Agent 引擎 | 主进程独占 pi harness，无第二个运行时 | **架构根本不同** |
| **插件宿主** | 每插件一个 `utilityProcess` + JSON-RPC broker + 16 个宿主服务 | 同样 `utilityProcess`，但宿主服务面窄得多 | 规模差异 |
| **对 pi 的对接** | `contributes.agentExtensions` 直接暴露 pi CLI 的 `ExtensionAPI`（**跑在 agent 进程内，不沙箱**） | **不暴露** pi 的 hooks 给插件；只给宿主 API | **安全取舍不同** |
| **贡献物是否进面板** | **进**：技能有独立 catalog、MCP 有 Plugins 页、设置有 schema 表单 | **不进**：只从系统提示与工具表出去（§3.9） | **产品决策不同** |
| **清单** | 私有 `manifest.json`（`schemaVersion: 1`） | Agent Plugins `plugin.json` + `extensions.dev.oint` | **标准化取舍不同** |
| **技能格式** | 自定义 frontmatter（`skills/*.md` + `name`/`description`） | Agent Skills 规范（`skills/<name>/SKILL.md`） | 标准符合性 |
| **UI 扩展** | 插件自带 HTML，跑在独立沙箱窗口/停靠视图 | 描述式渲染为主，webview 为辅 | **CSP 约束导致** |
| **市场** | 已有 `plugins.aiuo.net/catalog.json` + 独立仓库 | 二期，先做本地目录 | 成熟度 |
| **签名** | 无（sha256 + source pin + 人工审核） | 同（二期再评估） | 一致 |

### 4.2 差异一：对 pi 底层能力的开放程度（最重要）

**pi-desktop 开放了 pi 的 `ExtensionAPI` 给插件**，这是一个 40+ 事件、可注册工具/命令/provider 的完整接口，通过 `contributes.agentExtensions` 声明、用 jiti 加载（所以 `.ts` 免构建）。它的文档对这个选择的代价说得很直白：

> **It is not sandboxed.** The module runs in the agent process with the same access as the agent's own tools. `agent.extension` is a high-risk permission the user confirms explicitly.

**Oint 不应该抄这一条。** 三个理由：

1. **Oint 没有独立的 agent 进程。** pi-desktop 的 agent 跑在 sidecar 里，把它开放出去污染的是一个可重启的子进程；Oint 的 harness 在**主进程**（`runtime.ts`），开放 `ExtensionAPI` 等于把插件的代码放进持有 SQLite 句柄、API Key 与 IPC 网关的进程。这与本报告 §1.3 约束 C 直接冲突。
2. **Oint 的运行时钩子已经被自己用了三个**（`before_tool` 权限门、`after_tool` 重复守卫、`transform_context` 注入提醒）。再让插件挂同一批钩子，**权限门与插件钩子的执行顺序会变成一个安全问题**——插件若能拿到 `before_tool` 并返回 `{block: false}`，权限门就被绕过了。
3. **pi 的 `HookMap` 里 `before_tool` 的返回值可以改 args**（`agent-harness.d.ts:556-557`：`result: { args?, block? }`）。让第三方改写工具参数、且 pi 明确"**No re-validation is performed after mutation**"（pi-coding-agent 的 `tool_call` 注释），这与 Oint 的审批模型不兼容。

**替代方案**：Oint 只开放**宿主 API**（§3.5），不开放 pi 的钩子。需要策略类扩展时（未来的事），用**宿主自己的窄钩子**，由宿主在调用 pi 钩子**之前/之后**执行，且**宿主钩子无权改 args、只有权 block**。

### 4.3 差异二：贡献物进不进面板

pi-desktop 的做法是**treat 插件贡献物为一等公民**：

- 技能进 prompt 的 catalog（最多 32 个/插件、每个 ≤128 KiB、description ≤240 字符），且**必须有 `agent.prompt.inject` 权限否则被忽略**；
- MCP server 是 `contributes.mcpServers` 声明式，有 `mcp.server.local` / `mcp.server.remote` 两个权限；
- 设置有 `contributes.settings` schema，**宿主自动生成 `string`/`number`/`boolean`/`select`/`json`/`shortcut` 六种控件的表单**；
- 每个贡献都有配额与上限（32 skills / 8 themes / 4 services / 2000 files / 50 MiB）。

Oint 的选择是**不进面板**（§3.9）。这不是"少做了一点"，而是**刻意把管理入口收敛到插件行上**。原因在 §3.9.2 已展开，核心是：**可删列表里不该出现删不掉的东西**。

**但 pi-desktop 的配额思路值得抄**：Oint 应当为自己的贡献类型定上限（技能数、单个 SKILL.md 大小、description 长度、MCP server 数），否则一个插件能把系统提示撑爆。这些数字不需要现在定，但**机制要在 P3 就有**。

### 4.4 差异三：UI 扩展的形态

pi-desktop 的插件 UI 是**自带 HTML 页面**，宿主提供两种摆放：

- **panel**：独立的无边框窗口，宿主预留 46px 拖拽带 + 右上角三颗窗口按钮，通过 CSS 变量 `--pi-plugin-titlebar-height` 让插件适配；
- **view**：停靠在右侧工作面板里，与 Review/Terminal/Browser/Files 并列；
- **widget**：透明无边框的悬浮球，`shape: "widget"` 时拖拽带变 0。

**Oint 做不了这个**——不是因为不想，是因为 CSP（§1.3 约束 A）：`script-src 'self'` 且无 `unsafe-inline`，插件自带的 HTML 页面若从磁盘加载会被拦。所以 Oint 的形态是**描述式渲染为主**（插件返回 JSON，宿主用白名单组件画）+ **webview 承载为辅**（走 `persist:` 独立分区，不套应用 CSP）。

**代价要说清楚**：描述式渲染表达力弱于"插件自带 HTML"。一个想要自定义交互的插件在 Oint 上做不到。**这是接受 CSP 约束的必然代价，且本报告认为值得**——渲染层持有 `window.oint` 的 70 个方法，让它加载第三方 HTML 是拿全部权限去换 UI 表达力。

### 4.5 差异四：清单标准化的取舍

pi-desktop 用私有 `manifest.json`（`schemaVersion: 1`），字段包括 `contributes`（15 类）、`permissions`、`fs`、`net`、`engines`、`activationEvents`。

Oint 采用 **Agent Plugins `plugin.json` + `extensions.dev.oint`**（详见 `docs/agent-plugins-standard-report.md`）：

- 便携层（`$schema`/`name`/`version`/`skills/`/`mcp.json`）**与其他客户端互通**；
- 私有层（`contributes`/`permissions`/`fs`/`net`/`apiVersion`）放 `extensions.dev.oint`。

**为什么这是更好的选择**：pi-desktop 的插件**只能用在 pi-desktop 上**——它的 `manifest.json` 没有任何别的客户端认识。而 Oint 按 Agent Plugins 打包的插件，只要只用 skills + MCP，**同时也是一个合法的 Codex / Cursor 包**。这是零成本换生态互通。

**代价**：Agent Plugins 的 v1 只定义 skills 与 MCP 两种组件，**Oint 需要的命令、面板、工具、provider 全都要走私有命名空间**——即"可移植的那部分很小"。这是标准的现状，不是 Oint 的选择。

### 4.6 三点值得直接照抄

尽管有上述差异，pi-desktop 有三处设计**与 Oint 的约束无关，可以原样搬**：

1. **权限 = 开关 + 范围，且读宽写窄**（§2.3 已列）。特别是"**写和删除不得声明整棵树**"这条硬规则，以及它的理由：*"the egress allowlist is what makes a broad read safe and nothing makes a broad write safe"*。
2. **热重载永不放大权限**：reload 前把新 manifest 与批准时的快照比对，任何**新增**能力中断 reload 并返回 `PERMISSION_DENIED`；移除能力立即生效。（pi-desktop 还把 `manifest.fs` 的放宽也算作"新增权限"。）
3. **`pi-plugin check` 与安装器共用同一套规则**——"check 通过即安装通过"。Oint 的 `oint-plugin check` 应当复刻安装器的每一条校验。

### 4.7 一处明确不要抄

**`.piplug` 强制"store-only（未压缩）ZIP"**，导致普通 `zip` 打的包会被安装器拒绝，作者必须用官方 devkit 打包。这是**实现细节泄漏到作者体验上**的典型例子。Oint 应当接受标准压缩（或在安装器里两种都接受）。

---

## 5. 现有功能模块 → 插件化映射

判定口径：
- **直接插件化**——边界已经清楚，抽出去就是插件；
- **内核保留**——不能抽，抽了就是提权或架构倒退；
- **暂不抽**——技术上能抽，但当前耦合度下收益低于风险。

| 模块 | 现状 | 判定 | 改造路径 | 优先级 |
| --- | --- | --- | --- | --- |
| **web 搜索/抓取**（`main/web/*`，2017 行） | provider 是编译期常量 5 家 | **直接插件化** | `WebSearchProviderImpl` 接口（`web/types.ts:101`）已经是完美的插件契约：`{id, available(), search(req)}`。把它变成 `contributes.webProviders`，内置 5 家改成"内置插件"。**这是全仓最干净的插件化候选** | **P3 首个** |
| **内置技能**（`resources/skills/*`，8 个） | 随包分发、只读、优先级最低 | **直接插件化** | 已经是文件级贡献面。改成"每个插件可贡献 `skills/` 目录"。**零新代码，只需把扫描目录从 `resources/skills` 扩展为"内置目录 + 各插件的 skills 目录"** | **P3** |
| **内置子智能体预设**（7 个，`subagent-catalog.ts`） | 写在代码里，被定义成 `BUILTIN_SUBAGENTS` | **直接插件化** | 与技能同构。插件贡献 `subagents/` 目录或 `contributes.agentPresets` | P4 |
| **魔法提示** | 文件级，两个来源 | **直接插件化** | 同技能 | P3 |
| **浏览器自动化**（`main/browser/*`，5264 行） | 主进程单例 + `BrowserAutomation` 接口 | **内核保留** | 它操作的是**用户眼前的 `WebContents`**，是 UI 资源不是能力。抽出去会让"谁能操作用户的页面"变成插件权限问题。**但**：允许插件通过 `oint.browser.*` **请求**操作，由宿主执行——即"能力化"而非"抽出" | — |
| **终端 PTY**（`main/terminal/*`，456 行） | 主进程单例，给人用 | **内核保留** | 同上：真 PTY 是最高风险面。`permissions.ts:10` 的注释已经把"持久终端不引入新权限面"作为产品定位——不要为了插件化破这条 | — |
| **后台作业**（`main/pisdk/jobs.ts`，671 行） | 会话级进程管理 | **内核保留** | 作业是"模型的后台进程"，与 agent 生命周期强绑定 | — |
| **MCP 桥**（`main/mcp/*` + `pisdk/mcp-servers.ts`） | 进程内连接池 | **内核保留，但成为插件的一个能力** | MCP 本身就是插件机制。插件可以 `mcp.register` 声明自己的 MCP server，但连接池仍由主进程持有 | — |
| **子智能体运行时**（`subagent-runner.ts`，608 行） | 会话生命周期管理 | **内核保留** | 它是 agent 循环的一部分。插件的贡献面是**定义**（谁可以被派），不是**机制**（怎么派） | — |
| **三个面板：审查 / 文件 / 终端** | `features/right-panel/*` | **暂不抽** | 它们深度读取 `chat-store`、`session-store`、`ui-store`。抽成插件需要先把这些 store 的能力化 RPC 做出来（P4 之后）。**但它们是最适合验证"面板注册表"是否好用的内置样本**——P1 时先把它们的注册路径走通 | P5 |
| **设置分栏：通用 / 服务 / 数据 / 关于** | `features/settings/panels/*` | **内核保留** | 它们是宿主自身的配置 | — |
| **设置分栏：MCP / 技能 / 子智能体 / 提示模板 / 网络** | 同上 | **暂不抽** | 这五个是"管理插件贡献物"的界面。**正确做法不是把它们变成插件，而是把它们变成"插件管理面板"的视图** | P4 |
| **权限规则库**（`permission-rules.json`） | 文件级 | **内核保留** | 见 §6 缺口二：这是安全边界本身 | — |
| **会话持久化**（SQLite） | 主进程 | **内核保留** | 插件通过 `session.read` 能力读取，永不直接持有句柄 | — |
| **模型 provider**（`providers.ts`，158 行） | 两种 OpenAI 格式 | **暂不抽** | `createProvider` 已是清晰的接口，但让插件注册 provider 意味着插件能接触 API Key。**二期再评估**，且必须走"宿主持有 Key、插件只给 baseUrl 形态"的形态 | P5 |
| **标题生成 / AI 审批 / 重复调用守卫** | `pisdk/*` | **内核保留** | 它们是 agent 质量的组成部分，不是扩展点 | — |

**统计**：18 个模块里，**4 个直接插件化**（web provider、技能、子智能体定义、提示模板）、**9 个内核保留**、**5 个暂不抽**。这个比例是健康的——插件系统不该以"把所有东西都变成插件"为目标。

---

## 6. 插件落地前必须修的既有缺口

以下四项都是**今天就需要修**的（不是为插件而修），但在有第三方代码之后严重性会跃升。每条给出文件级证据与修法。

### 缺口一：`grep` / `glob` 零确认越界读 —— **P0，最高优先**

`src/main/pisdk/tools/search.ts:8-11` 的注释原文：

> `path` 只决定「检索根」，**不是**围栏：可以是工作目录之外的任意绝对路径……因此这里不调用 `validatePathAccess`

而 `permissions.ts:60-75` 的 `LOW_RISK_TOOLS` 包含 `grep` 与 `glob`，`gateTool` 对 `low` **直接 `return undefined`——连审批卡都不创建**（`runtime.ts:1785-1787`）。

**后果**：`grep { path: "C:\\Users\\<u>\\.oint", pattern: "apiKey" }` 是一次**零确认**的凭据读取。`settings.json` 是文本、小于 1 MiB 的过滤阈值，唯一的拦截是二进制 sniff。

**为什么 README 里说的 C-1 已经修了、但问题仍在**：`sessionAllowedRoots`（`runtime.ts:1017-1038`）确实**不包含** `dataDir()` 本身，`runtime.test.ts:249-259` 用真实的 `validatePathAccess` 钉住了 `settings.json` / `permission-rules.json` / `sessions-index.json` 不可经 `read`/`write`/`edit` 读取。**但 grep/glob 走的是另一条完全不受守卫的路。**

**修法**：`resolveSearchRoot` 增加 `validatePathAccess(root, sessionAllowedRoots(cwd, appPath))`；或把 grep/glob 移出 `LOW_RISK_TOOLS`。**推荐前者**——检索本来就该限定在工作区内，改成需审批会把"找一段代码"变成点卡地狱。

### 缺口二：`settings.write` 无写侧校验 —— **P0**

`src/main/ipc/settings.ts:10-11`：

```ts
ipcMain.handle(IPC.settings.write, async (_event, next: Settings) => {
  await saveSettings(next);
```

`settings/store.ts:478-486` 的 `save()` 直接 `JSON.stringify(toPersisted(next))`，而 `toPersisted` 是 `{...settings, services, webSearch}`——**任意额外键会被 spread 落盘**。所有校验（`normalizePermissionMode` 非法回落 `default`、`clampInt`、`normalizeMcpServers`）**只在 `load()` 生效**。

**后果**：渲染层可以写 `permissionMode: "full"`，缓存立即更新（`store.ts:485`），**审批链当场失效**。今天渲染层是我们自己的代码，所以不是漏洞；一旦有任何第三方代码进入渲染层它就是。

**修法**：（a）把 `mergeWithDefaults` 的归一化逻辑在 `save()` 里也跑一遍（**这是最小改动，且立刻消除一整类问题**）；（b）插件**永远不给 `settings.write`**，只给插件命名空间的读写（§3.5 已含此纪律）。

### 缺口三：`exec` 全量继承环境变量 —— **P0**

`exec-env.ts` 的路径守卫**只覆盖路径类方法**；`exec` 原样透传（`exec-env.ts:253-255`，注释自述"路径守卫在这一层**不构成任何限制**"）。且没有传 `shellEnv`，**子进程继承整个主进程环境**——包括 `OINT_HOME` 与进程里存在的各类凭据。

**后果**：一次批准后的 `cat ~/.oint/settings.json` 即可读走凭据；若用户对 `cat` 点过"始终允许"，`deriveRulePattern` 会写 `{toolName:"bash",pattern:"cat"}` 并**永久放行所有 `cat` 调用**。

**修法**：`createExecEnv` 显式构造 `shellEnv` 白名单（PATH、HOME/USERPROFILE、TEMP、LANG 等），**剔除 `OINT_HOME` 与一切 `*_API_KEY` / `*_TOKEN`**。`transport.ts:97` 的 MCP 子进程是同一个问题（见缺口五），一并修。

### 缺口四：没有 `setPermissionRequestHandler` —— **P1**

全仓 `grep setPermissionRequestHandler|setPermissionCheckHandler` **零命中**。webview guest 用独立分区 `persist:oint-browser`（`BrowserPanel.tsx:201`）、**不套应用 CSP**（`window.ts:125-126` 是刻意的），且没有权限请求处理器——按 Electron 默认，guest 页面可能直接获得摄像头 / 麦克风 / 地理位置 / 通知等能力。

**为什么与插件相关**：如果插件 UI 走 `<webview>` 承载（§3.6 形态二），这条缺口会被直接继承。

**修法**：给 browser 分区装一个 `setPermissionRequestHandler`，默认 `deny`，用一张显式 allowlist 放行（如 `fullscreen`、`clipboard-read`）。

### 缺口五：MCP 子进程继承全量环境变量 —— **P0（新增）**

`src/main/mcp/transport.ts:97`：

```ts
env: { ...process.env, ...config.env },
```

MCP server 子进程拿到主进程的**全部环境变量**——包括 `OINT_HOME` 与进程里存在的各类凭据。这与缺口三是同一个形状，只是出口从 `exec` 换成了 MCP。

**今天为什么不是漏洞**：MCP server 是**用户自己在设置面板里填的**，用户填的 server 拿到用户的环境变量是合理的。**一旦 `mcp.json` 能由第三方插件提供**（Agent Plugins 组件，见 `docs/agent-plugins-standard-report.md` §2.2），提供者就从"用户"变成了"插件作者"。

**修法**：改为显式白名单（PATH、HOME/USERPROFILE、TEMP、LANG 等）+ 叠加 `config.env`。规范**明确授权**客户端这样做——Agent Plugins §9.1 原文：*"The client chooses the base subprocess environment and MAY inherit, omit, or sanitize ambient variables."*

### 缺口六：MCP 子进程 `shell: true` 与引号化漏洞 —— **P0（新增）**

`src/main/mcp/transport.ts:89-101`：

```ts
const useShell = process.platform === "win32";        // Windows 恒开 shell
const command = useShell ? quoteForShell(config.command) : config.command;
const args = useShell ? config.args.map(quoteForShell) : config.args;
...
...(useShell ? { shell: true } : {}),
```

而 `quoteForShell` 的判据是 `/[\s"^&|<>()]/`（`transport.ts:68`）——**不含 `%` 与 `!`**，而这两个恰是 `cmd.exe` 的变量展开与延迟展开字符。代码注释自己写着"真正有歧义的参数（含 % 或 !）建议写成 .cmd 脚本再调用"（`transport.ts:64`），即**这个洞是被知道并接受的**。

**今天为什么不是漏洞**：`command` / `args` 由用户自己在设置面板里填，风险自担。**一旦 `mcp.json` 由插件提供，`command` 就变成"插件作者可控、以用户权限经 shell 执行"的字符串。**

**修法**：向 Agent Plugins 规范靠拢——`command` 是**单个可执行 token，不是 shell 命令串**。规范原文：*"Clients MAY use a platform-specific command interpreter when required to launch the resolved executable, such as a `.bat` or `.cmd` script on Windows, but **MUST preserve `command` as one token and pass `args` separately**."* 即：只在确认目标是 `.cmd`/`.bat` 时才经解释器，且**不做字符串拼接**。

> **一条方法论**：缺口三 / 五 / 六今天都不是漏洞，因为这三处的输入都来自用户自己。判据不是"代码有没有变"，而是"**谁能控制那个字符串**"。插件系统改变的是后者。

### 缺口优先级

| 缺口 | 优先级 | 不修的后果 | 与插件的关系 |
| --- | --- | --- | --- |
| 一 · grep/glob 越界读 | **P0** | 零确认读走 `settings.json` | 今天就可利用，与插件无关 |
| 二 · `settings.write` 无校验 | **P0** | 渲染层可写 `permissionMode: "full"` | 插件进渲染层则直接提权 |
| 三 · `exec` 全量环境 | **P0** | 子进程读走凭据 | 同 |
| 四 · 无 `setPermissionRequestHandler` | P1 | guest 获得摄像头/麦克风等 | 插件 UI 走 webview 时继承 |
| 五 · MCP 全量环境 | **P0** | 第三方 MCP server 读走凭据 | **采纳 `mcp.json` 组件的前置条件** |
| 六 · `shell: true` 引号化 | **P0** | 插件可控字符串经 shell 执行 | **同上** |

---

## 7. 附录

### 7.1 本报告的调研方法

- Oint 侧：逐文件读源码（`read`/`grep`/`glob`），未依赖任何二手描述。
- DSH 侧：本机 `D:\DSH Desktop\resources\app\`。cordis 内核随包发布完整 TypeScript 源码，是最高置信度证据；其余为 `lib/*.js` 打包产物（含 `//#region` 原始 JSDoc）。详见 `docs/research/dsh-plugin-architecture.md` 与 `docs/research/dsh-client-plugin-architecture.md`。
- pi-desktop / Codex / Claude Code / opencode / Cline / Zed / Raycast / VS Code / Obsidian：直接抓取一手产物（GitHub raw / GitHub API / npm registry / jsDelivr / 官方文档），未使用搜索结果片段。
- **环境限制**：本次调研期间 `web_search` 全程 HTTP 401 不可用，所有外部结论均来自直接抓取。未取得的内容在来源报告中逐条标注为 unverified。

### 7.2 本机交叉验证发现（DSH 侧）

调研过程中在 `C:\Users\31645\.dsh\profiles\web\cordis.patch.yml` 发现一处**不存在的键 `- override:`**。按 `cordis-plugin-include/src/index.ts:105-108`，非法键只会 warn 并**静默跳过**——即该文件里的 `searchProvider: grok` **从未生效**。正确写法是顶层 `- id: web` + `config:`（且因 config 是整体替换而非深合并，必须重述全部键）。

**这是给 Oint 的一条直接教训**：插件配置的**非法键必须报错，不能 warn 后跳过**。DSH 这一处静默失效的配置活了很久没人发现，正是因为"配置写错了"和"配置生效了但没效果"在界面上长得一样。

### 7.3 未决问题（需要产品决策，不是技术问题）

1. **插件是否允许在渲染进程跑代码？** 本报告的建议是**不允许**（描述式 UI + webview）。如果产品上必须允许（例如希望插件能深度定制面板交互），则必须先解决约束 B（`window.oint` 的 70 个方法需要按插件能力逐项开放），工作量数倍于本报告方案。
2. **市场由谁审核？** pi-desktop 靠 source pin + 人工审核；Obsidian 已转向自动扫描 + 安全评分卡。**在做出决定之前，市场应当保持"用户手动添加源"的形态**（本报告 P5 的建议）。
3. **是否兼容 Agent Plugins 1.0.0 标准？** 该标准（Amazon/Cursor/Microsoft/OpenAI/Vercel 共同发起）只强制 `$schema` + `name`，把厂商私有能力放在 `extensions.<reverse-domain>`。**Oint 的清单已经按这个形态设计**（§3.3），将来若要兼容，只需把 `contributes`/`permissions` 挪进 `extensions.dev.oint` 即可——这是一个**低成本的可选项**，不必现在决定。

### 7.4 来源索引

| 来源 | 类型 | 用于本报告的结论 |
| --- | --- | --- |
| `docs/research/dsh-plugin-architecture.md` | 本仓库（子代理产出，502 行） | DSH 的 cordis 内核、三层 manifest、API 面、权限模型的全部结论 |
| `docs/research/dsh-client-plugin-architecture.md` | 本仓库（子代理产出） | DSH 客户端插件、slot 系统、HMR、客户端 bundle 构建链 |
| `vastsa/PI-Desktop` 仓库 + `docs/spec/07-plugins/*`（16 篇） | 一手抓取 | manifest schema、权限范围模型、utilityProcess broker、生命周期预算、`.piplug`、市场、热重载权限规则、支持矩阵 |
| `agent-plugins.org` 规范 + `plugin.schema.json` | 一手抓取 | 极简 manifest + extension namespace 模式 |
| `developers.openai.com/codex/*`、`learn.chatgpt.com/docs/*`、`codex-rs` 源码 | 一手抓取 | Codex 的 hooks 哈希信任、config 优先级链、沙箱机制（bwrap 而非 Landlock）、Agent Plugins 支持时间线 |
| `code.claude.com/docs/en/*` | 一手抓取 | Claude Code 的 manifest / marketplace / 33 个 hook 事件 / 安全姿态原文 |
| `opencode.ai/docs/*` + `sst/opencode` 源码 | 一手抓取 | V1/V2 hook API 与迁移教训、plugin RPC、slot 名单、工具覆盖语义 |
| `zed.dev/docs/extensions/*` + `zed-industries/zed` 源码 | 一手抓取 | WASI 沙箱实现（`wasm_host.rs`）、`[[capabilities]]` 三种能力、默认值反例 |
| VS Code / Raycast / Obsidian / Cline 官方文档 | 一手抓取 | 进程隔离 ≠ 权限边界的逐字引文、策展型商店实践 |
| Electron 官方文档（utilityProcess / sandbox / context-isolation / security） | 一手抓取 | 进程模型选型的依据 |

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09 | 初版：六路并行调研（Oint 主进程 / Oint 渲染层 / Oint 安全层 / DSH / pi-desktop + pi 生态 / Codex + Claude Code + opencode 等横向对比）合并成稿 |
| 2026-09 | 修订 1：确立"插件贡献物不进既有功能面板"为核心设计原则（§3.1 第 2 条、§3.9），并把 `resolveSkillDirs` / `sessionAllowedRoots` 的改动落到 P3 |
| 2026-09 | 修订 2：新增 §4「与 pi-desktop 插件系统的区别」，逐条对照四个差异与三条可照抄项；明确**不向插件开放 pi 的 `ExtensionAPI`**及其三条理由 |
| 2026-09 | 修订 3：§6 缺口清单从 4 条增至 6 条（MCP 子进程环境变量白名单、`shell: true` 引号化漏 `%`/`!`），与 `docs/agent-plugins-standard-report.md` §2.3 对齐 |
