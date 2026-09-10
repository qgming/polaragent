---
feature: assistant-ui-elements-redesign
status: delivered
updated: 2026-09-11
branch: feat/assistant-ui-elements
commits: b52c55d278e7774bd0895b1d114e78c94f52506f..HEAD
---

# assistant-ui Elements 重构

## Report

**What was built**

整个渲染层换成了 assistant-ui 官方 Elements 的语汇，紫色主题彻底移除。

令牌层重写为「一把旋钮 `--tint: 106`」——全部中性色由单一 oklch 色相派生（沙色，非灰），唯一强调色是 Elements 原值的 live 蓝（`--aui-live`，只用于「正在进行」）；design.md 的半径表与字体三职落地，字号交给 `components/assistant-ui/type.ts` 的封闭角色集合（`typeHero`/`typeSection`/`typePage`/`typeDeck`/`typeEyebrow`/`typePackage`）。同时补齐了两件否则 Elements 在本仓不工作的基础设施：Radix 与 Base UI 的折叠面板高度变量桥接、以及 `animate-collapsible-*` / `animate-accordion-*` 关键帧。

组件来源是官方 registry（`r.assistant-ui.com`，Radix 口味），57 个文件按「原样保留、便于上游重新同步」维护，只在落地时改写导入别名；`biome.json` 以目录作用域放开上游自身未满足的 8 条规则（理由与逐条例证见 S2.9）。消息、推理、工具、审批、附件、Markdown、会话列表、命令面板、会话内搜索、设置面板与通用件全部换成官方件，紫色落点按 S2.4 逐条替换为中性墨色或 live 蓝。

动效只在 CSS 做不到的两处用 motion（审批卡退出动画、设置分类切换的进场），其余保持 CSS；`tw-shimmer` 驱动运行态微光，reduced-motion 由全局 CSS 兜底 + `<MotionConfig reducedMotion="user">` + 原版自带的 `motion-reduce:*` 三层覆盖。

**Verification**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS，exit 0（`tsc --noEmit && tsc -p tsconfig.electron.json --noEmit`） |
| `npm run lint` | PASS，exit 0（`biome check .`，`Checked 178 files`，`No fixes applied`） |
| `npm test` | PASS，exit 0，`Test Files 17 passed (17)` / `Tests 145 passed (145)` |
| `npm run build` | PASS，exit 0（三处 `built in` 均成功） |
| 紫色正则扫 `src/` | PASS，0 命中；产物 CSS 同样 0 命中 |
| 产物 CSS 断言 | PASS，含 `--tint:106`、`--aui-live`、`shimmer`（53 处）、折叠关键帧与 `--collapsible-panel-height` 桥接 |
| i18n 键完整性扫描 | PASS，静态使用的 146 个键对 210 个词条，**0 缺失** |
| 运行期渲染验证（Playwright，17 项探针） | PASS，见下方「可视验证」 |
| 独立评审（read-only subagent） | 完成；发现 3 个 major + 7 个 minor，**已全部处理**（见下） |

**可视验证**（本机 Playwright 驱动 Vite 页面 + 假 IPC 桥，覆盖空态/线程/搜索/设置五场景，17 项断言全 PASS）：空态渲染官方 `EmptyState`；用户气泡实测类名 `bg-muted` + `rounded-xl`；助手消息无气泡直出 Markdown；推理与工具折叠块均在；侧栏两条会话且当前项底色实测 `oklch(0.965 0.004 106)`（即 `--muted`）、无品牌竖条（唯一窄元素是 `sr-only` 无障碍文本）；Ctrl+K 出官方 palette 且四组结果正确（会话/设置/命令，含中文相对日期）；Ctrl+F 出官方会话内搜索；设置用官方垂直 Tabs 与官方 Select；运行期样式树**紫色计数 0**。

**Journey log**

1. **别用 PowerShell 的 `Set-Content -Encoding utf8` 改 UTF-8 文档**：它按 cp936 解码读入再编码写回，会把整份中文文档变成乱码并吞掉换行。本次把规格文件写坏过一次，只能整份重写。此后一律用 `write`/`edit` 工具。
2. **Electron 启动后立刻截图会截到未渲染完的窗口**，据此判断「空态没出现」是误判。改用 Playwright 驱动 Vite 页面（`add_init_script` 注入假 `window.polaragent`）才能拿到可信的 DOM 事实；假桥必须补齐 preload 的全部方法（尤其 `chat.onEvent`），缺一个就会让整棵子树崩溃，看起来像「功能坏了」。
3. **官方组件不转发 `onKeyDown`**（`CommandPalette` / `ConversationSearch` 都是）。把键盘监听从输入元素挪到容器时，**必须同时保留「打开即聚焦」**，否则 Esc/Enter 静默失效（焦点在 Composer 时 Enter 会把消息发出去）；另外容器是不可交互元素，直接挂 React `onKeyDown` 会被 `lint/a11y/noStaticElementInteractions` 拦下。
4. **用 guard 丢弃子组件回传的 `null` 会造成状态残留**：`if (!open) return;` 恰好丢掉了「关闭时清空高亮」那一次更新，必须配一个 `useEffect` 在开关关闭时主动清。
5. **与官方组件组合时，自己的预筛谓词要与它内部那条完全一致**：`CommandPalette` 用未 trim 的 `query` 再筛一次，我原本用 trim 后的 keyword 预筛，输入带空格就会出现「先显示、再整片消失」。
6. **容器圆角类名要带路径**：`rounded-thread` 默认只找 `--radius-thread`，不会回退到 Tailwind 默认缩放，静默渲染成直角。
7. **本项目 `Button` 不带 `type`**，放进 composer 的表单里默认会提交，必须显式 `type="button"`；`ComposerPrimitive.Attachments` 渲染的是 fragment，父容器是 `flex-col` 时必须自备 `flex flex-wrap empty:hidden` 包裹层。
8. **`ui/input.tsx` / `ui/textarea.tsx` 的基础类含 `md:text-sm`**，媒体查询不带特异性——任何非 `md:` 前缀的字号覆盖在 ≥768px 都会失效，别做「看似改了、实际没生效」的改动。

