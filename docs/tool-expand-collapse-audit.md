# 工具「展开 / 收起」一致性审计报告

> 审计对象：主会话消息流里工具调用的呈现（展开面板、触发行、时间线步骤）。
> 触发问题：ask_user 回答之后，会话里的工具行要能展开看到回答内容；读取类工具也要能展开看到读取的内容。
> 方法：逐文件读源码 + 两组探针测试实测渲染结果（探针已删除，证据抄录在 §4 与附录）。
> 结论口径：**只报能在源码里指出确切位置、或能在 jsdom 里实测复现的问题**；推断一律标注。

---

## 0. 摘要

**「配置是否齐全」的答案是分层不同的**：

| 层 | 覆盖情况 |
| --- | --- |
| 图标表 `TOOL_ICONS` | ✅ **27 / 27 齐全**（含未登记工具的兜底图标） |
| 动词表 `TOOL_LABELS` | ✅ **27 / 27 齐全**（失败兜底到 `tools.call`） |
| 触发行 chip | ⚠️ `ask_user` **恒为空**；`browser_snapshot` / `screenshot` / `wait` 在常见参数下为空（§4-D6） |
| 展开详情 | ❌ **只有 6 类工具有专属详情**；其余全部落内置文本面板，而那个面板**不保留换行**（§4-D1） |
| 展开契约本身 | ❌ 时间线里「无详情的步骤」**给了一个点了没反应的展开箭头**（§4-D2） |
| 详情与内置面板的关系 | ❌ 详情**顶掉**内置面板，导致 web_fetch 正文 / web_search 结果文本在界面上**彻底不可见**（§4-D3） |

**真实缺陷 10 条，其中 P0 两条**（D1 影响 14 个内置工具 + 全部 MCP 工具的可读性，D2 影响最常见的 grep→read 组合）。

**关于 ask_user**：回答内容**技术上能展开看到**，但呈现方式与其它工具不一致，而且是「能用」级别的将就 —— 触发行上挂着一个**空胶囊**，展开后是一段机器味的中文长句，`details` 里的结构化答案（`outcome` / `questions` / `answers`）**没有任何消费者**，`ask.unanswered` / `ask.cancelled` 两个词条**是死的**（全仓无人 `t()` 它们）。详见 §5。

---

## 1. 审计范围与方法

### 1.1 范围

`src/renderer/features/chat/ToolParts.tsx` 是唯一的工具呈现装配点（1137 行），它依赖：

- `src/renderer/features/chat/tool-presentation.ts` —— 纯逻辑层（参数 / 结果 / details → 组件入参）
- `src/renderer/components/assistant-ui/elements/tool-call.tsx` —— 通用折叠行
- `src/renderer/components/assistant-ui/elements/tool-timeline.tsx` —— 多步轨迹
- `src/renderer/features/chat/message-parts.tsx` —— part 分发与分组边界

工具清单来自 `src/main/pisdk/tools.ts` 的 `buildTools()`（`tools.ts:172-208`）与 `TOOL_NAMES`（`tools.ts:45-59`）。

### 1.2 方法

1. 逐文件读渲染链，把「工具名 → 触发行 → 展开内容」三者对应起来；
2. 写两组临时 jsdom 探针，直接渲染 `ToolCallPart`，把展开区的 `innerHTML` 与 `getComputedStyle` 打出来（探针文件已删，输出抄录在 §4）；
3. 对拍既有测试（`tool-call.test.tsx`、`job-tool-ui.test.tsx`、`subagent-tool-ui.test.tsx`、`tool-presentation.test.ts`、`AskSection.test.tsx`），确认哪些口径已被钉住。

---

## 2. 三条渲染路径

工具在主会话里**不是**一种形状，而是三条。这一点决定了「展开一致性」不可能靠改一个组件达成。

### 路径 A —— 通用折叠行 `ToolCall`

入口 `ToolParts.tsx:959-1024`，组件 `tool-call.tsx:36-117`。

```
触发行的构成（tool-call.tsx:57-87）
  ▸ 折线箭头（展开时旋转 90°）
  ▸ 动词 SwapLabel（进行态 shimmer ↔ 收尾态）
  ▸ 参数 chip（mono 小胶囊，toolChip(args)）
  ▸ 收尾标记（绿勾 / 红叉，跑动中为空）
展开区的构成（tool-call.tsx:88-113）
  detail 存在 → 只用 detail（内置面板被整体顶掉）
  detail 不存在 → 内置 Request / Result 文本面板
```

### 路径 B —— 状态 pill（`AgentStatusList`）

两条分支绕开 `ToolCall`，整条交给 pill：

