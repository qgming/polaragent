---
feature: chat-surface-refine
status: delivered
updated: 2026-09-11
branch: feat/assistant-ui-elements
commits: 9abbce7..eb5fec5
---

# Chat 消息与工具呈现细化

## Report

**What was built**

工具调用改成了「折叠行 + 详情面板」两层：折叠行始终是官方 `ToolCall`（单条）或 `ToolTimeline`
（连续多条成组，每步再各自折叠），展开后才出现该工具自己的结果组件——bash 给官方
`TerminalBlock`（命令作标题、末尾 30 行输出作正文、运行中转圈、完成打勾），edit 给官方
`CodeDiff`（文件名 + 增减行数 + 逐行 diff），read/write/未知工具保留内置的 Request/Result
文本面板，失败则整条走官方 `ToolFallback` 的报错块。为此给两个 vendored 组件各加了一个可选
详情插槽（`ToolCall.detail`、`TimelineStep.detail`），缺省行为不变。

edit 的 diff 此前根本到不了渲染层：pi 的 edit 同时返回文本与 `details.patch`，而
`toolResultValue` 优先取文本，patch 在进渲染层前就被丢了。本次给契约加 `ToolCallPart.details`，
主进程两条路径（流式的 `applyToolEnd`、历史回读的 `applyToolResult`）都写入它，渲染层再经
assistant-ui 的 `artifact` 槽位透传到 `ToolCallMessagePartProps.artifact`。选择逻辑与解析
（`resolveToolDetail`、`toEditDiff`、`bashOutput` 等）抽到无 React 依赖的
`tool-presentation.ts`，因为本仓库 vitest 是 node 环境、只收 `*.test.ts`，组件渲染没有测试设施。

同批还收口了四处：输入框三个 chip 的选项文字由灰转墨；删掉底部「运行中 Enter 排队」与停止键
左侧的 shimmer 文案；一次运行只在段尾消息挂一个操作栏（运行中收起、结束后常显、不再依赖
hover）且段内续条收窄间距；思考块去掉外圈边框。此外修掉了工具行在长命令下被压成竖排的
缺陷（动词加 `shrink-0 whitespace-nowrap`、chip 加 `min-w-0 truncate`），并把工具折叠行与
rich 组件的宽度从 `max-w-sm`/`max-w-md` 放开到与思考块一致的自适应宽度（上限即对话宽度 44rem）。

**Verification**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS（exit 0，`tsc --noEmit && tsc -p tsconfig.electron.json --noEmit`） |
| `npm test` | PASS：`Test Files 18 passed (18)` / `Tests 182 passed (182)`（改动前 145，本次 +37） |
| `npm run build` | PASS（`typecheck` 与三个阶段 `vite build` 均成功） |
| `biome lint`（21 个改动文件） | PASS：0 issues |
| `biome check`（`Thread.tsx` / `ToolParts.tsx` / `tool-presentation.test.ts`） | PASS：含格式也干净 |
| 红-绿回归佐证 | 5 处：`message-mapper.test.ts`（details 透传）、`runtime.test.ts`（流式写入，实测停用 `part.details =` 后 2 例变红）、`tool-presentation.test.ts` 的 `bashOutput` 末尾换行 / `toEditDiff` 空补丁 / `toolChip` 命令截断（三者均先实测变红再修） |
| 独立评审（只读子代理，两轮） | 首轮 3 critical + 3 minor，critical 全部修复并复核成立；第二轮确认 5 项修复成立、无 critical，3 minor 已清 |
| 全仓 `npm run lint` | PRE-EXISTING：`biome check .` 在改动前就是红的（工作区全为 CRLF、biome 格式化器要 LF），与本次无关 |

**Journey log**

1. **修 vendored 文件时先看约束**：`ToolCall` 的收尾标记只有绿勾，报错会被读成成功。失败只能
   整条让给 `ToolFallback`，不能靠改这个组件补一个红叉（那要动 vendored 的图标逻辑）。
2. **详情不是替掉折叠行，而是替掉展开面板**。第一版把 rich 组件直接换成整行，读起来像"工具
   调用消失了"；改成插槽后折叠行仍在、语义清楚，也顺带保住了成组时间线。
3. **宽度基准要挑对参照物**。工具组件原本被 `max-w-sm`/`max-w-md` 卡住，而思考块是 `w-full`；
   用户要的"和思考内容一样宽"就是对齐思考块，放开到对话宽度即可，不需要自己算像素。