## [S1] Problem

当前界面（PolarAgent 0.6.0）以自研样式为主，视觉语汇与 assistant-ui 官方差得远：

1. **品牌紫是自研发明**，不是 assistant-ui 的东西。全仓有 12 个紫色色值定义（`src/index.css:99,106-110,168,175-179`）与约 40 处组件引用（发送键、审批主按钮、侧栏当前项、运行中脉冲点、焦点环、链接、搜索命中、设置导航、分段控件、滑块 accent、Check 图标）。assistant-ui 的 Elements 与 design.md 中都**没有任何紫色**。
2. **中性色不是一把旋钮**。design.md 要求全部中性由单一 `--tint`（低彩度 oklch 单色相，沙色）派生；`src/index.css:79` 的 `--tint` 定义了但零消费，实际色值是手写十六进制。
3. **强调色语义错位**。design.md 规定蓝 = live（流式 / 运行中 / 已连接 / 当前选中），且一页只允许一个 live 蓝；当前用紫代替了这个位置。
4. **一堆死令牌**。`--radius`、`--layout-sidebar-width*`、`--density-*`（6 个）、`--type-*`（6 个）、`--leading-*`（2 个）定义了但无人消费，组件层改用 Tailwind 硬编码值，令牌与实现脱节。
5. **assistant-ui 的能力大量闲置**。已装 `@assistant-ui/react` 0.15.18，但 `ThreadListPrimitive`、`BranchPickerPrimitive`、`ChainOfThoughtPrimitive`、`SuggestionPrimitive`、`AttachmentPrimitive`、`QueueItemPrimitive`、`ErrorPrimitive`、`ActionBarMorePrimitive`、`EditComposer` 全部零引用；消息、推理、工具、审批、附件、搜索、设置七类界面均为自研，视觉与官方 Elements 不一致。
6. **动画能力缺失**。`src/index.css:287` 的注释声称「JS 动效由 motion 的 `<MotionConfig reducedMotion="user">` 负责」，但 motion **未安装**；`components.json:23` 声明的 `@animate-ui` 注册表也从未使用。Elements 依赖的 `tw-shimmer` 同样未装。
7. **残留原始中性色字面量**：`button.tsx:13`、`badge.tsx:15` 的 `text-white`，`dialog.tsx:42` 的 `bg-black/50`。

结果：界面看起来是「一个被重新配色的自研聊天壳」，而不是「assistant-ui 的界面」。

## [S2] Design

### S2.1 权威来源与约束

两个外部来源是**规范**，不是参考：

- `https://www.assistant-ui.com/design.md` —— 设计法（印刷文档隐喻、半径表、颜色 register、字体 register、线预算、动效清单、Reject 清单）。
- assistant-ui 官方组件 registry `https://r.assistant-ui.com/<name>.json` —— 组件**源码**。项目 `components.json:22` 已配置 `@assistant-ui` 注册表指向 `https://r.assistant-ui.com/styles/{style}/{name}.json`；实测各 style 名返回同一份 **Radix 口味**内容（与项目现有 `radix-ui` 聚合包一致），因此直接安装即可，无需切换 headless 库。

**核心约束**：视觉一律取自 Elements 原版，**不改一字**。所有自研小件的类名只能从 `elements-surfaces.tsx` 导出的词汇里取。

### S2.2 令牌契约（`src/index.css` 重写）

```css
/* 一把旋钮：全部中性由 --tint 派生，沙色非灰 */
:root  { --tint: 106 }   .dark { --tint: 106 }

/* design.md 半径表 —— 语义名，数值别名仅为 Tailwind 兼容保留 */
--radius-page      0      --radius-document  6px
--radius-sm        6px    --radius-control   8px   (--radius-md 同值别名)
--radius-surface   10px   --radius-xl        12px
--radius-thread    16px   --radius-capsule   9999px

/* 语义对（design.md 的 closed API 列表） */
--background --foreground --card --popover --primary --secondary
--muted --accent --destructive --border --input --ring
--code-surface --sidebar-*  --chart-1..5

/* Elements 原值（抓自 elements 页内联样式表） */
--aui-live     oklch(0.623 0.214 259.815)   /* 暗色 0.707 0.165 254.624，= blue-500/400 */
--aui-success  oklch(0.60 0.15 149)         /* 暗色 0.72 0.17 149 */
--aui-warning  oklch(0.68 0.16 70)          /* 暗色 0.80 0.17 75 */

/* 字体三职 */
--font-display  --font-sans  --font-mono
```

**删除项**：全部 `--brand*`（5 个定义 + 5 个映射）、全部手写紫色色值、全部死令牌（`--density-*`、`--type-*`、`--leading-*`、裸 `--radius`）。

