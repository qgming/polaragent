---
feature: unified-search
status: delivered
updated: 2026-09-11
branch: main
commits: 379aecf..working-tree
---

# 搜索入口合并与统一搜索模态窗

## Report

**What was built** — 三处搜索入口（侧栏标题筛选、内容区顶栏按钮指向的会话内搜索条、只能靠 Ctrl+K 唤出的全局面板）合并为**一个入口 + 一个模态窗**。侧栏顶行现在是「展开/收起 ⌕」，折叠态的 48px 图标轨道是 « ⌕ ＋，侧栏内不再有筛选输入框、列表始终展示全部会话。搜索模态窗（`features/search/SearchModal.tsx`，由原 `GlobalSearch.tsx` 演化）承载会话 / 消息 / 设置 / 命令四组结果，由侧栏按钮与 Ctrl+K 共同打开；点会话行切会话并关闭，点消息行切会话并**滚动定位到那条消息**、该条左侧留 2px 竖条标记。会话内搜索（搜索条、命中计数、滚动条刻度、Ctrl+F）整体移除，`conversation-search.tsx` 元素按上游镜像保留但不再被引用。设计稿 `docs/design/ui-v2-ascii.md` 的 B6/B7/B8、A/C/D/F 已同步。

**Verification** — `npm run typecheck`（renderer + electron）PASS；`npm run lint`（biome check .，184 文件）PASS；`npm test` PASS（21 文件 / 209 用例，其中 16 条为本次新增的跳转单测）；`npm run build`（三进程）PASS。交互由用户在真实 Electron 中人工实测通过（用户明确要求删除我的临时 CDP 探针，故不留脚本）。独立审查确认原 critical 已封死，并复跑过两个新测试文件。

**Journey log**

- **消息 id 不是全局唯一**：fork 出来的会话与源会话共用 messageId（`src/main/pisdk/session-store.test.ts` 已证实），且 `useExternalStoreRuntime` 的消息比 store 晚一帧落地。两者叠加，使「按 messageId 去 DOM 上定位」的跳转会在旧会话的同 id 节点上提前消费掉 —— 而竖条标记又按 id 正确落在目标上，把失败掩盖过去。凡以 messageId 作全局键（DOM 选择器、去重键、消费标记）的地方都必须带会话作用域。
- 修这个 bug 时先用了「逐条同 id」的严格判据，结果引入新问题：运行时在 `isRunning && 末条非 assistant` 时会追加一条随机 id 的乐观助手消息（@assistant-ui/core 的 `external-store-thread-runtime-core`），使严格相等恒 false —— 流式期间点搜索反而**不滚**。最终判据是「预期恰好多一条」而非「允许多一条」。
- 纯函数 + 单测在这里价值明确：把门控抽成 `isMessageSequenceSynced` 后，用 mutate 验证（把长度约束放宽成区间比较）能挂掉 3 条用例，其中一条正是「不放行时多出一条」。
- token 必须单调不回落：早期写法从 store state 派生，清空 `searchJump` 后归零，回到同一会话再点同一条消息会撞上已消费的记录而不再滚动（已由 `ui-store.test.ts` 钉住）。
- 上游 elements 里的 `edit-message` 一类的**内联**控件不适合直接塞进 Dialog（自带 paper 卡与 20px 圆角，会变成卡片套卡片）。同类的 `conversation-search` / `edit-message` 元素文件按镜像保留，但应用侧改用自己的 Dialog 骨架。

## [S1] Problem

同一件事「搜索」在界面上有三个互不相干的入口，能力边界还互相错位：

1. **侧栏筛选输入框**（`SidebarShell` → `ThreadListSearch`）：只按会话标题过滤左侧列表，输入框占掉侧栏一整行，收起侧栏后能力直接消失。
2. **内容区顶栏搜索按钮**（`MainShell`）：打开的是**会话内消息搜索条**（`SessionSearchBar`，Ctrl+F），与「找会话」完全不是一回事，命名与位置都让人误判。
3. **Ctrl+K 全局搜索面板**（`GlobalSearch`）：会话 / 消息 / 设置 / 命令 四组，能力最全但没有可见入口，只能靠记快捷键。

用户想要的形态：一个入口、一个独立模态窗 —— 输入即出会话结果，点结果跳到对应会话记录。

## [S2] Design

### S2.1 侧栏统一搜索入口

展开态顶行与折叠态图标轨道各放一个搜索按钮，位置固定在「展开/收起」按钮右侧，两态顺序一致。