4. **按参数键分流胜过按内容猜**。`shorten` 原本按"段数 > 2"判路径，而命令里几乎一定有斜杠
   （`cd /foo && …`），长命令被截成 `…/web`。改为看命中的是 `command` 还是 `path`：两者截断
   方向相反，而参数结构本身就分得开，漏传工具名也不会截错。
5. **闭包里的关键写入等于不可测**。`handleToolEnd` 的字段写入藏在 `createChatRuntime` 闭包里，
   于是"details 会不会丢"这条最重要的通路没有测试。提成模块级 `applyToolEnd` 后，两条路径各有
   一组会因回退实现而变红的用例。

## [S1] Problem

上一次提交（`eb5fec5`）把输入框选项、底部操作栏、思考块、工具调用换成 assistant-ui Elements
之后，实际跑一轮带工具的任务暴露出四类问题：

1. **工具行竖向挤压**。`elements/tool-timeline.tsx` 的步骤行里，动词 span 没有 `shrink-0`
   /`whitespace-nowrap`，chip span 没有 `min-w-0`/`truncate`。根容器是 `max-w-sm`，一条长 bash
   命令把动词挤到最小内容宽度；中文可在任意字符换行，于是「运行了」被压成竖排三行。
   `elements/tool-call.tsx` 的 query chip 有同源缺陷（当前只是换行变丑，没有竖排）。
2. **工具输出不可读**。bash 的成功结果已经在 `part.result` 里（就是完整输出文本），但走的
   `ToolCall` 面板把请求与结果当纯文本堆出来，既不像终端也不好扫。
3. **edit 的改动看不到**。pi 的 edit 工具返回 `content:[{text:"Successfully replaced N block(s)…"}]`
   同时返回 `details:{diff,patch,firstChangedLine}`，而 `toolResultValue` 优先取文本，
   **diff 在进渲染层之前就被丢掉**（`src/main/pisdk/runtime.ts:170` 与
   `src/main/pisdk/message-mapper.ts:107` 两条路径都是如此）。渲染层因此拿不到 patch。
4. 同批改动还包含：输入框选项文字偏灰、运行中有冗余文案、一次运行每条消息各带一个操作栏、
   思考块外圈有边框。这四项在本次一并收口（见 Task 中已完成的 T1–T4）。

## [S2] Design

### [S2.1] vendored 工具组件的偏差

两处必要的偏离，其余逐字不动。

**A. 竖向挤压与宽度**。步骤行的动词与 chip 原本都没有防挤压约束，根容器又被 `max-w-sm`
卡在 24rem。宽度基准取思考块：`ReasoningRoot` 是 `w-full`，最宽到对话宽度
（`--layout-thread-max-width: 44rem`，由 Thread 的外层容器封顶）。

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `tool-timeline.tsx` | 根 Collapsible | 去 `max-w-sm` |
| `tool-timeline.tsx` | 步骤行根 div | 加 `min-w-0` |
| `tool-timeline.tsx` | 动词 span | 加 `shrink-0 whitespace-nowrap` |
| `tool-timeline.tsx` | chip span | 加 `min-w-0 truncate` |
| `tool-call.tsx` | 根 Collapsible | 去 `max-w-sm` |
| `tool-call.tsx` | query chip span | 加 `min-w-0 truncate` |
| `terminal-block.tsx` | 根 div | 去 `max-w-md` |
| `code-diff.tsx` | 根 div | 去 `max-w-md` |

`tool-call.tsx` 的标签走 `SwapLabel`（自测宽度 + `overflow-x-clip`，本身不竖排），不动。

**C. chip 的截断策略按参数键分流**。命令与路径的截断方向相反（命令要看开头、路径要看末级），
而 `shorten` 原本按「段数 > 2」判断该不该保留末级——命令里几乎一定有斜杠（`cd /foo && …`），
于是长命令被截成 `…/web` 这种只剩尾巴的样子，正好丢掉要看的部分。改为按**命中的参数键**
分流：`args.command` 走命令规则（保留开头），`args.path`/`args.file` 走路径规则（保留末级）。
不靠调用方传工具名：bash 的参数结构是 `{command}`、read/write/edit 是 `{path}`，
在参数形状上就分得开，漏传工具名也不会截错。

**B. 详情插槽**。两个组件的展开面板原本写死为「Request/Result 文本」与「步骤行列表」，
rich 组件无处可放。各加一个可选插槽，缺省行为完全不变：