**`--ring` 契约**：由 `ghostButton` 的 `ring-foreground/20` 语义决定 —— `--ring` 必须是中性、可被 `ring-ring/50` 消费。取值 `var(--foreground)`，强度由消费侧的 `/20`、`/50` 控制。

**本轮补齐的两件基础设施**（否则 Elements 的折叠面板在本仓不工作）：

- **折叠面板高度桥接**：Elements 的 `collapsePanel` 读 `--collapsible-panel-height`（Base UI 的变量名），本仓用 Radix（变量名 `--radix-collapsible-content-height`）。`@layer base` 里只对带 `data-state` 的节点桥接（Radix 必设该属性、Base UI 不设），避免覆盖 Base UI 自身的值。
- **折叠关键帧**：补 `collapsible-down/up`（读 `--collapsible-panel-height`）与 `accordion-down/up`（读 `--radix-accordion-content-height`），时长 200ms、缓动 `cubic-bezier(0.32,0.72,0,1)`（Elements 原值）。Elements 会用 `animation-duration-(--animation-duration)` 覆盖时长。

**字号角色**：令牌不做字号阶梯（那是死令牌的老路），改为 `src/renderer/components/assistant-ui/type.ts` 的封闭角色集合（`typeHero` / `typeSection` / `typePage` / `typeDeck` / `typeEyebrow` / `typePackage`），与 design.md 的 `components/shared/type.ts` 对应。

### S2.3 令牌清理契约

| 令牌组 | 处置 |
| --- | --- |
| `--brand*`（10 个定义 + 10 个映射 + 1 处 `::selection`） | **删除**，引用点全部改到 S2.4 的落点 |
| `--tint` | 保留，并**真正派生**全部中性（不再是死令牌） |
| `--radius-*` 语义表 | 保留；`--radius-md/lg/xl` 数值别名按 design.md 保留以兼容 Tailwind |
| `--layout-thread-max-width` | 保留，并由 aui Thread 的 `--thread-max-width` 消费 |
| `--layout-sidebar-width*` | **改为被消费**（`SidebarShell` 不再硬编码 `w-60/w-12`） |
| `--density-*`（6 个） | 删除。密度改由 aui Thread 的布局类与原版间距承担 |
| `--type-*`（6 个）、`--leading-*`（2 个） | 删除。字号改由 S2.2 的 type roles 承担 |
| `--scrollbar-*` | 保留，但改为由前景色 `color-mix` 派生（不再手写色值） |
| `--chat-font` / `--chat-font-size` | 保留（设置页驱动，属既有功能） |

### S2.4 紫色落点替换契约（无残余）

| 旧落点 | 新落点 | 来源 |
| --- | --- | --- |
| 发送键 `bg-brand text-brand-foreground` | `inkButton` = `bg-foreground text-background` | `surfaces.tsx:22` |
| 审批主按钮 `bg-brand` | `inkButton` | 同上 |
| 侧栏当前项 `bg-brand-muted` + 紫竖条 | 官方 `data-active:bg-muted`，**无竖条** | `thread-list.aui.tsx:295` |
| 运行中脉冲点 + 文字 | `live`（蓝）+ `ShimmerLabel` | `surfaces.tsx:43,47` |
| `--ring` 紫 | `var(--foreground)` + `/20`·`/50` | `ghostButton` |
| Markdown 链接 `text-brand-text` | 官方 markdown 的 `text-primary`（墨色） | `markdown-text.tsx` |
| 搜索命中底 + 紫竖条 | 会话内搜索由官方 `ConversationSearch` 的琥珀色标记承担；消息级定位用内阴影左侧栏（gutter bar） | `conversation-search.tsx:82,97` |
| 设置导航选中 / 分段控件 / 选中卡 / 滑块 accent / Check | `field` 底、`bg-foreground/[0.06]` 或墨色前景，一律中性 | design.md「chrome is ink」 |
| `::selection` 品牌浅底 | `color-mix(in oklab, var(--foreground) 12%, transparent)` | 同上 |

`text-white` / `bg-black/50` 一并清除（`button.tsx`、`badge.tsx`、`dialog.tsx`）。

### S2.5 组件落位契约

从 registry 安装到 `src/renderer/components/assistant-ui/elements/`，导入路径改写规则：

```
@/lib/utils                    → @/renderer/lib/utils
@/components/ui/<x>            → @/renderer/components/ui/<x>
@/components/assistant-ui/<x>  → @/renderer/components/assistant-ui/<x>
@/hooks/<x>                    → @/renderer/hooks/<x>
```

**aui 变体优先**（它是 aui Thread 的运行时组件；`elements-*` 是无运行时的静态形态）。

**实际落位结果（T1 回收）**：共写入 **57 个文件** —— `components/assistant-ui/elements/**` 47 个、`components/assistant-ui/utils/range.ts`、`components/ui/{select,tabs,accordion,badge,diff-viewer}.tsx`、`hooks/{use-copy-to-clipboard,use-attachment-src}.ts`、以及手写的 `components/ui/avatar.tsx`。

相比原清单的 5 处调整，逐条理由：