- 子智能体四件套 `ToolParts.tsx:980-988` → `<SubagentStatus>`
- 后台作业四件套 `ToolParts.tsx:996-999` → `<JobStatus>`

展开区**不在 pill 里**，而是 pill 下方独立一块（报告 markdown / 作业 `pre` 输出），默认收起、点 pill 展开。
两者都注册成 `display: "standalone"`（`ToolParts.tsx:1045-1088`），因此不会被折进思维链。

### 路径 C —— 时间线步骤 `ToolTimeline`

`ToolParts.tsx:1097-1137`。多步且全部成功时收成一条轨迹（`rows.length >= 2 && !rows.some(failed)`，`ToolParts.tsx:1113`）。
每一步**各自**可展开（`ToolTimeline` 内部持有 `openSteps`，`tool-timeline.tsx:57`），展开的是该步自己的 rich 详情。

### 三者的展开状态各自独立

| 路径 | 状态存放 | 是否受控 |
| --- | --- | --- |
| A | `ToolCallPart` 的 `useState`（`ToolParts.tsx:961`） | 受控（`ToolCall` 是受控 Collapsible） |
| B | `SubagentStatus` / `JobStatus` 各自的 `useState`（`ToolParts.tsx:365`、`:606`） | 自管 |
| C | 外层 `ToolRunGroup` 一个 + `ToolTimeline` 内部 `openSteps` 集合（`ToolTimeline:57`） | 混合 |

**没有任何一处的展开状态会被持久化或互相联动** —— 切走会话再回来，展开态全丢（消息组件卸载）。这属于既有设计，不是缺陷，但它是「一致性」讨论必须承认的前提。

---

## 3. 逐工具矩阵（27 个内置工具 + MCP）

图例：`✅` 有专属详情 ｜ `📄` 落内置文本面板 ｜ `🟡` pill ｜ `—` 无 ｜ `⚠️` 见缺陷编号

| # | 工具 | 图标 | 动词 | chip | 展开内容 | 路径 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bash` | ✅ | ✅ | `command` | `TerminalBlock`（命令 + 末尾 30 行 + `exit 0`） | A |
| 2 | `read` | ✅ | ✅ | `path` | 📄 **换行被折叠** ⚠️D1 ｜ 无专属详情 ⚠️D5 | A |
| 3 | `write` | ✅ | ✅ | `path` | 📄 纯文本一行结果 | A |
| 4 | `edit` | ✅ | ✅ | `path` | `CodeDiff`（文件名 + ±行数 + 逐行 diff，上限 80 行） | A |
| 5 | `grep` | ✅ | ✅ | `path` / `pattern` | 📄 **多行命中被折叠成一行** ⚠️D1 | A |
| 6 | `glob` | ✅ | ✅ | `pattern` | 📄 **多行路径被折叠成一行** ⚠️D1 | A |
| 7 | `todo` | ✅ | ✅ | `1/3` 进度（空清单时为空） | `TodoList`（清单 + rev） | A |
| 8 | `ask_user` | ✅ | ✅ | **恒为空** ⚠️D6 | 📄 答案长句 ⚠️D4 | A |
| 9 | `bash_background` | ✅ | ✅ | `command` | pill + `pre` 输出（`whitespace-pre-wrap`） | B |
| 10 | `job_output` | ✅ | ✅ | `id` | 同上 | B |
| 11 | `job_list` | ✅ | ✅ | `id` | 同上（批量时报「共 N 个作业」） | B |
| 12 | `job_kill` | ✅ | ✅ | `id` | 同上 | B |
| 13 | `browser_open` | ✅ | ✅ | `url` | 📄 页面状态文本 | A |
| 14 | `browser_history` | ✅ | ✅ | `back` 等 | 📄 | A |
| 15 | `browser_snapshot` | ✅ | ✅ | **空** ⚠️D6 | 📄 快照文本（含元素清单） | A |
| 16 | `browser_act` | ✅ | ✅ | `click` 等 | 📄 动作回执 | A |
| 17 | `browser_wait` | ✅ | ✅ | **空** ⚠️D6 | 📄 等待结果 | A |
| 18 | `browser_screenshot` | ✅ | ✅ | **空** ⚠️D6 | 📄 文字说明；**图片本身丢失** ⚠️D8 | A |
| 19 | `browser_logs` | ✅ | ✅ | `console` / `network` | 📄 日志正文 | A |
| 20 | `browser_dialog` | ✅ | ✅ | `accept` 等 | 📄 | A |
| 21 | `browser_evaluate` | ✅ | ✅ | 脚本（截断） | 📄 求值结果 | A |
| 22 | `web_search` | ✅ | ✅ | `query` | 来源卡（**顶掉面板 → 结果正文不可见**） ⚠️D3 | A |
| 23 | `web_fetch` | ✅ | ✅ | `url` | 状态卡（**顶掉面板 → 页面正文不可见**） ⚠️D3 | A |
| 24 | `Task` | ✅ | ✅ | `description` | pill + markdown 报告 | B |
| 25 | `TaskWait` | ✅ | ✅ | 空（**不渲染**，走 pill） | pill（记账调用无耗时、无报告） | B |
| 26 | `TaskList` | ✅ | ✅ | 空（**不渲染**，走 pill） | pill | B |
| 27 | `TaskStop` | ✅ | ✅ | 空（**不渲染**，走 pill） | pill | B |
| — | `mcp__*` | 兜底 | 兜底 | 任意字符串 / 空 | 📄 ⚠️D1 | A |

