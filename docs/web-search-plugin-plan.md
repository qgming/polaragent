# 网络搜索插件化 + 插件模态窗 · 方案

> **⚠️ 范围变更（2026-09-24）：网络搜索这一半作废。** 用户决定**不新增、也不把网络搜索改成插件**（它继续是宿主能力）。
> 本文只剩 §4 的 **Phase 1（插件模态窗形态）** 被采纳并已落地 —— 见 `docs/plugin-modal-surface-report.md`；
> 下面的 Phase 2 / 3 / 5 与 §3 的归属表不再执行，保留作为当时的分析记录（尤其是 §2 那四条"为什么不能按字面搬"的理由，
> 它们是当初否掉这个方向的依据）。

> 目标（用户原话）：**「把网络搜索相关的功能和工具改成一个内置插件；这个插件点开不是右侧面板，而是一个类似设置模态窗 / 插件模态窗这样的组件」**
> 结论：界面形态**可以**（要新增第三种插件界面形态）；「工具搬进插件」**不能按字面做**，会倒退三件事 —— 见 §2。
> 本文只给方案与决策点，不含实现。

---

## 0. 摘要（四句话）

1. **界面可以**：插件的 `surfaces[].kind` 今天只有 `panel` / `window`，加第三种 `modal`（宿主 = 现成的 Radix `Dialog` + 现成的 `<webview>` 宿主组件）即可，成本主要在一条**今天就会静默出错的归属判定路径**上（§5 陷阱 1）。
2. **工具不要按字面搬**：插件工具一律走网关 `plugin__<key>__call`，而 `assessToolRisk` 对表外工具名一律判 `high` —— 检索每次调用都要用户点一次批准卡，而 `permissions.ts` 里写明了「检索是交互式动作，要审批就等于不可用」。此外模型还得先调 `plugin_tools` 查参数 schema。
3. **搬走的是「身份 + 配置界面 + 生命周期」，不是执行**：插件出现在插件管理里、有自己的模态窗、负责 provider / 密钥 / 参数 / 探测；**存储与出站仍由宿主持有**（密钥继续走 `safeStorage` 加密，出站继续走 `main/web/network.ts` 的「公网地址强制 + 连接钉死 + 仅同源重定向」）。
4. 落地后：设置模态窗的「网络搜索」分栏退休，插件模态窗成为唯一配置入口；而这个插件的权限卡上**没有任何危险权限**（无 net、无 fs、无 shell）。

---

## 1. 现状（证据）

### 1.1 今天的「网络搜索」由哪些零件组成

| 零件 | 位置 | 说明 |
| --- | --- | --- |
| 双端契约 | `shared/contracts/web.ts` | `WEB_SEARCH_PROVIDERS`（5 家，编译期常量）、`WebSearchSettings`、details 形状、错误码、工具名常量 `web_search` / `web_fetch` |
| provider 接口 | `main/web/types.ts` | `WebSearchProviderImpl { id, available(), search() }` + `WebFetchProviderImpl` |
| 服务层 | `main/web/service.ts` | provider 选择、结果上限、错误归一（上限归服务层，模型只能收紧） |
| 五个实现 | `main/web/search/{searxng,providers}.ts` | searxng（自定义实例清单）与四家 API provider |
| 抓取后端 | `main/web/fetch-http.ts` + `network.ts` | HTML 转文本、超时、**出站加固**（公网地址强制 / 连接钉死 / 仅同源重定向） |
| 装配点 | `main/web/index.ts` | 生产装配，设置每次调用现取（改完立即生效） |
| 工具层 | `main/pisdk/tools/web.ts` | 只做模型可见层：schema / 校验 / 结果格式化 / details |
| 注入 | `main/pisdk/bootstrap.ts:96` → `runtime.ts:2023,2320` | `deps.web`，主代理与子智能体**都**拿得到（子智能体应该能联网） |
| 风险档 | `main/pisdk/permissions.ts:60` | 两个工具都在 `LOW_RISK_TOOLS`（免审批），理由写在同处注释里 |
| 系统提示 | `runtime.ts:827-848` | 「需要外部信息时用 web_search」那两句**按 `settings.webSearch.enabled` 条件拼接** —— 避免「提示里讲了、工具表里没有」 |
| 设置面板 | `renderer/features/settings/panels/WebPanel.tsx`（457 行） | provider 表单 + 密钥 + 「测试连接」 |
| 探测通道 | `main/ipc/web.ts` | `IPC.web.test`：用**草稿配置**发一次真实检索（不动已保存的设置） |
| 密钥落盘 | `main/settings/store.ts:430,442` | `encodeApiKey` → `safeStorage` 加密；加密不可用时**告警 + 回退明文** |