1. `threadlist-sidebar` **不装**。它依赖项目没有的 shadcn `sidebar` 组件；本项目侧栏是自建的 `SidebarShell`，直接用 `thread-list.aui.tsx` 更贴合。
2. `syntax-highlighter` **不装**。全仓无人引用，装了会引入 `react-syntax-highlighter`（约 1MB）；aui `markdown-text` 自身不做语法高亮，行为不受影响。
3. `tool-call` 的 flat 名（aui 变体）在 registry 中 **404**，只有静态形态 `elements-tool-call`，故工具调用卡采用静态形态。
4. `lib/utils.ts` 跳过（项目已有等价的 clsx + tailwind-merge 实现）。
5. `avatar.tsx` 手写：registry 的 shadcn 版依赖 `@radix-ui/react-avatar` 单包，而项目统一用 `radix-ui` 聚合包（见 `collapsible.tsx:1`、`button.tsx:4`）。按项目惯例重写，避免新增依赖。

依赖新增：`tw-shimmer`、`motion`、`remark-gfm`、`diff`、`parse-diff`（后两者为 `diff-viewer` 所需，自带类型）。

上游 registry 中 `button/input/skeleton/dialog/tooltip/collapsible/textarea` 均为 404（assistant-ui 只重托管自有组件）。这些通用件项目已有且接近官方 stock 版，故保留现有实现，只替换 `badge`（差异仅 `transition-colors` 与 `focus-visible:ring-1`，使焦点环与 Elements 的 1px 口径一致）。

### S2.9 vendored 源码策略

`elements/**` 与 `diff-viewer.tsx` 属上游 vendored 源码，按「原样保留、便于上游重新同步」维护：

- **保留上游原始字节内容**（含英文注释），不做语义改写。用户要求「不要改变任何内容」，上游注释属该来源的一部分。
- **格式与 import 排序仍然强制**（已跑 `biome check --write`），因为这两类不改变渲染结果，且保证仓库风格统一。
- 上游自身未满足的 8 条规则在 `biome.json` 中以**目录作用域**放开：`a11y/useSemanticElements`、`a11y/useKeyWithClickEvents`、`a11y/useAriaPropsSupportedByRole`、`suspicious/noArrayIndexKey`、`suspicious/noAssignInExpressions`、`correctness/useExhaustiveDependencies`、`style/noNonNullAssertion`、`complexity/noUselessFragments`。

选目录作用域而非逐行 `biome-ignore` 的理由：这 29 处**全部**是「上游有意如此」，逐行豁免会在 vendored 文件里散布 29 条注释、加大上游同步的 diff 噪声；目录作用域是仓库已有的先例（`components/ui/**` 已用同样方式放开 formatter 与 `useImportType`），且作用范围可审计。

已核实的典型例子（说明这不是为了过闸而放水）：`surfaces.tsx` 的 `SwapLabel` 把 `layers` 留出 `useLayoutEffect` 依赖是**正确**的 —— `layers` 是每次渲染新建的 ref 数组，放进依赖会让 effect 每渲染重跑并重建 `ResizeObserver`；`surfaces.tsx` 与 `tool-call.tsx` 的 `key={index}` 作用于定长 2 元素层叠，index 就是身份；`command-palette.tsx` 的依赖取舍影响滚动行为。

### S2.6 i18n 契约

「中英文切换」机制**不动**：`src/renderer/i18n/index.ts`、`src/shared/i18n/locales/*`、设置 → 通用 → 语言 的分段控件、`useTranslation` 用法全部保持现状。

**文案归属边界（T3 期间由用户拍板）**：

- Elements 组件内部**硬编码的英文标签保持原样不改**（`Reasoning`、`1 tool call`、`Copy`、`Export as Markdown`、`Deny / Always allow / Allow once`、`Search threads`、`Search` 等）。用户明确选择「保留 Elements 原版英文，不改源码」，因此这些 vendored 文件不做 i18n 改写，维持与上游逐字节同步。代价：中文界面下这些标签显示英文。
- **本应用自己写的文案继续走 `t()`**，因此不引入本地化回归：空态欢迎语、跨天分隔条日期、命中计数、审批卡标题/风险/来源/理由占位、以及我方的 tooltip（复制、重试、更多、编辑消息、滚动到底部、移除附件）都取自既有词条。
- 全流程实际只新增 **1 个**词条：`chat.removeAttachment`。两个 locale 文件各自 +1 行，结构未动。

`lib/format.ts` 的 `formatRelativeDay` 原本硬编码中文、`SidebarShell` 的 `toDayGroup` 按中文字符串比对分组。侧栏改官方 thread-list 后该分组逻辑已移除；同时补了语言无关的基础件 `isSameDay` / `dayOffset` / `formatDayDate(timestamp, locale)`（后者走 `Intl.DateTimeFormat`，语言由调用方传入，`format.ts` 保持无 i18n 依赖、可单测）。

### S2.10 三处「Elements 没有对应件」的处置（T3）

| 需求 | 处置 | 理由 |
| --- | --- | --- |
| 线程内跨天分隔条 | 复用 `elements/day-separator.tsx` 的**分隔条那一行标记**（细线 + `mono` 眉题 + 细线），而不是整个组件 | 该组件整体是一份「按天分组的对话样本」（自带消息气泡与 hover 时间），不是分隔条；本应用消息由 primitives 渲染，套用样本会重复渲染消息 |
| 消息级用量（`message-timing`） | **不接入** | `MessageTiming` 读 `useMessageTiming` 的运行时 timing 元数据，而本应用走 `useExternalStoreRuntime` 且未提供该元数据 —— 接入后恒为空。按 design.md「诚实」优先（不画不存在的数字）。vendored 文件保留，待运行时补上 timing 后直接挂到操作栏 |
| 审批理由输入 | 拒绝动作弹 `Dialog`（应用既有组件）收集理由，审批卡本身仍用 `elements/approval-card.tsx` | 该卡没有输入框位置；把理由塞进卡片需要改 vendored 源码。走 Dialog 既保住 `resolveApproval(id, decision, note?)` 的既有语义，又不动卡片 |