**汇总**：

- 专属详情只有 **6 类**：`bash`、`edit`、`todo`、`web_search`、`web_fetch`、`Task` 系列（+ 作业系列走 pill）。
- **14 个内置工具 + 全部 MCP 工具** 落内置文本面板，其中 `read` / `grep` / `glob` / `browser_*` 的输出天然多行 → 全部命中 D1。
- `ask_user` 恒有一枚空胶囊；`browser_snapshot` / `browser_screenshot` / `browser_wait` 在只带（或不带）`tab` 参数时同样为空（§4-D6）。

### 3.1 落点判定逻辑（`resolveToolDetail`）

`tool-presentation.ts:502-555` 是唯一的判定入口，顺序有意义：

```
1. isError === true        → null（失败一律不给详情）
2. 子智能体四件套           → { kind: "subagent" }
3. 后台作业四件套           → { kind: "job" }
4. bash                    → { kind: "terminal" }
5. todo                    → { kind: "todo" }（details 优先，流式期退到 args）
6. web_search / web_fetch  → 卡片数据
7. if (toolName !== "edit") return null;   ← 硬门（tool-presentation.ts:549）
8. edit + 可解析 patch      → { kind: "diff" }
```

第 7 行是**唯一的兜底出口**：不在上面六类里的工具，无论 `details` 多丰富，一律 `null` → 内置面板。
新增专属详情必须插在它**之前**（源码注释 `tool-presentation.ts:541-546` 已经点明这个坑）。

---

## 4. 缺陷清单

### D1 · P0 —— 内置面板不保留换行，多行结果被压成一整行

**位置**：`tool-call.tsx:96-113`（内置面板）

```tsx
// tool-call.tsx:108-111
<div className="px-3.5 pt-2 pb-2.5">
  <p className={cn(mono, "text-ink-4 mb-1")}>Result</p>
  <p className="text-foreground">{result}</p>   // ← 没有 whitespace-* 工具类
</div>
```

`result` 是纯文本，里面的 `\n` 在 `white-space: normal` 下**塌成一个空格**。

**实测**（探针渲染 `read`，`result = "  1\tL1\n  2\tL2"`）：

```
<div class="..."><p class="text-foreground">  1	L1
  2	L2</p></div>
```

DOM 里换行还在，但类名是 `text-foreground`，**没有任何 `whitespace-*`**。`getComputedStyle` 读回空串（jsdom 不加载 CSS），因此我又查了构建产物 `dist/assets/index-BlyWCjqg.css`：全文只有 8 条 `white-space` 规则，命中的是 `sr-only` / `truncate` / `whitespace-nowrap` / `whitespace-pre` / `whitespace-pre-wrap` / 3 条 xterm —— **没有任何一条作用于这个面板**。

**对照**（同一仓库内其它地方都做对了）：

| 位置 | 处理 |
| --- | --- |
| `terminal-block.tsx:80` | `break-words whitespace-pre-wrap` |
| `ToolParts.tsx:691`（作业输出） | `break-words whitespace-pre-wrap` |
| `tool-fallback.aui.tsx:224`、`:266` | `whitespace-pre-wrap` |
| `tool-call.tsx:110`（本面板） | ❌ 无 |

**影响面**：落内置面板的 **14 个内置工具 + 全部 MCP 工具**都走这一段。其中输出天然多行、因而**实际被压平**的是：
`read`（分页读一个文件 → 界面上是一整行）、`grep`（每条命中一行）、`glob`（每行一个路径）、
`ask_user`（答案一行一题）、`browser_snapshot`（元素清单）、`browser_logs`（日志逐条）、
`browser_evaluate`（求值结果）、以及 `browser_open` / `history` / `act` / `wait` / `screenshot` 的
`tab 行 + 正文` 两行结构 —— 单行结果（`write`、`browser_dialog`）不受影响。
另加 MCP 工具的任意多行输出（MCP 结果的形状完全由外部 server 决定）。