| 文件 | 新增 | 说明 |
| --- | --- | --- |
| `tool-call.tsx` | `detail?: ReactNode` | 给了就替掉内置的 Request/Result 面板 |
| `tool-timeline.tsx` | `TimelineStep.detail?: (open: boolean) => ReactNode` | 有 detail 的步骤行套一层嵌套折叠，展开时以该函数的返回值作内容 |

时间线的 detail 用渲染函数而非节点，是为了按需取数：嵌套折叠的开关状态在本组件内，
渲染函数拿到 `open` 才能把「未展开的步骤不读它的 part」交给调用侧（见 [S2.7]）。
同时把步骤行的 key 从 `step.chip` 改为 `${index}-${step.chip}`：嵌套折叠的开关状态挂在行上，
重名 chip 会串位。

rich 组件自带边框与圆角，替掉面板后不再套外层灰底框——design.md 禁止「描边卡片墙」，
两层盒子会违反它。代价是原始 args JSON 不再显示（bash 的命令、edit 的文件名已在 rich 组件里）。

这是本仓库第一次为上游缺陷偏离「与上游逐字一致」的维护约定，属于故意为之，逐条列在上面。

### [S2.2] 工具 details 透传到渲染层

- `shared/contracts/session.ts`：`ToolCallPart` 增加 `details?: unknown`，承载工具自己声明的
  结构化详情（edit 的 `{diff,patch,firstChangedLine}`、bash 的截断信息、read 的截断信息）。
  不按工具名开具体字段：pi 那边就是「工具自定义 details」，跟着它的形状走才不会被工具增减打断。
- `src/main/pisdk/runtime.ts`：`handleToolEnd` 在写 `result` 之外，把 `event.result.details`
  原样写到 `part.details`（仅有值时写入，避免 `details: undefined` 落盘）。
- `src/main/pisdk/message-mapper.ts`：`applyToolResult` 同样从 `message.details` 回填
  `part.details`，保证历史回读与流式两条路径形状一致。
- `src/main/pisdk/runtime.ts`：把流式路径的字段写入提成模块级 `applyToolEnd(part, result, isError)`，
  `handleToolEnd` 调它再发事件。提出来的原因是可测性——这段逻辑原本在 `createChatRuntime`
  的闭包里够不到，而它正是把 diff 送到 UI 的唯一路径。同时它与 `applyToolResult` 形成对称：
  两条路径各有一个可导出的写入入口，各有一组回归用例。
- 契约新增 `details` 不影响既有消费方：现有渲染代码不读它。

### [S2.3] bash 的详情用 TerminalBlock

`toolName === "bash"` 且非错误时，展开面板里的内置 Request/Result 换成官方 `TerminalBlock`：
命令作标题、输出作正文、运行中转圈、完成打勾。

- 数据：`command = args.command`（非字符串则空串），`done = status.type !== "running"`。
  运行中 `result` 为 undefined，`lines` 取空数组即转圈态。
- 输出上限 `BASH_TAIL_LINES = 30`：只展示**末尾** 30 行，超出时在数组头部插一行省略提示。
  取末尾而不是开头，因为命令的关键结论（错误、统计、列表）通常在末尾。
- **末尾换行不算一行**：命令输出几乎都以 `\n` 结尾，`split("\n")` 会在尾部多出一个空段。
  算作一行会挤掉真正的首行，并把 `TerminalBlock` 的末行高亮落到那个空串上。
  只去尾部这一个；中间与内部的空行是排版的一部分，照原样保留。
- 失败不走这里：pi 的 bash 在非零退出时抛错，`isError` 为真，整行走 [S2.5] 的 `ToolFallback`。
  `TerminalBlock` 写死的 "exit 0" 因此与成功语义一致，不需要额外分支。

### [S2.4] edit 的详情用 CodeDiff

`toolName === "edit"`、非错误、且 details 里有非空 `patch` 时，展开面板换成官方 `CodeDiff`。
解析复用仓库已有的 `parsePatch`（`@/renderer/components/ui/diff-viewer` 导出，基于
`parse-diff`），它已产出 `{oldName, newName, lines:[{type:'add'|'del'|'normal',content}],
additions, deletions}`，与 `CodeDiff` 的 `DiffLine[]` 一一对应：

| parsePatch | CodeDiff |
| --- | --- |
| `type: "add"` | `kind: "added"` |
| `type: "del"` | `kind: "removed"` |
| `type: "normal"` | `kind: "context"` |
| `additions` / `deletions` | 同名 props |
| `newName ?? oldName` | `filename` |