### 1.2 今天的插件界面形态

- 声明：`PluginSurfaceDecl { id, kind: "panel" | "window", title, entry, shape, width, height, logo… }`（`shared/contracts/plugin.ts`），校验器在 `main/plugins/manifest.ts:291-302` —— **kind 只接受 panel / window，且各自强制要求 `ui.panel` / `ui.window` 权限**。
- 打开：`main/plugins/surfaces.ts:133 openPluginSurface()` —— `window` 由主进程建 `BrowserWindow`；`panel` **只回答一个 kind，真正的宿主是渲染层**（`plugins-store.ts:197` → `ui-store.openRightPanel(plugin:<id>:<surface>)`）。
- 桥：所有形态共用 `window.oint`（`shared/contracts/surface.ts`）：`info / ready / close / storage / on / fetch / writeText / notify / workspace / exec`。
- 身份：主进程按 **webContents 的 session（分区）** 反查插件（`surface-owners.ts` + `surfaces.ts:338 claimSurfaceBySession`），**身份不进参数** —— 这是这套桥最关键的一条设计。
- 宿主：`<webview>` 的挂载与骨架屏在 `PluginSurfacePanel.tsx`（渲染层通用组件，`surface.url` / `surface.partition` 都由**主进程算好**）。
- 模态窗基础设施：`components/ui/dialog.tsx`（Radix），`SettingsModal` / `PluginsModal` / `SearchModal` 三个模态由 `ui-store` 的 `settingsOpen / pluginsOpen / searchOpen` 管，**三者互斥**。

### 1.3 三条决定方案的既有约束

**约束 1 · 插件工具走网关，且未知工具名 = 高风险。**
`pluginGatewayName()` 的注释写明「一个插件恒定只占一个工具位」（理由：工具表长度可预测 + 名字集合稳定）。`permissions.ts` 的 `assessToolRisk` 对 `LOW_RISK_TOOLS` 之外的一切返回 `high`，插件工具名不在任何白名单里。

**约束 2 · 工具名进入内核的 `activeToolNames`（创建会话时播种）。**
`runtime.ts:2015-2020` 的注释：名字**消失**会让此后每个请求以 `configured_tools_unavailable` 直接失败。所以宿主对插件工具的做法是「**网关常驻**，插件没跑时调用返回一句可读说明」（`plugin-catalog.ts` 顶部）。
⚠️ 但今天 **web 工具是「设置关掉也在表里、调用时才报错」**：`buildTools` 只要拿到 `webService` 就装配这两个工具，`webSearch.enabled=false` 由 `resolveSearchProvider` 抛 `WEB_DISABLED`。这条既有行为正好是本次要复用的形状（§4 Phase 3）。

**约束 3 · 插件界面的出站与密钥都不在插件的射程内。**
`net-guard.ts`：只允许 http/https、host 必须在清单 `net.domains` 白名单里（`*.example.com` **不**匹配根域）、拒绝字面量私网地址、重定向逐跳检查 —— 且明确写着它**挡不住 DNS rebinding**。
而 `web_fetch` 按设计要抓**任意公网 URL**，searxng 要连**用户自己填的实例** —— 两者都不符合白名单的形状。
密钥：宿主设置走 `safeStorage`；插件私有存储（`surface-storage.ts`）是**明文 JSON**、上限 1 MiB。

---

## 2. 为什么「把工具改成一个内置插件」不能按字面做

| 若按字面做 | 后果 | 证据 |
| --- | --- | --- |
| `web_search` 变成 `plugin__web-search__call` | 模型要先调 `plugin_tools` 才知道 `query` 怎么传 —— 一个每轮都在用的高频工具退化成两步 | `process-host.ts:105-129`、`plugin-catalog.ts` |
| 工具名不在低风险白名单里 | **每次检索弹一张批准卡**。`permissions.ts` 的原文：「检索是交互式动作，要审批就等于不可用」 | `main/pisdk/permissions.ts:54-59,120` |
| 插件停用 / 崩溃 | 名字消失 → 该会话此后每个请求 `configured_tools_unavailable`（这正是网关常驻要解决的问题） | `runtime.ts:2015-2020` |
| details 形状跨进程 | 渲染层的搜索结果卡（`WebSearchDetails`）与系统提示的「外部内容不可信」前缀都要重做一遍 | `shared/contracts/web.ts`、`tools/web.ts:64` |
| 子智能体 | `deps.web` 是主代理与子智能体**共用**的那一份注入 | `runtime.ts:2023,2320` |