**附带问题**：`Request` 段用了 `font-mono`（`tool-call.tsx:105`），`Result` 段却是比例字体（`:110`）。`read` 的输出是 `行号 + Tab + 原文` 的定宽结构，比例字体下**行号列对不齐**。

**这正是用户提出的「读取工具也要显示读取的内容」的实质** —— 内容其实一直有，只是渲染成了不可读的形状。

---

### D2 · P0 —— 时间线里无详情的步骤，展开后是空面板

**位置**：`ToolParts.tsx:1118-1123` + `tool-timeline.tsx:108-116, 128-131`

`ToolRunGroup` 给**每一步无条件**挂 detail 渲染函数：

```tsx
// ToolParts.tsx:1118-1123
const steps: TimelineStep[] = rows.map((row) => ({
  verb: t((TOOL_LABELS[row.name] ?? FALLBACK_LABELS).resting),
  chip: row.chip,
  icon: TOOL_ICONS[row.name] ?? DEFAULT_ICON,
  detail: (stepOpen: boolean) => <StepDetail index={row.partIndex} open={stepOpen} />,  // ← 恒有
}));
```

而 `StepDetail` → `PartDetail`（`ToolParts.tsx:921-935`、`:884-913`）在 `resolveToolDetail` 返回 `null` 时渲染 `null`。
`ToolTimeline` 判定「要不要画展开箭头」的依据只是 `detail !== undefined`（`tool-timeline.tsx:108`），于是：

```tsx
// tool-timeline.tsx:128-131
<CollapsibleContent className={cn(collapsePanel, "outline-none")}>
  <div className="pt-2">{stepDetail(stepOpen)}</div>   // ← null 时留下一个只有 padding 的空 div
</CollapsibleContent>
```

**实测**（探针：两步，`detail: () => null`）：

```
步骤行数 = 2
每行都有展开箭头? 3        ← 2 个步骤箭头 + 1 个组箭头
点开第一步后，面板 innerHTML = "<div class=\"pt-2\"></div>"
```

**影响面**：任何「2 步以上、全部成功」的工具组里，只要步骤属于落内置面板的那 14 类（`grep` + `read` 是子智能体和主智能体最常见的组合），**每个步骤都长着一个点了没反应的箭头**。
**这是仓库自己已经立过的规矩的反例**。`job-tool-ui.test.tsx:143-152` 对作业 pill 明确写过：

> 还没有结果时不摆一个点了没反应的按钮 —— 那种「点了没反应」正是这个功能被报过的毛病

同一条原则在时间线上没有被执行。

---

### D3 · P1 —— 详情一旦存在就顶掉内置面板，`web_fetch` 正文 / `web_search` 结果文本彻底不可见

**位置**：`tool-call.tsx:89`（`detail !== undefined ? ... : ...` 二选一，不是叠加）

**实测**（探针：`web_fetch`，`result = "PAGE BODY SENTINEL 正文内容一二三"`）：

```
<div class="mt-(--density-gap-inner)"><div class="... p-3">
  <span ...>HTTP 200</span><span ...>a.test</span>
  <a href="https://a.test/doc" ...>Doc</a>
</div></div>
正文可见? false
```

`web_search` 同样是 `检索正文可见? false` —— 展开区只有来源卡，工具结果里那份**带摘要的格式化检索文本**在界面上不存在。

**关键点：源码注释与实现相反。** `ToolParts.tsx:287-293` 写着：

> 只显示「取了哪个 URL、返回什么状态」——**正文不在这里**：它已经在工具结果文本里（模型看的就是那份）……**展开区仍然是内置的 request/result 面板。**

但实现里 `detail` 一旦非空，内置面板**根本不会渲染**（`tool-call.tsx:89-113`）。这条注释描述的是「叠加」，代码做的是「替换」。照注释理解的人会以为正文看得到 —— 看不到。

`todo` / `edit` / `bash` 在这条规则下没有损失（详情本身就是超集），**只有网络工具的两个卡片是严格的信息削减**。

---

### D4 · P1 —— `ask_user` 没有专属呈现（用户本次提出的问题）

**现状**：`ask_user` 走路径 A 的**兜底分支**，没有任何 `resolveToolDetail` 分支认它。

#### 4.1 触发行上的空胶囊

`toolChip`（`tool-presentation.ts:89-117`）依次试 `command` → `path`/`file` → `todos` → `description` → `task` → 第一个字符串参数。
`ask_user` 的参数是 `{ questions: [...] }`，**整个结构里没有一个字符串**，于是返回 `""`。

**实测**：

```
chip 存在? true | 文本: ""
chip class: font-mono text-[11px] ... bg-foreground/[0.06] text-ink-2 min-w-0 truncate rounded-md px-1.5 py-0.5
```