- `cycle` 传 `0`：该 prop 只用于 React key 的动画重放，本场景不需要重放。
- 行数上限 `DIFF_MAX_LINES = 80`：超出只取前 80 行并追加省略提示。
- **不见增删行就不给详情**：判据是 `additions + deletions === 0`，不是「有没有解析出文件」。
  只有文件头（0 个块）与只有空 context 行（`@@ -1 +1 @@` 单独一行）两种输入都会被
  parse-diff 解析成「1 个文件」，看文件数会渲染出「文件名 +0 −0」的空块；按增删数判定则
  两种都落回内置文本面板，不显示空块。
- 任一条件不满足（无 patch、旧历史数据、失败）都不给 detail，落回内置的文本面板。

### [S2.5] 单条与成组的呈现

`ToolCall` / `ToolTimeline` 始终是折叠行（trigger），rich 组件只出现在展开的面板里。

单条调用（`ToolCallPart`）的选择表：

```
isError === true              → 整行走 ToolFallback（官方报错块，含审批入口）
toolName === "edit" 且有 patch → trigger 用 ToolCall，detail 用 CodeDiff
toolName === "bash"            → trigger 用 ToolCall，detail 用 TerminalBlock
其余（read / write / 未知）     → trigger 用 ToolCall，无 detail（内置 Request/Result 文本面板）
```

`ToolRunGroup` 的成组规则不变：连续 2 条以上且全部成功 → 官方 `ToolTimeline`；
单条、或组内有失败 → 逐条按上表渲染。时间线的每一步按上表拿到自己的 detail，
展开该步即看到该步的 rich 结果（嵌套折叠）。

因此「单条 bash 展开是终端块、多条 bash 收成时间线后逐步展开也各自是终端块」是刻意取舍。
选择与解析合成一个纯函数 `resolveToolDetail(toolName, details, isError)`，与渲染分开以便测试
（本仓库 vitest 是 node 环境、只收 `*.test.ts`，组件渲染没有测试设施）。

### [S2.6] 同批收口项（已完成，记录现状）

- 输入框三个 chip 的常色由 `foreground/55` 提到 `foreground`（思考等级五档同改）。
- 删掉底部「运行中 Enter 排队…」与停止键左侧的 shimmer 文案，运行态与空闲态只差最后一个按钮。
- 一次运行只在段尾消息挂一个操作栏，`hideWhenRunning` 保留（运行中收起、结束后常显、
  不依赖 hover）；段内续条收窄间距，整次输出读作一块。
- 思考块 `ReasoningRoot` 用 `variant="ghost"`，去掉外圈边框。

### [S2.7] 详情按需取数

`ToolRunGroup` 为每一步提供 `<StepDetail index open>`，它的订阅以展开状态为闸门：

```
const part = useAuiState((s) => (open ? s.message.parts[index] : undefined));
```

未展开时选择器恒返回 `undefined`，`Object.is` 成立，流式期间既不重渲染也不读 part；
只有展开的那一步跟随 part 变化。这不是过早优化：bash 输出上限 256KB，
若每一步都无条件订阅，一次工具输出之后的每个 token 都会把整段输出再读一遍。

`ToolRunGroup` 汇总步骤用的 `signature`（名字 / chip / 失败标记）仍走 JSON 字符串，
但**不含 result**——那份快照要按 token 重算，不能带大块文本。

## [S3] Out of Scope

- 官方 `ReasoningTrigger` 的 "Reasoning"、`ToolFallback` 的 "Used tool"、`ToolCall` 内置面板的
  "Request"/"Result" 仍是写死的英文。中文化需要给 vendored 文件加 `label` 参数，本次不做。
  带 rich 详情的 bash/edit 因为面板被替掉，连带不显示这两个英文标签。
- 不放宽 `TerminalBlock` 的 `min-h-[8.5rem]`：bash 的详情面板因此至少占 136px 高，
  这是官方组件的既定尺寸，不去改。
- 不改 `CodeDiff` / `TerminalBlock` 内部的配色与动画。
- 时间线的嵌套详情不做成手风琴（可以同时展开多步）：多步对照是常见需求，
  限制一次只开一步反而添麻烦。