**一句话**：`web_search` / `web_fetch` 是内核级能力（工具名、风险档、系统提示、子智能体四处耦合），而插件工具是「扩展位」。把它塞进扩展位是把能力降级，不是把它插件化。

---

## 3. 推荐形状：谁拥有什么

| 关注点 | 归属 | 为什么 |
| --- | --- | --- |
| 工具名 `web_search` / `web_fetch`、schema、details、免审批档位 | **宿主**（不动） | 见 §2 |
| 系统提示里那两句 | **宿主**（不动，但判据要改成「有效开关」） | 见 §4 Phase 3 |
| 出站加固（公网强制 / 连接钉死 / 同源重定向） | **宿主** | 插件的 `net.domains` 白名单装不下「任意公网 URL」，而放宽它等于把整个插件的出站边界作废 |
| 密钥的存储与加密 | **宿主**（不动） | 插件存储是明文 JSON；且密钥一旦给到插件进程，就再也拦不住它 exfiltrate |
| 总开关、provider 选择、参数（maxResults / 抓取上限 / 超时） | **插件模态窗**（键仍在宿主设置里） | 这就是用户要的「功能归插件」 |
| 能力身份：出现在插件管理、可停用、有权限卡、有界面 | **插件** | 插件系统第一次承载一个真实产品功能，而不是样例 |
| provider 的**存在**（有哪几家引擎） | 宿主（本轮不动） | 真正「可被插件扩展」要另加 `contributes.webProviders`，见 §4 Phase 5 |

---

## 4. 分阶段实施

### Phase 1 · 插件界面新增 `modal` 形态（宿主能力，0.5–1 天）

目标：任何插件都能声明一个「应用内模态窗」界面。**不是内置特权**（见 §6 决策 2）。

1. `shared/contracts/plugin.ts`
   - `PluginSurfaceDecl.kind: "panel" | "window" | "modal"`；
   - `PLUGIN_PERMISSIONS` 加 `ui.modal`（**不复用 `ui.panel`** —— 权限卡上要能读出「它会在这里开一个模态窗」）；
   - `PluginSurfaceOpenResult` 加 `{ kind: "modal" }`；`PluginSurfaceInfo.kind` 同步。
2. `main/plugins/permission-risk.ts`：`"ui.modal": "low"`（`Record<PluginPermission, …>` 会**编译失败**逼着改，这是刻意的）。
3. `renderer/features/plugins/plugin-permissions.ts`：加词条（有测试断言「每一项都有文案」）。
4. `main/plugins/manifest.ts:291-302`：接受 `modal`，kind → 权限映射 `modal → ui.modal`；`shape` 仍然只对 `window` 有效。
5. `main/plugins/surfaces.ts`
   - `openPluginSurface`：`panel` 与 `modal` 都返回给渲染层（宿主都在渲染层），只有 `window` 在这里建窗；
   - **`claimSurfaceBySession` 必须改**：现在写死 `find(item => item.kind === "panel")` —— 一个只有 modal 的插件会 `return false`，于是它的界面被当成**普通浏览器 guest**（桥全被拒 + 被浏览器自动化接管）。改法见 §5 陷阱 1。
6. 渲染层
   - `ui-store`：`pluginModal: { pluginId, surfaceId } | null` + `openPluginModal / closePluginModal`，加入 `settingsOpen / pluginsOpen / searchOpen` 那个**互斥**集合；
   - `plugins-store.openSurface`：`{ kind: "modal" }` → `openPluginModal`；
   - 新组件 `features/plugins/PluginSurfaceModal.tsx`：`Dialog` + **复用现成的** `PluginSurfacePanel`（它只要一个 `surface: PluginSurfaceInfo`）；尺寸取 `decl.width / height`，标题取 `surfaces[].title`（已支持 `{en, zh-CN}`）；
   - 挂载点：`app/SidebarShell.tsx`（三个模态的邻居）；
   - `PluginDetailDialog.tsx:352`：kind 文案加第三支（`plugins.surfaceModal`）；i18n 双语词条。
7. 顺手补一个**今天就不存在的事件**：插件页面调 `window.oint.close()` 时，面板那条路只摘了归属、**标签不会关**（`surfaces.ts:277-281` 注释里提到的 `plugins:surfaceClosed` 在全仓不存在）。模态窗更需要它（「保存并关闭」是自然动作）。见 §5 陷阱 2。
8. 测试：manifest 校验（modal 必须申请 `ui.modal`）；`openPluginSurface` 返回第三态；归属判定（modal-only 插件能登记、panel+modal 认对 surface）；渲染层 store 与会话隔离；`use-plugin-panels` 仍然只收 `panel`（它今天已经按 kind 过滤 ✓，用测试钉住）。