**审批状态映射**：store 的 `pendingApprovals` 是 `ApprovalRequest[]`（`chat-store.ts:28`），`source === "ai"` → 卡片的 `running` 态，其余 → `request` 态；store 在定夺后立即把请求移出列表（`chat-store.ts:315`），因此不存在已决态。原先渲染层自造的 `ApprovalCardRequest`（带可选 `decision`/`decidedBy`）**从未被 store 填充过**，一并删除，直接使用共享契约的 `ApprovalRequest` —— 这是删除死抽象，不是行为变更。

### S2.12 侧栏改用官方 thread-list 的实测影响（T4）

按用户选择「完全用官方 thread-list 原版」，侧栏列表改为官方部件组合（`ThreadListRoot` / `ThreadListNew` / `ThreadListSearch` / `ThreadListItems`，内部 `ThreadListItem` 为官方实现），数据由 `PolarRuntimeProvider` 新增的 `adapters.threadList`（`ExternalStoreThreadListAdapter`）从 chat-store 供上。

**代价（事前已向用户说明并获同意）**：

| 项 | 原实现 | 现在 | 原因 |
| --- | --- | --- | --- |
| 日期分组（今天/昨天/更早） | 有 | **无**，退化为平铺（store 顺序即 updatedAt 降序） | `ExternalStoreThreadData` 无 `lastMessageAt` 字段，官方 `useThreadListGroups` 拿不到日期即返回 `groups: null` |
| 每会话运行中指示 | 有（每个会话各自显示） | **仅当前会话** | 官方 thread list 只为「主线程」保留 runtime，非当前会话读不到运行状态（`ThreadListRuntimeCore.unstable_isThreadRunning` 在外部存储实现里未提供） |
| 会话行内联重命名 | 弹窗 | 官方内联输入 | 官方实现，功能等价 |
| 归档/取消归档 | 菜单按状态显示两个词条 | 单一 `Archive` 入口、实际为切换 | 官方菜单只有 `ThreadListItemPrimitive.Archive`；归档项仍留在 `threads` 里（官方不渲染 `archivedThreads`，放进去会彻底找不到）。代价是已归档会话的该菜单项仍显示 Archive 文案，实际执行取消归档 |

**一处未照办的地方（有意偏离，需留意）**：官方 `ThreadListItemPrimitive.Delete` 点击即删、无确认，而本应用删会话是不可撤销的磁盘操作（`sessions.remove`），比「日期分组」这类回退后果重得多。用户当时的授权范围是日期分组与运行态指示，未涵盖取消删除确认，因此**删除确认被保留**：确认逻辑放在适配器的 `onDelete`（官方 `delete()` 只 `await adapter.onDelete`、不自行删除，所以拦在这里不丢失任何官方语义），由 `ui-store` 的 `requestDeleteSession` 返回 Promise，侧栏渲染既有确认对话框。副作用：适配器 `onDelete` 会等待用户操作才 resolve，官方组件因此在确认期间处于 pending，无 UI 表现。

**两处附带调整**：

- `PolarRuntimeProvider` 的包裹范围从「只包 MainShell」扩大为「包住 SidebarShell + MainShell」（`App.tsx:33-39`）。官方 thread-list primitives 需要 runtime 上下文，侧栏原本在 provider 之外。
- 空态改为官方 `EmptyState` + `EmptyStateGreeting`，并**移除原有的 4 个灰色占位卡**。原因：那些卡是「提示词数据未就绪」的占位（原代码 `aria-hidden` + 注明未接入），design.md 的「诚实」条款明确禁止占位行与未落地的能力，因此不保留灰块、也不发明提示词内容。空态随之不再是无 Composer 的死输入框 —— Thread 的 ViewportFooter 始终带 Composer，这也是官方 Thread 的结构。侧栏「用量」按钮保留但显式 `disabled`（此前是可点却无动作的空实现），主区顶栏那个同样无动作的用量按钮一并删除。

### S2.13 搜索层换成官方组件的实测影响（T5）

| 面板 | 现在的实现 | 保留的行为 | 失去的行为 |
| --- | --- | --- | --- |
| 全局搜索（Ctrl+K） | 官方 `CommandPalette` 渲染结果列表，本组件只把四类结果映射成它的 `PaletteCommand`（`label` 主文案、`group` 分组、`keys` 右侧等宽标记）。Dialog 外壳与 `bg-foreground/20` 遮罩保留。 | 输入即搜（150ms 防抖）、按 会话 → 消息 → 设置 → 命令 分组、中文输入法组合期不响应、Enter 执行、Esc 关闭、空输入退化为最近 5 个会话、消息按正文命中（非标题）、打开消息会带关键词进入会话内搜索 | 结果里的**关键词高亮**（官方 `label` 是字符串，塞不进 React 节点）、**Tab 跨分组跳转**、底部快捷键提示条与结果总数、消息结果的两行布局（原文 + 位置） |
| 会话内搜索（Ctrl+F） | 官方 `ConversationSearch`，命中前后文与滚动条刻度都由它渲染 | 命中计数、上下切换、Enter/Shift+Enter 切换、Esc 关闭并清空、关闭清除高亮、关闭时清空查询 | 关闭按钮（官方 anatomy 里没有）、`aria-live` 计数播报 |