```
展开态                                折叠态图标轨道
┌──────────────────────┐              ┌────┐
│ «  ⌕                │              │ «  │  展开/收起
├──────────────────────┤              │ ⌕  │  搜索（新入口）
│ ＋ 新对话             │              │ ＋ │  新对话
│ 今天                 │              │    │
│ ▎登录页抖动修复       │              │ ⚙  │  设置（底部）
│  ⑂ └ 改用 dvh 方案   │              └────┘
│ 昨天                 │
│ 重构线程列表          │
└──────────────────────┘
```

- 两个按钮复用侧栏既有的 `RailButton`（icon-sm ghost + tooltip），标签用既有 key `common.search`。
- `SidebarShell` 移除 `ThreadListSearch` 的使用与本地 `search` state；`ThreadListItems` 不再传 `searchQuery`，列表始终展示全部会话，日期分组不变。
- 元素层 `ThreadListSearch` 与 `useThreadListGroups(searchQuery)` **保留**：它们对齐上游、且上游组合 `ThreadList` 仍在用，属元素库能力而非本应用的接法。

### S2.2 统一搜索模态窗

新组件 `src/renderer/features/search/SearchModal.tsx`，由 `GlobalSearch.tsx` 演化而来（原文件删除，逻辑保留），挂载点仍是 `App.tsx` 的浮层区（布局之外，不受侧栏裁剪）。

```
      ┌──────────────────────────────────────────────┐
      │ ⌕  搜索会话、消息、设置或命令…          esc  │   ① 打开即聚焦
      ├──────────────────────────────────────────────┤
      │ 会话                                         │   ② 输入即搜（150ms 防抖）
      │  ▸ 登录页抖动修复     今天 14:20 · 18 条消息   │
      │  ▸ 重构线程列表       昨天 09:12 · 42 条消息   │
      │ 消息                                         │
      │  ▸ …把 100vh 改成 100dvh…  在「登录页抖动修复」│
      │ 设置 / 命令                                   │
      │  ▸ 模型服务            打开设置 → 模型服务     │
      │  ▸ 新建对话            Ctrl+N                 │
      ├──────────────────────────────────────────────┤
      │ ↑↓ 选择   ↵ 打开   esc 关闭                   │   ③ 交互沿用 CommandPalette 元素
      └──────────────────────────────────────────────┘
```

- 触发：侧栏搜索按钮与 Ctrl+K 打开同一个模态窗（`openSearch` / `closeSearch`）。
- 结果四组沿用现状：会话（无查询时退化为最近 5 个）、消息（仅本次运行**已加载过**的会话，上限 20 条）、设置（六个分类）、命令（新建对话 / 切换主题）。
- 行点击行为：
  - 会话行 → `setActiveSession(id)` + 关闭模态窗；
  - 消息行 → `setActiveSession(sessionId)` + `jumpToMessage(sessionId, messageId)` + 关闭模态窗（落地见 S2.3）；
  - 设置行 / 命令行 → 现状不变。
- 文案：给 `command-palette.tsx` 元素加两个**可选** prop —— `placeholder`（同时用作输入框 `aria-label`）与 `emptyLabel`，默认值保持上游英文原文；模态窗传 `t("search.globalPlaceholder")` 与 `t("search.noResults")`。不传时元素行为与上游一致，重拉镜像时差异仅两行。
- 模态窗标题与描述沿用 `search.globalTitle` / `search.globalDesc`（sr-only）。
- 键盘与关闭：Esc 关闭、Esc 遮罩、↑↓/Enter 由元素负责，均与现状一致；不新增底部提示行与结果计数（设计稿 B7 的提示行本次不实现）。

### S2.3 消息落地：移除会话内搜索

会话内搜索（搜索条 + 命中计数 + 滚动条刻度 + Ctrl+F）整体移除，只保留「跳到那条消息」这一件事。

- 删除：`features/search/SessionSearchBar.tsx`、`conversation-search` 元素的使用、`useGlobalShortcuts` 的 Ctrl+F 分支、`ui-store` 的 `sessionSearchOpen` / `sessionSearchQuery` / `openSessionSearch` / `closeSessionSearch` / `setSessionSearchQuery`、`MainShell` 里的 `activeHit` state 与 `SessionSearchBar` 渲染。
- `conversation-search.tsx` 元素文件保留（上游镜像），只是不再被引用。
- 跳转通道：`ui-store` 新增

  ```ts
  searchJump: { sessionId: string; messageId: string; token: number } | null;
  jumpToMessage(sessionId: string, messageId: string): void; // token 自增
  ```

  token 自增让「重复点同一条消息」也能重新定位；`sessionId` 用来拒绝跨会话的过期目标。