### Phase 2 · 网络搜索插件本体（1.5–2 天）

**插件包** `resources/plugins/web-search/`（id `dev.oint.web-search`，权限：`ui.modal` + `ui.theme` + `storage` + `web.config`〔新〕+ 可选 `commands.register`）：

- `plugin.json`：一个 `kind: "modal"` 的界面（标题「网络搜索设置」）+（可选）一个 `main.cjs` 注册命令「打开网络搜索设置」，让命令面板也能进。
- `ui/index.html` + `ui/panel.js`：把 `WebPanel.tsx` 的表单搬过来（provider 单选、密钥输入 + 「已保存」态、各家参数、maxResults / 抓取上限 / 超时、测试连接、总开关）。样式沿用 `git-status` 的内联 CSS + `data-theme` 跟随。
- **窄通道**：桥上加一个子域 `window.oint.config`（只对声明 `web.config` 的插件开放）
  - `config.get()` → `{ enabled, provider, maxResults, fetchMaxOutputChars, fetchTimeoutMs, providers: { [id]: {...非密字段, hasApiKey: boolean} } }` —— **密钥只回布尔，永不回明文**；
  - `config.set(patch)` → 写 `settings.webSearch`，密钥仍然走 `encodeApiKey`（加密只有一处判断）；
  - `config.test({ provider, config })` → 复用 `main/ipc/web.ts` 的 `testProvider`（把它挪进 `main/plugins/surface-config.ts`，`IPC.web.test` 随 WebPanel 一起退休）。
  - 权限 `web.config` 风险档：**medium**（它能改「查询发给谁」——但改不了「谁去发」，出站加固仍在宿主）。
- 桥上加 `info.locale`（与 `info.theme` 对称）：插件自己的界面文案不进宿主语言包（约束 D），它必须知道当前语言。
- **退休清单**：`builtin-sections.tsx` 去掉 `web` 分栏；删 `WebPanel.tsx` + `web-panel.test.ts`；删 `IPC.web.test`；清掉只服务于那张表单的 i18n 键（`settings.webSearchSection` 等）；`settings.webSearch` **字段与落盘格式不动**（零迁移成本，这是「存储在宿主」的直接收益）。

### Phase 3 · 启停耦合与系统提示（0.5 天）

- 今天：`webSearch.enabled=false` → 工具**仍在表里**，调用时抛 `WEB_DISABLED`；系统提示不提它们。**插件的启停要照这个形状做**（约束 2：名字不能消失）。
- 有效判据：`可用 = 插件启用 && settings.webSearch.enabled`。
  - 工具侧：`WebService` 外面包一层，插件停用时 `search/fetch` 抛一句可读错误（「网络搜索插件已停用，在插件管理里启用它」）；
  - 提示侧：`runtime.ts:917` 的 `buildToolGuidance(settings.webSearch.enabled)` 改为接收**算好的有效布尔**（装配处算一次，读插件注册表快照）。
- 两个开关的优先级要写进文档与界面文案，否则用户会看到「插件开着但工具没有」这种读不出来的状态（这正是插件系统报告 §7.2 那条「非法配置静默跳过」的同一类教训）。

### Phase 4 · 明确不做：把 provider 执行搬进插件进程

要真搬，四条阻塞每一条都不便宜：

1. **出站形状不匹配**：`web_fetch` 要抓任意公网 URL、searxng 要连用户自填实例，而插件的出站是**清单里的静态域名白名单**。放宽它 = 插件的出站边界整体作废；
2. **密钥**：要么进插件存储（明文 JSON），要么在宿主与插件之间来回传（等于把密钥交给插件进程）；
3. **可用性倒退**：插件进程崩溃 / 停用 / 加载失败时搜索直接消失，而今天它是主进程里的一条同步装配；
4. **收益很小**：请求构造与响应解析搬到进程外，HTTP 仍必须留在宿主 —— 拆出来的是半件事，换来的是一次跨进程往返与一份要跨边界的 details 形状。

### Phase 5 · 后续（另一件事）：`contributes.webProviders`