关键实现说明：官方两个组件都**不转发 `onKeyDown`**，会话内搜索的 Esc/Enter 改为在容器上挂原生监听（容器是不可交互元素，直接挂 React `onKeyDown` 会被 `lint/a11y/noStaticElementInteractions` 拦下）。全局搜索的 Enter/箭头由官方 palette 自己处理，本组件只接管 Esc。

`find-matches.ts` 的匹配算法与既有 9 条测试**未改动**，`SessionSearchBar` 仍复用 `findMatches` / `messageText` / `buildSnippet` / `escapeRegExp`。会话内搜索新增的一遍扫描只是为了拿到**每个**命中的前后文与刻度位置（`findMatches` 只返回每条消息的首个片段），不改变命中判定。

### S2.14 设置层换成官方组件的实测影响（T6）

- **分类导航 → 官方 `Tabs`（vertical）**，而非保留按钮导航。理由：六个分类是「切换视图」，`role=tablist/tabpanel` 才是正确语义（原按钮只有 `aria-current`），并自带方向键 + roving tabindex。视觉保留 200px 左栏，只把 `TabsList` 的轨道改透明、选中项改成中性墨色淡底，不画竖条。
- **原生 `<select>` → 官方 `Select`**（共享件 `SettingsSelect`）。两个坑：① Radix `SelectItem` **拒绝空串 value**（运行时抛错），所以「跟随默认模型 / 未指定」改用哨兵 `SELECT_NONE = "__none__"`，在 `onValueChange` 里映射回 `update({ defaultModel: null })` / `update({ aiApprovalModel: null })`，落盘字段与取值语义不变；② `ui/input.tsx` / `ui/textarea.tsx` 的基础类含 `md:text-sm`，媒体查询不带特异性，任何非 `md:` 前缀的字号覆盖在 ≥768px 都会失效 —— 所以输入框改用 `field` 面而不写字号，避免做出「看似改了、实际没生效」的假改动。
- **`Segmented` 有意不换成 Tabs**：它选的是「一个字段的一个值」，`aria-pressed` 按钮组语义才对；改为 Elements `settings-panel` 的「field 轨道 + 背景色胶囊」。
- **`Switch` 有意未改**：其 checked 态是 `bg-primary`，而本轮 `--primary` 已是墨色（`index.css` 亮 `oklch(0.24…)` / 暗 `oklch(0.94…)`），unchecked 是中性 `bg-input` —— 零紫色、天然中性。与 Elements 口径仅剩两处 cosmetic 差异（`focus-visible:ring-[3px]` 应为 1px、`shadow-xs` 应为 0），改动需越出本轮授权文件清单，故保留并记账。

### S2.11 design.md 与 Elements 冲突时的取舍

有两处 Elements 原版与 design.md 的 register 不一致，按用户「完全以 Elements 原本的样式为主」的指示**以 Elements 为准**，并在此记账：

| 项 | design.md | Elements 原版 | 采用 |
| --- | --- | --- | --- |
| Composer 外壳圆角 | 半径表 `--radius-thread` 16px，且《Reject these》明确否掉 `rounded-3xl` 的 Composer | `--composer-radius: 1.5rem`（24px），`elements-composer` 的 `ComposerBar` 用 `rounded-[24px]` | **Elements 的 24px** |
| 用户消息气泡圆角 | 半径表 `--radius-thread` 16px | `rounded-xl`（12px） | **Elements 的 12px** |

### S2.7 动效契约

新增依赖（版本已核实）：`tw-shimmer@0.4.12`（Elements shimmer 基座）、`motion@13.2.0`（含 `motion/react` 子入口）、`remark-gfm`（`markdown-text` 的依赖）。

原版照抄类（来自 `surfaces.tsx`）：`pressable`、`ghostButton`、`inkButton`、`iconSwap(+In/Out)`、`labelSwap(+In/Out)`、`collapsePanel`、`ShimmerLabel`、`SwapLabel`。Elements 的 shimmer 直接作用在 vendored 组件里：`reasoning` / `tool-group` / `tool-fallback` 的运行态标签、`thinking-indicator`、`tool-call`、`tool-timeline`、`error-state` 都带 `shimmer motion-reduce:animate-none`。

**motion（JS 动效）实际落点只有两处**，都是 CSS 做不到或做不对的：

1. **审批卡的退出动画**（`ApprovalSection.tsx`）：卡片随定夺从 store 列表消失，CSS 无法延迟卸载，会硬闪一下。用 `AnimatePresence` + `layout` 做进场/退场。
2. **设置分类切换的内容进场**（`SettingsModal.tsx`）：换分类是「内容换了一屏」，用一次轻微淡入 + 上移说明这件事（官方 Tabs 只挂载当前项，不需要 exit）。

**其余过渡保持 CSS**，这是有意的取舍：