`ToolCall` 无条件渲染这个 `<span>`（`tool-call.tsx:71-78`）→ 用户看到一个**宽度只有 padding 的空灰胶囊**。

#### 4.2 展开区的答案长句

展开后是内置面板，答案以工具结果文本的形态出现：

```
Request: {"questions":[{"id":"q1","header":"数据库","question":"用哪个库？","options":["SQLite","Postgres"]}]}
Result:  用户已回答（1/1 题）：
         - 数据库：用哪个库？ → 选定 SQLite
```

这段文本由 `tools/ask.ts:110-129` 的 `formatAnswer` / `formatAnswers` 生成，**是为模型写的**（README 式的一行一题、`选定 X；自由输入：Y`）。给人看是「能用」级别：选项与自由输入混在一句里，没有「我选了什么」的视觉层级，且命中 D1（多行 → 压成一行）。

#### 4.3 结构化数据无人消费

`AskToolDetails`（`tools/ask.ts:74-78`）是完整的三元组：

```ts
export interface AskToolDetails {
  outcome: AskOutcome;          // answered | unanswered | cancelled
  questions: AskQuestion[];
  answers: AskAnswerItem[];     // [{ questionId, selected: string[], text? }]
}
```

它在 `tools/ask.ts:165-169` 被构造、随结果进 `details`，经 `runtime.ts:636-637`（流式）/ `message-mapper.ts:134`（历史回读）落进 part，再经 `message-converter.ts:90` 挂到 aui 的 `artifact` 槽位到达渲染层 —— **然后没有任何代码读它**。全仓搜 `AskToolDetails` 的消费者：零。

#### 4.4 两个死词条

`ask.unanswered`（"未回应"）与 `ask.cancelled`（"已取消"）在 `zh-CN.ts:561-562` / `en-US.ts:577` 都存在，但**全仓没有任何 `t()` 调用它们**（`scripts/check-i18n.mjs` 只查「用了但没定义」，反向不查，所以这类死键不会被门禁抓到）。它们的存在说明**「已决的提问要在会话里留一条可看的记录」这件事曾被计划过，但没接线**。

`AskSection.tsx:26` 与 `chat-store.ts:953-957` 的口径是「结算即移出列表，不留已决态」：

```ts
// chat-store.ts:952-957
// 已结算（用户作答 / 超时未回应 / 运行被停）：卡片撤下，不留已决态
case "ask-resolved":
  set((state) => ({ pendingAsks: state.pendingAsks.filter((a) => a.id !== event.id) }));
```

所以**提问卡消失之后，会话里唯一还能看到答案的地方就是这条工具行** —— 而它现在是最将就的那一种。

---

### D5 · P1 —— `read` 没有专属详情

`resolveToolDetail` 对 `read` 直接落到 `toolName !== "edit"` 的硬门（`tool-presentation.ts:549`）返回 `null`。
`read` 的结果形状是稳定且高价值的：`行号 + Tab + 原文`，外加内核追加的两类尾注（`read.ts:21-24` 的 `FOOTER_PATTERN` / `OVERSIZED_LINE_PATTERN`，包装层 `read.ts:45-53` 已把它们与正文分开处理）。

即使只修 D1，`read` 也只是「能换行了」；要真正「显示读取的内容」，需要一个带**行号列对齐**与**尾注单独样式**的文件视图详情（`kind: "file"`）。
`read` 的 `details` 只带截断信息（内核 `read.js:78-104` 只塞 `{ truncation }`），页信息（`offset` / `limit` / 总行数）要从 `args` + 结果尾注解析 —— 现成材料齐备。

---

### D6 · P2 —— 4 个工具的 chip 恒为空（无法通过换参数规避）

同一根因（`toolChip` 只认字符串参数）。**实测**：

| 工具 | 实际参数 | chip |
| --- | --- | --- |
| `ask_user` | `{questions: [...]}` | `""` — **恒为空** |
| `browser_snapshot` | `{}` / `{tab}` | `""` |
| `browser_screenshot` | `{}` / `{tab}` | `""` |
| `browser_wait` | `{ms: 500}`（数字）/ `{tab}` | `""` |
| `browser_wait` | `{text: "…"}` / `{selector: "…"}` | 有值（`shortenPath`） |
| `todo` | `{todos: []}`（空清单） | `""`（合理） |
| `TaskWait` / `TaskList` / `TaskStop` | `{delegationIds}` / `{}` | `""`（走 pill，chip 不渲染） |
| `browser_history` | `{action: "back"}` | `"back"` ✓ |
| `browser_act` | `{action: "click", ref: "e12"}` | `"click"` ✓ |
| `browser_dialog` | `{action: "dismiss"}` | `"dismiss"` ✓ |