真正让网络搜索「可被插件扩展」的做法是给第三方一个**引擎贡献点**（`docs/plugin-system-plan.md` §4.12.2 点的第一顺位真空：`dsh-free-search` 1.85 万 / `modsearch` 3.66 万下载证明这是刚需）。它要新造一个贡献点与一套「插件声明引擎 → 宿主调用」的契约，工作量和本次不是一回事，**不要捆在一起做**。

---

## 5. 陷阱清单（必须一起改的）

1. **归属判定写死了 `panel`**（`surfaces.ts:341-362`）。两个后果：只有 modal 的插件 `return false` → 被当普通 webview 接管；panel + modal 的插件会**认错 surface**。修法：身份（安全相关）继续按**分区**判定，`surfaceId`（纯记账，不影响任何权限面）在 URL 已知时按 `surfaceUrl()` 精确匹配 —— 注意 `did-attach-webview` 时刻 `getURL()` 往往是空的（`window.ts:75-84` 记过这个坑），所以要在导航开始后回填。
2. **`plugins:surfaceClosed` 只在注释里存在**。插件页面调 `close()` 后面板标签不关（已有 bug）；modal 更明显。补一条主进程 → 渲染层的事件，两个形态一起修。
3. **工具名不能因为插件停用而消失**（`configured_tools_unavailable`）。要么保留桩工具，要么按 Phase 3 的「在表里、调用时报错」。
4. **密钥语义**：`config.get()` 只回 `hasApiKey`。这条同时保护第三方插件（任何声明了 `web.config` 的插件都读不到密钥）与用户。
5. **Escape / 焦点**：Radix `Dialog` 的焦点陷阱挡不住 guest 里的按键 —— 焦点进了 `<webview>` 后 Escape 到不了对话框。保证三条路可用：X 按钮、点遮罩、插件自己调的 `close()`（依赖陷阱 2 的事件）。
6. **两个开关的优先级**要显式（Phase 3），否则「插件开着但工具没有」无从解释。
7. **i18n 两套**：宿主语言包（`ui.modal` 的权限文案、`plugins.surfaceModal`）与插件自带界面（不进语言包，靠 `info.locale`）。`surfaces[].title` 已经是双语对象，模态窗标题直接用它。
8. **权限三处同步**：`PLUGIN_PERMISSIONS` / `permission-risk.ts` / `plugin-permissions.ts` + 两条断言「全覆盖」的测试 —— 漏一处会红，这是设计而不是意外。

---

## 6. 需要拍板的三个点

| # | 决策 | 我的建议 | 备选的代价 |
| --- | --- | --- | --- |
| 1 | 工具是否真搬进插件 | **不搬**：宿主保留 `web_search` / `web_fetch`（名字、低风险、提示、子智能体），插件拿走身份 + 配置界面 + 生命周期 | 搬 = 每次调用弹审批 + 模型先查 schema + 名字稳定性问题 + details 跨进程重做 |
| 2 | `modal` 是通用能力还是内置特权 | **通用**：新 `kind` + 新权限，第三方也能用 | 内置特权（宿主 React 组件）更快，但开一个第三方永远用不了的口子，与「内置插件是样板」的既有纪律冲突 |
| 3 | 模态窗里怎么呈现已保存的密钥 | **只回 `hasApiKey` 布尔**（与今天面板的行为一致：只显示「已保存」） | 回明文便于「显示 / 复制」，但那把密钥交给了任何声明该权限的插件 |

另有一条产品建议：设置里那一栏**直接删掉**（两个入口必然漂移），可发现性由三个入口补上 —— 插件管理里的插件卡片、命令面板（插件注册的命令）、以及搜索面板。

---

## 7. 工作量与完成判据

| 阶段 | 估时 | 完成判据 |
| --- | --- | --- |
| Phase 1 | 0.5–1 天 | 一个只有 modal 界面的插件能被正确登记归属、桥可用、开关正常；`panel` / `window` 两条老路零回归 |
| Phase 2 | 1.5–2 天 | 设置里没有「网络搜索」分栏了；插件的模态窗能读写全部配置、能测连接；密钥在磁盘上仍是加密的、界面上只有「已保存」 |
| Phase 3 | 0.5 天 | 停用插件后：工具调用给出可读原因、系统提示不再提它们、**已开会话不报 `configured_tools_unavailable`** |
| 合计 | **2.5–3.5 天** | 插件管理里出现一个系统插件「网络搜索」，权限卡上只有 low/medium 项，零 net / fs / shell |

---

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-24 | 初版：现状走查（工具层 / provider 层 / 设置层 / 插件界面层 / 权限层）+ 三条硬约束 + 三阶段方案 |