- `ThreadView` 直接订阅 `searchJump`，不再依赖 `MainShell → ChatView → ThreadView` 的 `searchHit` prop 链（该 prop 与 `MainShell` 的 state/effect/handler 一并删除）：
  - 目标有效条件：`searchJump.sessionId === activeSessionId`；
  - 定位 effect 依赖 `[jump, domSynced, sessionMessages]`：切换会话后消息异步加载，目标 DOM 可能要下一帧才存在，因此效果必须在消息变化时重跑；
  - `consumedRef` 记录已消费的 token，保证同一 token 只滚动一次（流式更新不会反复把视口拽回去），目标未出现时保持未消费；
  - 落地表现：滚动到该条消息并加左侧竖条标记（保留 `data-search-hit` 与内阴影 gutter），**不再**显示「命中 N 处 · i/N」计数器行。
- `i18n`：`search.hitCount` 仍被模态窗消息行使用，保留。

#### 跳转的同步门控（`domSynced`）

独立审查发现的 critical，已修：**消息 id 不是全局唯一**。

- `useExternalStoreRuntime` 在**父级 effect** 里才把新消息数组推进运行时，因此组件读到的 `s.thread.messages` 恒比 store 晚一帧：切会话那一帧 `activeSessionId` 已是新会话，`messages` 还是旧会话的。
- 而 fork 出来的会话与源会话**共用消息 id**（`src/main/pisdk/session-store.test.ts`）。只按 id 去 DOM 上 `querySelector`，会在旧会话的同 id 节点上命中、把跳转提前消费掉；等新会话真的渲染出来时反而不滚了 —— 左侧竖条却按 id 正确落在目标上，把失败掩盖过去。

因此定位前必须确认这批 messages 就是当前会话的那批，判据抽为纯函数 `features/chat/message-seq.ts` 的 `isMessageSequenceSynced(stored, rendered, optimisticTail)`：逐条同 id + 长度相符（不是只比长度或首项，fork 场景下两者都可能恰好相同）。

`optimisticTail` 是必要的例外：运行时在 `isRunning && 末条非 assistant` 时会自行追加一条随机 id 的乐观助手消息（@assistant-ui/core 的 `external-store-thread-runtime-core`），此时渲染侧**必定**比 store 多一条；不放行就会「流式期间点了搜索却不滚」，而那恰是最想跳的时候。它表达的是「预期恰好多一条」，多出两条或前 N 条对不上都不算同步。

另：离开目标会话时清空 `searchJump`（否则回到该会话会留下「只有标记、不再滚动」的残留），token 改为模块级单调递增（若随清空归零，回到同一会话再点同一条消息会撞上已消费的记录）。

### S2.4 store 与快捷键

`ui-store` 的改动：

- `globalSearchOpen` / `openGlobalSearch` / `closeGlobalSearch` → 重命名为 `searchOpen` / `openSearch` / `closeSearch`（它是唯一的搜索模态窗开关）。
- 删除会话内搜索的 5 个字段/方法（见 S2.3）。
- 新增 `searchJump`、`jumpToMessage` 与 `clearSearchJump`；token 由模块级计数器单调递增（不随清空重置，理由见 S2.3）。

`useGlobalShortcuts`：Ctrl+K 切换 `searchOpen`；删除 Ctrl+F 分支；文件头注释（设计稿 F-14）同步为「Ctrl/Cmd+K 搜索」。

### S2.5 i18n

- 转为**启用**（原本已定义但未使用）：`search.globalPlaceholder`、`search.noResults`。
- 删除已成死键：`sidebar.filterSessions`（唯一使用点是被移除的侧栏筛选输入）、`chat.searchPlaceholder`（原搜索条 aria-label）、`chat.searchPrev` / `chat.searchNext`（会话内搜索的上一处/下一处，早已无人引用）。zh-CN 与 en-US 同步修改。
- 保持不动：`search.resultCount` / `hintSelect` / `hintOpen` / `hintCategories` / `hintClose`（本次不实现底部提示行）。

### S2.6 文档同步

`docs/design/ui-v2-ascii.md` 是本项目 UI 的设计契约（代码注释按图号引用），需同步：