注意 `browser_history` / `browser_act` / `browser_dialog` 的 chip 是**动作名**（`back` / `click` / `dismiss`），经 `toolChip` 末尾「第一个字符串参数」兜底拿到 —— 语义上说得通但不是刻意设计，将来改 `toolChip` 的兜底顺序会连带改变它们（`tool-presentation.ts:114-116`）。

真正暴露给用户、且**无法通过换参数规避**的空胶囊有 4 个：`ask_user`、`browser_snapshot`、`browser_screenshot`、`browser_wait`（`ms` 形态）。

---

### D7 · P2 —— 失败态一律失去专属详情，而错误恰恰是多行的

`tool-presentation.ts:508` 的第一道判断：

```ts
if (isError === true) return null;
```

后果：**失败**的 `bash` 没有终端块、失败的 `edit` 没有 diff、失败的 `web_search` 没有来源卡。
这条规则本身是**刻意的**（注释 `tool-presentation.ts:491`：失败走折叠行，标记表达失败），但它与 D1 叠加成了最糟的组合：

- 失败的工具**恰恰**输出多行（栈、编译错误、`grep` 式命中）；
- 它又**一定**落进不保留换行的内置面板（D1）。

于是界面上最需要读的那一段，是压成一整行的。`ToolParts.tsx:948-949` 的注释「工具的错误文案本来就在 result 里，展开就能看到」在 D1 存在时不成立。

（注：作业系列**故意**绕开这道闸门，`ToolParts.tsx:989-999` 有详细说明 —— 那是正确的例外，可作为改造时的参照。）

---

### D8 · P2 —— `browser_screenshot` 的图片被丢弃

`browser.ts:1011-1020` 返回两个 content 块：

```ts
content: [
  { type: "text", text: `${tabLine(...)}\nScreenshot of the visible viewport (${w}×${h}).` },
  { type: "image", data: shot.data, mimeType: shot.mimeType },
],
details: { width: shot.width, height: shot.height, tabId: ops.tabId },
```

而两条落盘 / 推送路径都**只取文本块**：

- `runtime.ts:590-598`（流式 `toolResultValue`）：`content.filter(block => block.type === "text")`
- `message-mapper.ts:117-126`（历史回读 `toolResultValue`）：同上

文本非空 → 直接返回文本，**image 块被丢掉**。`details` 里只有宽高。
`resolveToolDetail` 也没有 `browser_*` 分支 → 截图在界面上**完全不存在**（只有一行「截了一张 1280×720 的图」）。

（用户消息里的图片走的是另一条路：`ChatPart` 有 `image` 类型，`message-converter.ts:98-99` 映射到 `Image` 组件。工具结果没有这条通道。）

---

### D9 · P2 —— 内置面板的 `Request` / `Result` 是硬编码英文

`tool-call.tsx:104`、`:109` 是字面量：

```tsx
<p className={cn(mono, "text-ink-4 mb-1")}>Request</p>
...
<p className={cn(mono, "text-ink-4 mb-1")}>Result</p>
```

`tool-call.tsx` 没有 import `useTranslation`，两个语言包里也没有对应词条（`check-i18n.mjs` 通过，因为它只抓 `t("…")` 调用）。中文界面下这两个标签是英文。

---

### D10 · P2 —— `web_fetch` / `todo` 的详情粒度问题（设计取舍，列出以便决策）

- `WebFetchDetail`（`ToolParts.tsx:294-317`）只画「状态码 + hostname + 标题」，`truncated` 字段被 `parseWebFetchDetail` **主动丢弃**（`tool-presentation.ts:485-486` 不读 `truncated`），用户无法知道正文被截断。
- `TodoDetail`（`ToolParts.tsx:224-231`）是 `paper` 面板，而 `TodoList` 自带 `max-w-sm`（`todo-list.tsx:37`）—— 在宽消息流里它只占 384px，右侧大片空白。同一份 `TodoList` 在右侧 `TodoPanel` 里是同一形状，属可接受，但与 `edit` 的 diff 满宽并排时视觉不齐。

---

## 5. 直接回答「ask_user 回答后要能展开看到」

**结论：技术上已经能看到，但不合格。** 逐条对照用户的要求：

| 要求 | 现状 | 判定 |
| --- | --- | --- |
| 工具行能展开 | ✅ `ToolCall` 默认提供折叠 | 通过 |
| 展开能看到回答内容 | ⚠️ 看得到，但是给模型写的长句，且多行被压平（D1） | **不合格** |
| 风格参考其他工具 | ❌ 触发行挂着**空胶囊**；没有像 `CodeDiff` / `TodoList` 那样的专属面板 | **不合格** |
| 结构化答案 | ❌ `details` 里的 `outcome`/`questions`/`answers` 零消费者 | **不合格** |