- **被拒绝/待审批的工具在整条消息结束后仍显示绿勾**。`ToolCall` 的收尾标记是
  `!running` 就出勾，而这些 part 的 `result` 始终是 undefined，assistant-ui 因此把它们
  判成"未完成"跟随 `message.status`；消息一旦完成，等待审批或被拒绝的调用就会盖上绿勾。
  修它要往 part → assistant-ui status 的通路里加字段（`message-converter` 目前不传应用侧的
  `status`），超出"详情面板"的范围，本次只记录。触发条件是消息结束时该调用仍无结果。
- `src/main/pisdk/message-mapper.ts` 的 `toolResultValue` 与 `runtime.ts` 的同名函数行为不完全
  一致（前者无文本时退回整个 content 数组，后者返回空串），实时与回读的形状因此可能不同。
  非本次引入，改动它会影响既有会话的回读表现，不在本次范围。

## Tasks

- [x] T1: 输入框选项文字转墨色 + 清掉运行中冗余文案 — acceptance: `chipTrigger` 与思考等级五档常色为 `text-foreground`，`chat.queueHint`/`approval.stopAfterStep` 不再被引用 (covers: S2.6)
- [x] T2: 一次运行只留一条常显操作栏 + 思考块去边框 — acceptance: 连续助手消息只有段尾带操作栏，`ReasoningRoot` 带 `variant="ghost"` (covers: S2.6)
- [x] T3: 接入官方 ToolCall / ToolTimeline — acceptance: 单条走 `ToolCall`、2 条以上成功走 `ToolTimeline`、失败回退 `ToolFallback` (covers: S2.5)
- [x] T4: 修 vendored 工具行竖向挤压 — acceptance: 长 bash 命令下动词保持单行横向，chip 单行省略号截断 (covers: S2.1)
- [x] T5: 打通工具 details 到渲染层 — acceptance: `ToolCallPart.details` 在流式与历史回读两条路径都被填充，并经 `artifact` 槽位抵达 `ToolCallMessagePartProps.artifact`；两条路径各有一个会因回退实现而变红的用例（`message-mapper.test.ts` 与 `runtime.test.ts` 各有实测红-绿记录）(covers: S2.2)
- [x] T10: 宽度对齐思考块 — acceptance: 工具折叠行与 rich 组件都撑满消息栏、最宽 44rem，与 `ReasoningRoot` 一致，不再有 `max-w-sm`/`max-w-md` 截断 (covers: S2.1)
- [x] T11: 给两个 vendored 组件加详情插槽 — acceptance: `ToolCall` 的可选 `detail` 缺省时行为与改动前一致；`TimelineStep.detail` 为渲染函数，有它的步骤行套嵌套折叠、行 key 含下标 (covers: S2.1)
- [x] T12: 详情按需取数 — acceptance: 未展开的步骤不订阅其 part，展开才取；`ToolRunGroup` 的汇总快照不含 result 文本（`tool-presentation.test.ts` 断言快照里没有 result 内容）(covers: S2.7; depends: T11)
- [x] T13: `resolveToolDetail` 纯函数与用例 — acceptance: 失败优先于一切、edit+patch 走 diff、bash 走 terminal、其余为 null；`tool-presentation.test.ts` 覆盖这四条分支 (covers: S2.5)
- [x] T6: bash 详情用 TerminalBlock — acceptance: 单条与时间线各步展开后都给出命令标题 + 输出正文的数据；超 30 行只留末尾并标明省略行数；末尾换行不算一行；运行中为转圈态 (covers: S2.3; depends: T5, T11)
- [x] T7: edit 详情用 CodeDiff — acceptance: edit 有增删行时展开渲染文件名 + 增减行数 + 逐行 diff；无 patch、或补丁无增删行时落回内置文本面板 / `ToolFallback` (covers: S2.4; depends: T5, T11)
- [x] T14: 修 chip 的命令截断 — acceptance: 带斜杠的长命令按命令规则保留开头，不再被截成 `…/末级`；`tool-presentation.test.ts` 有实测红-绿记录 (covers: S2.1)
- [x] T8: 验证 — acceptance: `npm run typecheck`、`npm test`、`npm run build` 均 exit 0，改动文件 `biome lint` 无新增问题（命令结果汇总到 Report，由 Finalize 步骤写入）(covers: S2.1, S2.2, S2.3, S2.4, S2.5, S2.7)
- [x] T9: 独立评审 — acceptance: 子代理对 `9abbce7..HEAD` 完整改动给出 spec 合规 / 正确性 / 一致性三份结论；首轮 3 条 critical 已修并复核成立，第二轮确认无 critical (covers: S2.1, S2.2, S2.3, S2.4, S2.5, S2.7)