- B6 侧边栏：顶行改为「展开/收起 + 搜索」，去掉筛选输入框行与对应说明；折叠轨道补搜索按钮。
- B7 搜索面板：改为由侧栏按钮 + Ctrl+K 打开，删除「每屏两张搜索图」的重复描述口径。
- B8 会话内搜索：整节删除，其快捷键与 Esc 关闭链引用同步清理。
- A 变更总览第 6 条、C 组件映射表（全局搜索 / 会话内搜索两行）、D2 键盘行为表（Ctrl+F 行）、D6 浮层 Esc 关闭链（会话内搜索条一项）、F 待确认点里 Ctrl+F 相关条目。

## [S3] Out of Scope

- 不做跨会话全库全文检索：渲染层只有 `messagesBySession`（本次运行加载过的会话），主进程也没有搜索接口。消息结果的范围边界保持现状。
- 不实现设计稿 B7 的底部提示行与结果计数（`resultCount` / `hint*` 等 key 继续闲置）。
- 不改 `command-palette.tsx` 的过滤 / 分组 / 键盘逻辑，只加两个可选文案 prop。
- 不删除 `conversation-search.tsx`、`thread-list.aui.tsx` 里的 `ThreadListSearch`（属上游镜像与元素库能力）。
- 不调整侧栏日期分组、会话项视觉、设置模态、Composer 与审批流。
- **不保留自动化 UI 探针脚本**：用户明确要求删除临时探针，交互验证改为人工实测；因此 S2.3 的同步门控只做纯函数单测，Thread 层的门控/清空/重试无自动化覆盖（已知缺口）。
- 不改动主进程、IPC、pisdk 与工具层。

## Tasks

- [x] T1: 侧栏统一搜索入口 — acceptance: 展开态顶行依次为「展开/收起」「搜索」，折叠态轨道为 « ⌕ ＋；点任一搜索按钮打开搜索模态窗；侧栏不再有筛选输入框，列表始终展示全部会话（日期分组正常） (covers: S2.1)
- [x] T2: 统一搜索模态窗 — acceptance: Ctrl+K 与侧栏按钮打开同一个模态窗；输入关键词后下方出现匹配会话，点击会话行切到该会话并关闭模态窗；输入框占位与空结果文案为中文 (covers: S2.2, S2.4, S2.5; depends: T1)
- [x] T3: 移除会话内搜索 — acceptance: 仓库中不再有 `SessionSearchBar`、`conversation-search` 的使用、Ctrl+F 绑定与 `sessionSearch*` store 字段；typecheck 与 biome 无未使用残留报错 (covers: S2.3, S2.4)
- [x] T4: 消息结果跳转落地 — acceptance: 点消息行后切到目标会话并滚动到该条消息、该条带左侧竖条标记；不出现命中计数；同一目标重复点击可重新定位，流式更新期间视口不被反复拽回 (covers: S2.3)
- [x] T5: 同步设计稿与死 key 清理 — acceptance: `docs/design/ui-v2-ascii.md` 的 B6/B7/B8、A/C/D/F 相关引用与新界面一致；zh-CN 与 en-US 均无 `filterSessions` / `chat.searchPlaceholder` / `searchPrev` / `searchNext` (covers: S2.5, S2.6)
- [x] T6: 交互验证 — acceptance（修订）: 交互由用户在真实 Electron 中人工实测通过（侧栏按钮开窗 → 输入筛选 → 点会话切换 → Esc 关闭；顶栏搜索按钮与侧栏筛选输入框已不存在）。原 acceptance 要求留一份 CDP 探针脚本，但用户明确要求删除临时脚本，故改为人工实测，脚本不留痕 (covers: S2.1, S2.2; depends: T1, T2)
- [x] T7: 全量校验 — acceptance: `npm run typecheck`、`npm test`、`npm run build` 全绿 (covers: S2; depends: T1–T6)
- [x] T8: 修复跳转的跨会话漏判（审查 critical） — acceptance: 切会话那一帧不再被旧会话 DOM 误消费；运行中的乐观助手消息不放行即漏滚；两档均有单测且经 mutate 验证 — acceptance 达成：`isMessageSequenceSynced` 单测 12 条，mutate（长度约束放宽）失败 3 条 (covers: S2.3; depends: T4)
- [x] T9: 跳转去重与残留清理 — acceptance: token 单调不回落（清空后重新跳同一目标仍换新 token）；离开目标会话时清空 `searchJump`；`ui-store.test.ts` 4 条覆盖 (covers: S2.3, S2.4; depends: T4)