**改造所需材料已经全部就位，缺的只是一段渲染**：

```
tools/ask.ts:74-78         AskToolDetails 契约（outcome / questions / answers）
main/pisdk/runtime.ts:636  流式路径写入 part.details
message-mapper.ts:134      历史回读路径写入 part.details
message-converter.ts:90    details → aui 的 artifact 槽位
ToolParts.tsx:965          props.artifact 已经在手上
```

**建议的形态**（与既有工具同构，不需要新组件族）：

1. `tool-presentation.ts` 加 `parseAskDetail(value): { outcome, questions, answers } | null`，逐项校验（照 `parseWebSearchDetail` 的手法，`tool-presentation.ts:458-474`）；
2. `ToolDetail` 联合加一支 `{ kind: "ask", outcome, questions, answers }`；
3. `resolveToolDetail` 的分支插在**硬门之前**（第 7 行 `if (toolName !== "edit")` 之前）；
4. `ToolParts.tsx` 加一个 `AskDetail` 组件，用 `paper` 面板 + 每题一行（header 小字 + question + `selected` 做成与提问卡同款的小胶囊 + 自由输入另起一行），底部用 `ask.unanswered` / `ask.cancelled` 表达两种非作答收尾；
5. `toolChip` 补一条：`questions` 是数组时返回 `第 1 题 / 共 N 题` 或首题的 `header`（消除空胶囊）；
6. 失败闸门（`isError`）对 `ask_user` 保持现状即可 —— 工具自身不抛错，超时/取消都走**成功结果 + outcome**（`tools/ask.ts:171-191`）。

---

## 6. 修复建议（按收益 / 成本排序）

### 第一批 —— 一行级修复，覆盖绝大多数抱怨（建议立刻做）

| # | 改动 | 位置 | 收益 |
| --- | --- | --- | --- |
| F1 | 结果段落补 `whitespace-pre-wrap break-words`，并统一 `font-mono` | `tool-call.tsx:110`（顺带 `:105` 保持 mono） | 一次修好 14 个内置工具 + MCP 的**全部**多行输出（D1） |
| F2 | 只有**确实有内容**时才给时间线步骤挂 detail | `ToolParts.tsx:1122` 改为按可否解析过滤，或让 `StepDetail` 在 `null` 时把 `detail` 判成 `undefined` | 消除「点了没反应的箭头」（D2） |
| F3 | `Request` / `Result` 走 `t()`，两语言包补键 | `tool-call.tsx:104,109` + locales | 中文界面不再夹英文（D9） |

> F2 的干净做法：`ToolTimeline` 的 `TimelineStep.detail` 已经允许 `undefined`（`tool-timeline.tsx:24`）；把 `detail` 的**存在性判定**挪到构造 `steps` 之前，需要一次「这个工具名是否有专属详情」的纯函数 —— 正好可以导出 `resolveToolDetail(...) !== null` 的轻量版本（不读 result，只看 toolName + details 形状）。

### 第二批 —— 结构性修复（本次用户诉求的主体）

| # | 改动 | 说明 |
| --- | --- | --- |
| F4 | **`ask_user` 专属详情**（§5 六步） | 用户明确要求；材料齐备 |
| F5 | **`read` 专属详情** `kind: "file"` | 行号列对齐 + 尾注单独样式 + 分页提示；真正实现「显示读取的内容」 |
| F6 | `web_search` / `web_fetch` 的详情**与面板叠加**而非替换 | 给 `ToolCall` 加一个「detail 之上仍然渲染内置面板」的口径，或把正文折进卡片（可折叠）。同时**修正 `ToolParts.tsx:287-293` 的注释** |
| F7 | `toolChip` 补 `questions` / 空参数分支 | 消除 4 个空胶囊（D6） |

> F6 需要先决策：是让 `detail` 从「替换」改成「可叠加」，还是维持替换、把丢失的信息搬进 detail。
> 前者动 `ToolCall` 的契约（影响 bash/edit/todo 三个已通过的场景），后者只动两个卡片组件 —— **建议后者**（改动面更小，且 bash/edit/todo 的现状是对的：详情本就是超集）。

### 第三批 —— 可选（先记录，不急）

- **F8**：失败态也允许专属详情，靠 `isError` 给面板染红而不是取消详情（D7）—— 与 F1 叠加后收益下降，可缓。
- **F9**：工具结果里的 `image` 块单独建一条通道（`ChatPart.image` 已有形状，`message-converter.ts:98-99` 已有映射），用于 `browser_screenshot`（D8）。
- **F10**：`web_fetch` 卡片显示 `truncated`（D10）。
- **F11**：展开状态持久化（按 `toolCallId` 存进 `ui-store`）—— 切会话/重挂载不丢（§2 末尾）。