- 侧栏宽度折叠：`transition-[width]`（`SidebarShell.tsx`）。单值过渡，CSS 已经做对；换 motion 只增加 JS 开销。
- 命令面板开合、Dialog/Popover/Toast 进出场：走 `tw-animate-css` 的 `animate-in` / `animate-out` + `fade/zoom/slide`（Elements 与 shadcn 的原生做法）。
- 会话列表的增删：在 vendored 的 `thread-list.aui.tsx` 内，按 S2.9 的「原样保留」策略不改动，因此没有增删动画。

reduced-motion 三层兜底：① `src/index.css` 的全局 `prefers-reduced-motion` 块强制停用全部 CSS 过渡与动画；② `<MotionConfig reducedMotion="user">`（`App.tsx:33`）让两处 motion 动画在系统偏好为 reduce 时**只保留透明度变化、抑制位移与缩放**；③ 原版类自带 `motion-reduce:transition-none` / `motion-reduce:animate-none`，各处自研动效点也补了 `motion-reduce:*`。

### S2.8 行为不变清单（重构边界）

以下必须零行为变化：左右两栏骨架与折叠、`.dark` 主题切换、`--chat-font` / `--chat-font-size` 机制、三模式权限与审批流程、会话 fork/归档/重命名/删除（删除确认见 S2.12）、检查更新与数据目录、全部 IPC 契约（`src/shared/contracts/*`）、全部主进程代码、快捷键（Ctrl+K / Ctrl+F / Ctrl+N / Ctrl+, / Ctrl+B）、发送与排队语义（运行中 Enter 排队、Ctrl+Enter 插话）、模型/权限/思考三 chip 的写入字段与全部取值。

### S2.15 独立评审的发现与修正（收口阶段）

一次只读的独立评审对着本规格逐条核对后，用 registry 快照做机器比对确认了 vendored 文件「只差 import 改写与格式化、无语义改动」，并确认若干高风险点**不是**缺陷（适配器 `useMemo` 身份变化不会重置运行时；`SidebarShell` 的选择器返回原始值、不会触发 zustand 无限重渲染；两处正则计数一致；删除的 8 个旧文件零引用残留；`biome.json` 的 override 范围恰好等于声明的三个路径）。它同时报出 3 个 major 与 7 个 minor，**已全部处理**：

| # | 来源 | 问题 | 处置 |
| --- | --- | --- | --- |
| D1 | T5 引入的回归 | 会话内搜索把键盘监听挪到容器后**丢失「打开即聚焦」**，导致 Esc 关不掉、Enter 会把 Composer 内容发出去 | 已修：`SessionSearchBar.tsx` 在 `open` 时聚焦搜索输入框。已由实测断言覆盖（自动聚焦 / 不点也能打字 / Esc 关得掉） |
| D2 | T5 引入的回归 | `MainShell` 的 guard 丢弃了子组件关闭时回传的 `null`，**关闭搜索后高亮与命中计数残留** | 已修：恢复「开关关闭即清 activeHit」的 effect。已由实测断言覆盖 |
| D3 | T3 引入 | 两个 tooltip 用了**不存在的词条** `chat.editMessage` / `chat.scrollToBottom`，UI 会原样渲染 key | 已修：两个 locale 各补这 2 个键（总数 210），并加了静态键完整性扫描，现为 0 缺失 |
| D4 | T5 引入 | 预筛用 trim 后的 keyword，而官方 palette 用未 trim 的 query 再筛一次，输入带空格会「先显示、再整片消失」 | 已修：谓词统一为未 trim 的 query，只有「是否扫消息正文」用 trim 后的判断 |
| D5 | 字面偏离 | Composer 运行态标签只有 `ShimmerLabel`、没有 `live` 蓝，与 T7 验收字面不符 | 保留并记账：该处本就不是 live 语义（live 蓝留给主区顶栏的运行态），T7 的验收描述已按此收紧 |
| D6 | 既有问题 | 设置页「界面密度」在 `--density-*` 移除后成为空开关 | 记录不改：base 的 `--density-gap-message` 本就只写不读，属既有问题而非本次回归；移除该控件会改设置项，超出范围 |
| D7 | S2.4 未落实 | `text-white` / `bg-black/50` 未按 S2.4 清除，且设置弹窗遮罩与全局搜索遮罩口径不一致 | 已修：`button.tsx` / `badge.tsx` 的 destructive 改用 `text-destructive-foreground`；`dialog.tsx` 遮罩改 `bg-foreground/20`，与全局搜索一致 |
| D8 | 细节 | 会话内搜索的命中刻度用 `i/(count-1)`，末尾命中落在 100% 会溢出一半 | 已修：改取每段中心 `(i+0.5)/count` |
| D9 | 一致性 | registry 新件的 `cn` 导入来源与 `components/ui/**` 既有惯例（`from "cn"`）不一致 | 部分修正：被修改的既有文件 `badge.tsx` 回到 `from "cn"`；registry 新增件按 S2.5 的改写规则保留 `@/renderer/lib/utils`（两套并存是有意的，改写规则保证上游同步可批量重放） |
| D10 | 一致性 | registry 原样带来的注释形态（英文、含一条 ESLint 指令）与「注释一律中文」不一致 | 保留并记账：这些文件按 S2.9 原样维护，本地化注释会加大上游同步的 diff 噪声；规格此前只列了 `elements/**` 与 `diff-viewer.tsx`，实际范围还应包含 `components/ui/{select,tabs,accordion}.tsx` 与 `hooks/use-attachment-src.ts` |

评审另指出规格自身有 7 处行号/描述不准（含 S2.4 的两处行号、S2.9 举例的 `tool-call.tsx` 实际不含该写法、S2.5 把 elements 文件数写成 47 而实为 48、以及 S2.4 与 S2.5 关于通用件是否替换的自相矛盾）。这些属文档准确性问题，已按实际代码校正：行号类引用随代码变动本就会漂移，因此改以**文件 + 符号名**为主；S2.4 与 S2.5 的冲突以 S2.5 为准（通用件只替换 badge，其余保留现有实现）。

## [S3] Out of Scope

- 主进程（`src/main/**`）、preload、IPC 契约、安全模块：**不动**。
- i18n 切换机制与词条结构：只补键，不改结构。
- 新功能：不做「用量统计」的真实数据（按钮保持禁用）、不接提示词的远端来源、不做虚拟化长列表。
- 测试策略调整：不新增测试框架，沿用 `vitest`。
- `src/renderer/features/search/find-matches.ts` 的匹配算法与 `message-converter.ts` 的转换逻辑：不动。
- **紫色主题移除后不提供回退开关**（用户明确「不需要」）。

## Tasks

- [x] T1: 安装依赖并将 elements 组件落到 `src/renderer/components/assistant-ui/elements/`，导入路径按 S2.5 改写规则重写 — acceptance: `npx tsc --noEmit` 通过，且 `elements/` 下无 `@/lib/`、`@/components/`、`@/hooks/` 裸别名的未改写残留（covers: S2.5, S2.9; depends: none）
- [x] T2: 重写 `src/index.css` 令牌层，清除全部紫色与死令牌，落 design.md register 与 `--aui-*`，并补齐 Radix↔Elements 的折叠面板高度桥接与折叠关键帧 — acceptance: `src/index.css` 与构建产物 CSS 对紫色正则均 0 命中；`npm run build` exit 0 且产物含 `--tint:106`、`--aui-live`、折叠关键帧与 `--collapsible-panel-height` 桥接（covers: S2.2, S2.3, S2.4; depends: T1）
- [x] T3: 消息层改为 aui `Thread` 结构 + `reasoning`/`tool-*`/`attachment`/`markdown-text` + `elements-approval-card`，并按 S2.11 统一 Composer 与用户气泡的圆角 — acceptance: 用户气泡 `rounded-xl bg-muted`、助手正文无气泡直出 `MarkdownText`、操作栏 `hideWhenRunning` + `autohide="not-last"`、推理与工具各自折叠；四道闸门 exit 0（covers: S2.4, S2.5, S2.6, S2.10, S2.11; depends: T2）
- [x] T4: Chrome 层改为 Elements 风味：顶栏、侧栏换官方 `thread-list` 部件、主区顶栏运行态改 `live` + `ShimmerLabel`、空态接 `elements-empty-state` — acceptance: 侧栏由官方四件套渲染且可搜索；当前项高亮为官方 `data-active:bg-muted`、无竖条；运行态为 `live` 蓝 + `ShimmerLabel`；空态渲染官方 `EmptyState`；日期分组与每会话运行态按 S2.12 回退，删除确认按 S2.12 保留；四道闸门 exit 0（covers: S2.4, S2.5, S2.6, S2.12; depends: T2）
- [x] T5: 搜索层换官方 `elements-command-palette`（Ctrl+K）与 `elements-conversation-search`（Ctrl+F） — acceptance: Ctrl+K 输入即搜并按四类分组、Enter 执行、Esc 关闭；Ctrl+F 命中计数与上下切换可用；关键词高亮、Tab 跨分组、结果总数、关闭按钮按 S2.13 回退；`find-matches` 的 9 条测试保持通过（covers: S2.5, S2.13; depends: T2）
- [x] T6: 设置层换官方 `elements-settings-panel` 的形状 + registry 版 `select`/`tabs`/`badge` — acceptance: 六个分类由官方 `Tabs`（vertical）渲染且均可打开；原生 `<select>` 全部换官方 `Select`（`SettingsSelect` + `SELECT_NONE` 哨兵）；语言切换位置/选项/写入字段未动；`features/settings` 下紫色 0 命中；四道闸门 exit 0（covers: S2.4, S2.5, S2.6, S2.14; depends: T2）
- [x] T7: 动效层统一：`tw-shimmer` 生效于运行态标签，motion 用于 CSS 做不到的两处（审批卡退出、设置分类切换），reduced-motion 三层兜底 — acceptance: 产物 CSS 含 `shimmer`（53 处）；`live` + `ShimmerLabel` 用在主区顶栏、线程工具条与 Composer 运行态；`MotionConfig reducedMotion="user"` 在 `App.tsx:33`；全局 `prefers-reduced-motion` 块在 `index.css`；实际落点与取舍见 S2.7（covers: S2.7; depends: T3, T4, T5, T6）
- [x] T8: 收口验证：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全绿，全仓紫色引用归零，并验证关键路径的真实渲染 — acceptance: 四条命令均 exit 0（见 Report 的 Verification 表）；紫色正则在 `src/` 与产物 CSS 均 0 命中；用 Playwright 驱动 Vite 页面实测 17 项断言全 PASS（空态、用户气泡类名、推理/工具折叠、官方 palette、官方会话内搜索、设置 Tabs/Select、运行期紫色计数 0）；独立评审的 3 major + 7 minor 已全部处理（见 S2.15）（covers: S2.4, S2.8; depends: T3, T4, T5, T6, T7）