### 建议的门禁补充

- `check-i18n.mjs` 目前是**单向**的（用了没定义 → 失败）。加一条**反向**检查（定义了但全仓无人 `t()`）能立刻暴露 `ask.unanswered` / `ask.cancelled` 这类死键，正是本次 D4 的证据来源。但需先给一批「有意保留」的键开白名单，否则噪音会淹没门禁。
- 建议补一条**组件级回归测试**：断言「内置面板的 Result 段落带有 `whitespace-pre-wrap`」（对应 F1）与「时间线步骤在没有详情时不渲染展开箭头」（对应 F2）。两者都是纯 DOM 断言，现有 `ui` project（jsdom）足够承载 —— `tool-call.test.tsx` 已经是这个形状。

---

## 7. 验收清单

改完之后，下面每一条都应当能用肉眼在应用里确认：

- [ ] `read` 一个 50 行文件 → 展开是 50 行，行号列对齐
- [ ] `grep` 命中 10 处 → 展开是 10 行
- [ ] `browser_snapshot` → 展开是多行的元素清单
- [ ] `grep` + `read` 连续两步被折成时间线 → 每步箭头点开**都有内容**（不是空 div）
- [ ] `ask_user` 作答后 → 触发行有 chip（不是空胶囊），展开能看到每题的「我选了什么」
- [ ] `ask_user` 超时 / 运行被停 → 展开用 `ask.unanswered` / `ask.cancelled` 说明收尾原因（现在是一段给模型看的长句，且这两个词条无人使用）
- [ ] `web_fetch` → 展开能看到页面正文（或明确知道它在哪里）
- [ ] 失败的 `bash` 多行报错 → 展开可读
- [ ] 中文界面下没有 `Request` / `Result` 英文标签

---

## 附录 · 证据索引

| 主题 | 位置 |
| --- | --- |
| 通用折叠行（触发行 / 展开区 / 空胶囊 / 无 whitespace / 英文标签） | `elements/tool-call.tsx:57-87`、`:88-113`、`:71-78`、`:110`、`:104,109` |
| 时间线（箭头条件 / 空面板） | `elements/tool-timeline.tsx:24`、`:108-116`、`:128-131` |
| 工具装配与三条分支 | `features/chat/ToolParts.tsx:959-1024`、`:980-988`、`:996-999` |
| 详情判定与硬门 | `features/chat/tool-presentation.ts:502-555`（硬门 `:549`） |
| `toolChip` 参数优先级 | `features/chat/tool-presentation.ts:89-117` |
| 详情替换面板 | `elements/tool-call.tsx:89` |
| `web_fetch` 卡片与（与实现相反的）注释 | `ToolParts.tsx:294-317`、`:287-293` |
| 时间线步骤恒挂 detail | `ToolParts.tsx:1118-1123` |
| 失败闸门 | `tool-presentation.ts:508`；例外见 `ToolParts.tsx:989-999` |
| 「不摆点了没反应的按钮」既有原则 | `features/chat/job-tool-ui.test.tsx:143-152` |
| `ask_user` details 契约 | `main/pisdk/tools/ask.ts:74-78`、`:110-129`、`:165-191` |
| `ask_user` 出题 / 作答契约 | `shared/contracts/interaction.ts:9-52` |
| 提问卡（固定在输入框上方、结算即撤） | `features/chat/AskSection.tsx:26`、`stores/chat-store.ts:944-957` |
| 死词条 | `shared/i18n/locales/zh-CN.ts:561-562`、`en-US.ts:577` |
| 结果文本只取文本块（丢图片） | `main/pisdk/runtime.ts:590-598`、`main/pisdk/message-mapper.ts:117-126` |
| `browser_screenshot` 返回 image 块 | `main/pisdk/tools/browser.ts:1011-1020` |
| details → artifact 映射 | `runtime/message-converter.ts:88-95` |
| 工具清单 | `main/pisdk/tools.ts:45-59`、`:172-208` |
| 图标 / 动词表（27 项齐全） | `ToolParts.tsx:82-115`、`:120-156` |
| 换行的正确写法（对照） | `terminal-block.tsx:80`、`ToolParts.tsx:691`、`tool-fallback.aui.tsx:224,266` |

**探针复现方式**（本次审计用过、已删除）：新建 `src/renderer/features/chat/zz-probe.test.tsx`（`ui` project / jsdom），直接 `render(<ToolCallPart {...props} />)`，`fireEvent.click` 触发行后读 `container.querySelector('[data-slot="collapsible-content"]')?.innerHTML`；用 `npx vitest run --project ui <file>` 执行。
