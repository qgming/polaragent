# Agent 模式切换 · 实施计划（标准 / 编排）

> **这份文件是计划，不是调研报告。** 调研结论在 `docs/agent-mode-switching.md`；
> 本文只回答「按什么顺序、改哪些文件、怎么验收」。
>
> 本计划收录用户拍板的**九条决定**（§1）。其中 D4 与 D5 是后来的修正，
> **推翻了初稿的两处设计**（改名波及面、标准模式名录过滤），本文已按修正重写。
>
> | 项目 | 锚点 |
> | --- | --- |
> | Oint | `cfb4960` |
> | 内核 | `@earendil-works/pi-agent-core@0.85.1` |

---

## 0. 实施状态（2026-02 完成）

**P0 / P0.5 / P1 / P2 / P3 / P4 全部实现。** 107 个测试文件、1310 个测试通过；
四个门禁（`typecheck` / `test` / `check:i18n` / `check:unwired`）全绿。

| 阶段 | 落地 |
| --- | --- |
| P0 | 删 `maxTurns`（含向后兼容：老定义的该键被忽略）、并发 4→6、七个内置（四个改名不动只重写提示词 + 新增 oracle/designer/verifier）、`<available_subagents>` 索引 |
| P0.5 | `repeat-guard.ts` + runtime 的 `after_tool` / `transform_context` 钩子（soft 3 注入纠正消息 / hard 5 终止） |
| P1 | `readAgentsMd` 两层（全局 → 项目，同路径去重） |
| P2 | 内置技能通道（`resources/skills` 随包 + 三源合并 + `builtin` 来源 + 不可删除）+ `verification-planning` / `simplify` |
| P3 | `AgentMode` 契约 / 会话级绑定 / `sessions:set-mode` / 标准模式身份段 / Composer 模式 chip / 环境信息面板一行 |
| P4 | 编排模式身份段 + **路由段只在编排模式注入** |

### ⚠️ 实施中发现并修复的一个严重缺陷（不在原计划里）

**`buildSystemPrompt` 的结果从来没有交给内核。**

`AgentHarness.create` 的 `systemPrompt` 选项一直没被传（`runtime.ts` 里那段算出来的
字符串只被 `estimateTokens` 用了一次）。而内核的 `resolveSystemPrompt` 在缺省时
**直接返回空串**（`generation.js`）—— 也就是说**模型完全没有系统提示**：
身份、工具指导、技能索引、AGENTS.md、子智能体清单、委派规则，一个字都没进去，
而且**没有任何报错**。所有既有测试都没发现它，因为它们只断言
`buildSystemPrompt(...)` 的**返回值**，没人检查它有没有被传下去。

修复方式与 P3 的需求正好合一：传**函数形式**的 `systemPrompt`
（`resolvePrompt`），内核每个 generation 现算 —— 于是模式切换在下一轮就生效，
不必重建 harness。同时补了 5 条测试专门钉住「**真的传下去了**」这件事
（`runtime.send.test.ts` 的「系统提示的投递与模式」一组，含一条
「切换模式后同一个 harness 的提示跟着变」）。

> 这个缺陷说明一件事：**「算出来了」与「用上了」之间需要一条断言**。
> 新增这类「把 A 接到 B」的改动时，测试要断言边界上的传递，而不只是各端的内容。

### 与原计划的偏差

1. **`Task` 动态清单没有做** —— 改为系统提示里的 `<available_subagents>` 索引
   （与技能索引同构）。`buildTools` 签名因此**不动**，也就没有了「两处调用漏传一处」的风险。
2. **`truncated` 状态保留定义但不产生** —— 磁盘上的历史运行记录里有它，删掉会让旧会话读不出来。
3. **`shouldIncludeDelegationRules(mode)` 抽成了函数** —— 而不是在调用点写
   `mode === "orchestrate"`，将来加第三个模式时只有一处需要回答「要不要注入路由段」。
4. **修了一处与本计划无关的测试脆弱性** —— `bash.test.ts` 的「超时文案」用例真的起
   `sleep 5`，全量跑时并发几十个 shell 会顶穿默认 5 秒；给了显式 20 秒超时并写明理由。

---

## 1. 已确认的决定（用户拍板，不再讨论）

| # | 决定 | 影响 |
| --- | --- | --- |
| **D1** | **编排模式默认不限制工具** | 两个模式都不动工具目录；「严格编排」只作 P5 可选档位 |
| **D2** | **AGENTS.md 分两层，两层都读** | 数据目录 = 全局通用；`<cwd>/AGENTS.md` = 项目级；都存在就都注入 |
| **D3** | **取消 `maxTurns` 上限；并发上限 4 → 6** | 轮次上限**整体删除**，改用「重复调用守卫」（治幻觉导致的重复）作为唯一的异常防线（§3.2） |
| **D4** | **内置子智能体不改名，只改提示词** | 四个名字（`explorer` / `code-reviewer` / `fixer` / `test-runner`）全部保留，**新增三个**（§2） |
| **D5** | **通用模式不在提示词里列子智能体** | 名录靠**系统提示里的自动索引**（与技能索引同构）（§4） |
| **D6** | **新版本安装时，内置技能与子智能体都要更新** | 内置资源随包分发、只读、升级即更新（§3.3） |
| **D7** | **要一个像 skills 清单那样的 agent 清单** | **不是工具** —— 技能清单本身就是系统提示里的一段索引。照做 `<available_subagents>`（§4） |
| **D8** | **所有主 Agent 都不限制使用子智能体，都能用临时子智能体** | 两个模式能力完全相同；模式只影响提示词措辞 |
| **D9** | **编排模式 = 系统提示词里写明内置子智能体名称与搭配方式** | 编排段 = 名录 + 路由阈值；并**优化整套子智能体工具**（§4、§5） |

**D4 的实际含义**：`explorer` / `code-reviewer` / `fixer` / `test-runner` 这**四个名字保留**
（它们清晰、已被测试与用户习惯引用），只**重写它们的提示词与描述**，
再**新增**需要的子智能体。这消掉了初稿里最大的一块工作 ——
原本要改 12 个测试文件的夹具，现在**几乎一个都不用改**。

**D7 的实际含义**：用户放宽了工具形状的约束。重新论证后结论是
**主 Agent 真正缺的只有「不知道自己能派谁」这一件事**，而它**做成系统提示里的自动索引最好**
（零往返、不会漂移，且与技能索引同构）—— 详见 §4。

**D3 的实际含义**：用户判定**轮次上限这个机制本身就不对**（`1000` 也只是把
「发现太晚」推迟得更晚），于是**整体删除**，改用**重复调用守卫** ——
它检测的是**行为特征**（相同调用重复）而不是**资源消耗**（轮次），
所以第 3 次就能发现，而 `maxTurns` 要等到第 1000 轮。

---

## 2. 内置子智能体：保留四个 + 新增三个（D4）

### 2.1 保留并重写提示词

四个名字不动，`BUILTIN_SUBAGENTS` 里它们的 `name` 一字不改，只改
`description` / `prompt`。**不再有任何 `maxTurns`** —— 该字段整体删除（§3.2）。

| 名字 | 现状 | 提示词改动 |
| --- | --- | --- |
| `explorer` | 只读三件套 | 保留「先给结论再给证据」；补一条：**明确写出「搜过哪些关键词 / 目录」**，便于主代理判断覆盖是否充分 |
| `code-reviewer` | 只读三件套 | 保留对抗式立场；强化：结论必须分**「确定缺陷 / 可疑未证实 / 缺测试」**三档（现在有，写得更硬） |
| `fixer` | 六件套 | 补一条：**动手前列出要改的文件清单**（便于主代理核对，也便于并发时避让） |
| `test-runner` | 四件套 | 保留「不许放宽断言」；补一条：**报告里必须给出实际执行的完整命令** |

> **提示词的写作结构照抄现有四个的四段式**（身份+边界 → 工具与权限 → 汇报要求 → 禁止项）——
> 这个结构已被现有测试与用户反馈验证过，不要重写风格。
> 每个定义的 `prompt` 上限是 `MAX_SUBAGENT_PROMPT_CHARS`（20 000），远没到。

### 2.2 新增三个

同样落在 `SUBAGENT_ASSIGNABLE_TOOLS`（`read` / `grep` / `glob` / `bash` / `edit` / `write` / `todo`）
之内，**不引入新权限面**。**同样没有 `maxTurns`**（该字段整体删除，§3.2）。

| 名字 | 定位 | 工具 |
| --- | --- | --- |
| `oracle` | 只读参谋：架构取舍、方案对比、两次没修好的疑难、改动前风险审查 | `read` `grep` `glob` |
| `designer` | 界面与交互的实现与打磨 | `read` `grep` `glob` `edit` `write` |
| `verifier` | 独立复核：先读验收标准、自己决定跑什么、结论三分 | `read` `grep` `glob` `bash` |

**各自的专属段**（前四段与现有四个同构，这里只列要加的）：

- **`oracle`**：`You advise, you don't implement`（只读，不改文件）；
  **`Prefer simpler designs unless complexity clearly earns its keep`**（YAGNI 约束）；
  不确定就说不确定，并说明依据什么、缺什么。
- **`designer`**：一组设计原则（层次 / 间距 / 动效 / 响应式）+
  **「沿用 `src/index.css` 的设计令牌与 `components/assistant-ui/` 的既有形状，
  不引入新的颜色 / 圆角 / 字号」**（对齐 `README.md` 的设计章节）；
  文案要平实，不要术语堆砌。
- **`verifier`**：结论必须三分（**已验证 / 未验证 / 无法验证**）；每条结论附证据；
  **不许为了让命令通过而放宽断言或跳过用例**（与 `test-runner` 同源，措辞保持一致）。

**新增后的总数**：7 个内置。`MAX_SUBAGENT_DEFINITIONS` 是 16，仍余 9 个给用户定义。

### 2.3 设置面板与测试：几乎零改动

- **设置面板**：新定义自动出现在「系统」页签（它读 `loadSubagentCatalog`），**零改动**。
- **i18n**：内置定义的名字与描述**本来就是中文硬编码**（现有四个就是），**零改动**。
- **测试**：`subagent-catalog.test.ts:92-114` 那条「四个预设的名字、工具与轮次上限与契约一致」
  **必须改**：
  - 名字数组 → 七个；
  - `tools` 数组 → 加三项（`oracle` / `designer` / `verifier`）；
  - **删掉 `maxTurns` 那一条断言**（字段已不存在）。
  **其余测试文件的 `explorer` 夹具全部不用动** —— 这正是 D4 的价值。

---

## 3. 数据与常量改动

### 3.1 D2：AGENTS.md 两层都读

**现状**（`runtime.ts:719-726`）：只读 `path.join(dataDir(), "AGENTS.md")`。

**目标**：数据目录（全局通用）+ `<cwd>/AGENTS.md`（项目级），**都存在就都注入**。

实现要点：

- 抽 `readAgentsMd(cwd): Promise<{ global: string; project: string }>`，
  两处各自 try/catch（**任一层缺失或不可读都静默忽略**，与现有行为一致）。
- 注入顺序与标题（**全局在前、项目在后** —— 项目级离当前任务更近，放后面更醒目）：

  ```
  用户自定义指令（全局 AGENTS.md）：
  <数据目录内容>

  项目指令（AGENTS.md）：
  <cwd 内容>
  ```

- **同路径去重**：`path.resolve` 后相等则只读一次（用户把 `OINT_HOME` 设成 cwd 时）。
- **普通 fs 读**，不走 `ExecutionEnv`（与现有读法一致，不要为此引入 env 参数）。
- **渲染层**：`PersonalizationPanel` 本轮**只加一句说明**
  「项目目录里的 AGENTS.md 会与本文件一起生效」，不做项目级编辑器。

### 3.2 D3：并发上限 + 重复调用守卫（**取消 maxTurns**）

| 常量 | 现在 | 改为 | 位置 |
| --- | --- | --- | --- |
| `MAX_CONCURRENT_SUBAGENT_RUNS` | 4 | **6** | `shared/contracts/subagent.ts:63` |
| `MAX_SUBAGENT_MAX_TURNS` | 80 | **删除** | 同上 `:55` |
| `DEFAULT_SUBAGENT_MAX_TURNS` | 30 | **删除** | 同上 `:57` |
| `maxTurns` 字段本身 | 可选字段 | **删除**（定义 / frontmatter / 面板 / schema） | `subagent.ts:90` 等 |

**用户决定：不再有 maxTurns 上限，直接靠重复调用守卫。**

这简化了三处：

1. **契约**：`SubagentDefinition.maxTurns`、`SubagentRun.maxTurns`、
   `SUBAGENT_MAX_TURNS` 相关常量全部删除；
2. **面板**：`SubagentsPanel` 的轮次上限输入消失（`parseMaxTurns` / 滑块 / 校验全删）；
3. **运行器**：`subagent-runner.ts` 的 `resolveMaxTurns`、`noteSubagentAssistantMessage`
   里的截断分支、`truncated` 状态的产生路径全部消失。

> ⚠️ **`truncated` 状态要不要一起删？** 建议**保留**状态定义但**不再产生**它：
> - `SubagentRunStatus` 里的 `"truncated"` 留着，因为**历史会话**里已经有这个状态
>   （磁盘上的运行记录），删掉会让旧记录读不出来；
> - `report-delivery.ts` 的 `describeOutcome` 保留 `truncated` 分支（同样的理由）；
> - 但**新运行永远不会进入 `truncated`**。
>
> 这是「删字段要向前兼容、删状态要向后兼容」的差别：字段可以硬删（读了也没用），
> 状态必须留着（历史数据里有）。

#### 3.2.1 为什么「守卫」能取代「轮次上限」

用户对原 `maxTurns` 的用途说明是：**「解决子代理异常的问题，比如幻觉导致一直重复」**。
调研发现生态里**四家都实现了专门的重复检测器**，阈值都是 3–6，
而**轮次上限根本不是用来检测异常的**——它太晚、也太钝：

| | 轮次上限（`maxTurns`） | 重复调用守卫 |
| --- | --- | --- |
| 何时发现 | 第 1000 轮 | **第 3 次重复** || 发现什么 | 「跑了很多轮」 | **「在用相同参数做同一件事」** |
| 能说出原因吗 | 不能（只能说「轮次到了」） | 能（工具名 + 次数 + 参数） |
| 给模型机会吗 | 没有（直接中止） | **有**（提醒 → 自纠） |
| 正常任务会误伤吗 | 会（长任务合法地跑很多轮） | 不会（正常任务不会重复同一调用） |

**第 4 行是关键**：轮次上限**必然**在长任务与异常之间做错误取舍 ——
调低了误伤正常长任务，调高了发现异常太晚。守卫没有这个问题，因为它检测的是**行为特征**
（重复），而不是**资源消耗**（轮次）。

**生态里四家的检测器**：

| 项目 | 检测键 | 阈值 | 触发后果 |
| --- | --- | --- | --- |
| **opencode** `doom_loop` | 工具名 + `JSON.stringify(input)`，与紧邻前两次比 | **3** | 抛**权限请求**（默认 `ask`） |
| **Roo Code** `ToolRepetitionDetector` | 工具名 + **稳定序列化**参数，**只与上一次比** | **3** | 拦下 + 问用户 + **计数器归零**（可恢复） |
| **OpenHands** `StuckDetector` | 四种模式（动作+观察 / 动作+错误 / 独白 / A-B 交替） | 4 / 3 / 3 / 6 | 只上报，**不自动中止** |
| **dsh** `repeat-tool-reminder` | 工具名 + 深度键排序参数 | **[3, 5, 8]** | **只提醒**，注入上下文消息 |

**阈值共识**：相邻的同名同参数调用用 **3**（opencode 与 Roo 两个独立项目一致）。
**没有人用 5。**

**四条值得抄的设计**：

1. **只与上一次比**（Roo）：`previousToolCallJson` 一个字段 + 一个计数器，
   **O(1) 内存、不扫历史、不调模型**。
2. **稳定序列化**（Roo 用 `safe-stable-stringify`，dsh 用深度键排序）：
   参数**键顺序无关**，否则 `{a,b}` 与 `{b,a}` 会被当成两次不同的调用。
   Oint 用递归键排序 + `JSON.stringify` 即可，**不引新依赖**。
3. **先劝一次再升级**（OpenHands 的 `get_action_error_nudge()`）：
   恰好等于阈值时先给一次**带具体错误**的纠正提示，严格超过才判 stuck。原文：

   > `You've called <tool> with the same arguments N times in a row and gotten the same
   > error each time: <error>. Repeating the exact same call again will not work — review
   > the error message and either correct the arguments or try a different approach.`

   **「一次瞬时重试不该被惩罚」的取向值得抄。**
4. **触发后计数器归零**（Roo）：让模型有机会恢复，而不是一撞线就永久标记。

**不中止是四家的共同取向**：Roo 拦截+问人、opencode 走权限请求、OpenHands 只上报、
dsh 只提醒 —— **没有一个因为重复就直接杀掉 agent**。

#### 3.2.2 可行性已核实

- 内核有 **`after_tool` 钩子**，事件带 `{ toolCallId, toolName, args, content, details, isError, usage }`
  （`harness/agent-harness.d.ts:564-581`）—— **正是四家检测器用的时机**。
- **Oint 目前只注册了 `before_tool` 一个钩子**（`runtime.ts:2014`），
  **`after_tool` 完全没人用** —— 加进去零冲突。
- 提醒的投递：dsh 用 `additionalContexts`（它自己的机制）。
  Oint 的内核没有它，但有 **`transform_context`** 钩子
  （事件带 `{ messages, systemPrompt }`，返回值可覆盖两者，`agent-harness.d.ts:510-519`）——
  在它里面往 `messages` 尾部追加一条 custom message 即可。
  **这是唯一的适配点。**

#### 3.2.3 建议参数：两档 3 / 5（Cline 式）

最终调研（含 Cline）给出了一个比 dsh 的 `[3, 5, 8]` 更好的形态。
各家阈值：

| 项目 | 常量 | 值 | 默认状态 |
| --- | --- | --- | --- |
| **opencode** | `DOOM_LOOP_THRESHOLD` | **3**（名称 + `JSON.stringify(input)`） | **开**（权限默认 `ask`） |
| **Roo Code** | `consecutiveIdenticalToolCallLimit` | **3**（CLI 10） | **开** |
| **Cline** | `DEFAULT_CONFIG` soft / hard | **3 / 5** | **开**（`loopDetection: false` 可关） |
| **OpenHands** | `action_error` | **3**（3 提醒，4 判 stuck） | **开**（`stuck_detection=True`） |
| **OpenHands** | `action_observation` / `alternating` / `monologue` | 4 / 6 / 3 | 开 |
| **Goose** | `max_repetitions` | 无默认 | **❌ 生产环境是关的**（§3.2.4 坑 1） |

**共识是 3**（四个独立项目一致）；5 只作为 Cline 的**硬阈值**出现。
**没人把 5 当第一触发点。**

→ **建议直接采用 Cline 的两档设计**（soft 3 / hard 5）——
它是**唯一一个「默认开启、且两档齐全」的出货实现**，而且
它对隐藏会话的适配方式（in-band user-role 提醒）正是我们要的：

```
检测键：sha256(排序键后的 {tool, args})          ← 键顺序无关（三家 JS 实现都排序）
算法：只与上一次签名比（Roo 式，O(1) 内存、不扫历史、不调模型）
软阈值 3：注入纠正消息（不中止）—— 对齐 Cline soft / Roo / opencode / OpenHands
硬阈值 5：终止这个子智能体 —— 对齐 Cline hard
作用域：按会话分键（一个 session = 一个 agent）
重置：用户新消息清空；软提醒发出后归零（容一次瞬时重试）
排除名单：todo（整表替换语义会合法地反复调用）
跳过：executed / remote 工具调用（对齐 Cline 的 `event.toolCall.execution` 判断）
```

**为什么子智能体上「注入纠正消息」比「问用户」好**：
Roo 与 opencode 的第一反应都是**问用户**，但**子智能体跑在隐藏会话里，没有人可问**。
Cline 的做法正是为此设计的 —— 软阈值时直接

```ts
this.conversation.appendMessage({ role: "user", content: [{ type: "text", text: verdict.message }] })
```

**追加一条 user 角色消息**，不需要人。这对 Oint 的子智能体是**唯一可用的第一档**，
而且比「直接杀掉」好得多。

**软阈值的消息模板**（OpenHands 的原文，可直接改用）：

> `You've called <tool> with the same arguments N times in a row and gotten the same error
> each time: <error>. Repeating the exact same call again will not work — review the error
> message and either correct the arguments or try a different approach.`

**为什么硬阈值是 5 而不是 8**：第 3 次提醒后如果模型在第 4–5 次仍然
**逐字节相同**地重复，那就不是「瞬时重试」，而是明确的卡死 ——
再给到 8 只是多烧两轮。dsh 的 `[3,5,8]` 第三档收益递减，**砍掉 8**。

> **引用注意（Cline 的一处陷阱）**：`apps/cli/src/runtime/defaults.ts` 里有一句注释说
> 「agent core 默认关掉 loop detection，是 CLI 打开的」——**这句与代码不符**。
> 核心的 `LoopDetectionTracker` 构造时就会填 `{ softThreshold: 3, hardThreshold: 5 }`，
> 只有显式 `loopDetection: false` 才关。**引用行为，不要引用那段注释。**
> （这类「注释与代码不一致」在本仓库也有先例 —— 见 §3.2.4 坑 1 的 Goose。）

**没有任何上限之后的兜底是什么？**
—— **并发 6**（同时最多 6 个）与**用户随时能停**（`TaskStop` / 面板上的停止）。
这两条覆盖「成本失控」；**「单节点跑飞」由守卫的硬阈值覆盖**。
这比原来的 `maxTurns` 组合更贴合实际失败模式。

#### 3.2.4 两个必须避开的坑（来自调研的负面案例）

**坑 1：Goose 的检测器生产环境是「关着」的 —— 这是最值得引以为戒的一条。**

Goose 有 `RepetitionInspector`，签名逻辑与我们要做的完全一致：

```rust
fn matches(&self, other: &InternalToolCall) -> bool {
    self.name == other.name && self.parameters == other.parameters
}
```

**但它的 Agent 是这样构造的**（`crates/goose/src/agents/agent.rs`）：

```rust
tool_inspection_manager.add_inspector(Box::new(RepetitionInspector::new(None)));
```

传 `None` 时检查**直接短路返回 allow**，所以**它永远不会 deny**。
CLI 有 `--max-tool-repetitions` 开关，但它落进 `SessionBuilderConfig.max_tool_repetitions`
后**从未被读取**（`builder.rs` 里该字段只有定义、`Default = None` 和两处测试断言）。

→ **对 Oint 的含义**：**守卫必须有测试证明它真的会触发**，
而不是「代码写了就算」。P0.5 的验收里那几条单测（恰好第 3 / 5 次触发）
就是这个坑的直接防线。**不要只测「不误报」，必须测「真的报」。**

**坑 2：Codex 既没有轮次上限、也没有重复检测 —— 它只有成本守卫。**

调研对 Codex 做了全仓 grep（6 102 个文件找 `repetit|stuck|loop.?detect|no_progress`，
1 142 个找 `max_turns|turn.?limit`，5 253 个 `codex-rs` 文件找轮次相关词）——
**全部无关**。它唯一的runaway 防线是 token 预算（`rollout_budget`）。
最接近的 `circuit_breaker.rs` 数的是**策略拒绝次数**（`MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN: u32 = 3`），
**抓不到「一连串都被允许的相同调用」**。

→ **含义有两面**：
（a）**没有轮次上限是正确的**（OpenAI 也这么发），支持 D3 的删除决定；
（b）**没有重复检测则是一个空缺** —— Codex 靠成本兜底，而 Oint 要在**行为层**兜。
这正是 P0.5 的价值。

#### 3.2.5 落地位置：做在 runtime 的会话级钩子

**对主会话与子会话一视同仁。** 理由：

1. `after_tool` 是**会话级**钩子（在 `createRuntime` 里注册），
   而重复调用**主 Agent 也会发生** —— 没有理由只给子智能体做。
2. 提醒的投递走 `transform_context`，同样是会话级的。
3. 若只做子智能体，要从 `subagent-runner` 反向影响子会话的 harness 钩子 ——
   而 runner 拿不到子会话的 runtime 内部（只有 `getChatRuntime().send`）。
   **技术上做得到但绕远**，收益只是「主会话不受提醒」。

#### 3.2.6 生态对照：轮次上限别人怎么设

| 项目 | 字段 | 默认 | 到限语义 |
| --- | --- | --- | --- |
| opencode | `steps` | **不设 = 不限** | 注入强制总结，只回文字 |
| Claude Code | `maxTurns` | **不设 = 不限** | 输出标记 partial + **可 resume 续跑** |
| Goose | `max_turns` | 1000 | 优雅交还：「Would you like me to continue?」 |
| OpenHands | `max_iteration_per_run` | 500 | **硬错误** `MaxIterationsReached` |
| Codex / Copilot / Aider | **无此字段** | — | 改用 token / 成本预算 |
| **Oint（本版）** | **无此字段** | — | 靠**重复调用守卫** + 并发上限 |

**Oint 现在与 Codex / Copilot / Aider 同类**（不设轮次上限），
但比它们多一个**行为级**的异常检测 —— 而它们用的是成本预算。
**若将来要补成本维度**，参考 Codex 的 `rollout_budget`
（「root thread 与其全部子代理共享的 token 预算」），见 §3.2.6。

**递归深度这条路 Oint 不需要**：生态普遍用 `maxDepth: 1–3` 防递归爆炸
（Claude Code 3、opencode 1、Codex 1、dsh 3），而 Oint 的子智能体
**本来就不能再委派**（`SUBAGENT_ASSIGNABLE_TOOLS` 不含 Task 系列），深度恒为 1。

#### 3.2.7 依然值得抄的一条（P5 观察项）

**整棵子代理树的 token 预算**：Codex 的 `rollout_budget`
（「root thread 与其全部子代理共享的 token 预算」）比任何轮次/次数限制
**退化得更平滑**，而且是**成本维度**的兜底 —— 与守卫（**行为维度**）正好互补。
Oint 已有 token 统计（`session-stats.ts` / `tokenUsage`），具备实现基础。

#### 3.2.8 连带更新的文案与常量

- `tools/subagent.ts:281`：Task 描述里的「最多同时跑 N 个子智能体」（并发 4→6）
- `tools/subagent.ts:565`：并发拒绝文案
- **删除**：`subagent-runner.ts` 的 `resolveMaxTurns`、截断分支、`:262` 注释
- **删除**：`SubagentsPanel.tsx` 的轮次上限输入（`parseMaxTurns` / `:400` / `:404`）
- **删除**：`subagent-catalog.ts` 的 `maxTurns` 解析与序列化
  （`parseSubagentMarkdown` 的 `maxTurns` 键、`serializeSubagentMarkdown` 的那一行、
  `toSubagentInfo` 的 `maxTurns`）
- 旧定义里的 `maxTurns:` 键变成**未知键**：应**忽略而不是报错**
  （用户的 `.md` 定义里可能还留着它，解析失败会让定义整个消失）——
  这是删除字段时**必须**处理的兼容性

#### 3.2.8 并发 6 的连带风险

并发 6 意味着**同一条消息里最多 6 条报告同时回填**
（`deliverSubagentReport`，`runtime.ts:2433`）。每条上限 8000 字符
（`MAX_RESULT_CHARS`），最坏一轮多出 ~48K 字符进上下文。
→ **验收时必须实测**：并发派 6 个 explorer 后，主会话的上下文用量环是否可接受；
若不可接受，调小 `MAX_RESULT_CHARS`，**不要**回调并发。

### 3.3 D6：内置资源在新版本安装时更新到最新

**关键结论：内置子智能体与内置技能走两条不同的路，一条完全免费，一条要设计。**

#### (a) 内置子智能体：**零工作**

它们**写在代码里**（`subagent-catalog.ts` 的 `BUILTIN_SUBAGENTS` 常量），
随应用一起打包。**升级应用 = 自动更新**，磁盘上没有任何副本可以变旧。

#### (b) 内置技能：**随包分发 + 只读 + 用户可覆盖**

```
<appPath>/resources/skills/<name>/SKILL.md      ← 内置，随包分发（只读）
~/.oint/skills/<name>/SKILL.md                  ← 用户全局（可写）
<项目>/.oint/skills/<name>/SKILL.md              ← 项目级（可写）
```

- 内置技能**放在应用目录里**，升级应用时整包替换 → **自动更新**，
  在磁盘上也没有「用户改过的旧副本」需要迁移。
- 用户要定制某个内置技能 → **在数据目录建同名技能**，靠「用户优先」的既有权重覆盖。
- 优先级（**这是新定的顺序，写进 `loadAgentResources`**）：
  **项目 `.oint/skills` → 数据目录 `skills/` → 内置 `resources/skills`**。
  同名先出现者胜，与 `loadSubagentCatalog` 的「用户定义优先于内置」同一条原则。

**为什么不需要 omo 那套 manifest / 暂存机制**：omo 把内置技能**拷贝到用户可写的配置目录**
（`~/.config/opencode/skills/`），于是必须用 `skills-manifest.json` 记录
`managed / customized / deleted / conflict` 四种状态、算目录哈希、把新版本**暂存**到
`skill-updates/<version>/` 等用户裁决。**Oint 的内置技能留在应用目录里，不存在这个问题** ——
不拷贝、不暂存、不做哈希对账。这是架构上实打实的简化，**不要**照抄 omo 的复杂度。

**三处改动**：

1. **`resources.ts` 加 `resolveBuiltinSkillDir()`**，返回 `app.getAppPath()` 下的 `resources/skills`。
2. **`electron-builder.yml` 的 `files:` 必须加 `resources/**/*`** ——
   漏掉的症状是**开发模式一切正常、打包后内置技能为 0**（`app.getAppPath()` 在打包后指向 asar 根）。
3. **`loadAgentResources` 把内置目录放进 `loadSkills` 的目录列表**（`runtime.ts:760`）。

**面板的两处配套**：

- `ipc/skills.ts` 的 `scanSkillDir` 现在硬编码 `source: "user"`（第 35 行留了注释说
  「将来随应用附带内置技能时在这里区分」，就是这一处）→ 要能标出 `source: "builtin"`。
  「系统」页签与两个空态文案（`skillsSystemEmpty` / `skillsSystemEmptyHint`）**已经写好了**，
  填上就能显示。
- **内置技能不可删除**（只能禁用）：`IPC.skills.remove` 现在只允许删数据目录里的技能目录，
  对内置技能应当给出明确报错（照 `subagents` 的「内置子智能体不可删除」）。
  面板上内置行的删除按钮要换成「禁用」。

**`resources/` 不在仓库里，需要新建**。本仓库 `.gitignore` 已忽略 `.oint/`，
与 `resources/` 无关，无需调整。

---

## 4. 子智能体清单：与技能同构的**自动索引**（D7 + D9）

> **先回答「有没有像 skills 清单那样的工具」这个问题 —— 前提需要纠正：**
>
> **技能清单本身不是工具。** 它是**系统提示里的一段索引**，由内核的
> `formatSkillsForSystemPrompt` 生成（`dist/harness/system-prompt.js`），
> 格式是 `<available_skills>` + 每项 `<name>` / `<description>` / `<location>`。
> Oint 在 `buildSystemPrompt` 里把它拼进系统提示（`runtime.ts:717`）。
> **Oint 没有注册任何 skill 工具**（`tools.ts` 里搜不到 skill），
> 模型要读全文就对这个 `<location>` 调 `read`。
>
> 所以「像 skills 清单一样」的准确含义是：
> **在系统提示里放一段自动生成的紧凑索引，两个模式都有，不写进模式的散文里。**
>
> 这正是 D5 要的「自动的目录」—— 而且它比我上一版提的「做进 `Task` 描述」**更简单**
> （见 §4.3 的对比）。

### 4.1 建议：`<available_agents>` 索引

照 `formatSkillsForSystemPrompt` 的形状做一个平行的 `formatSubagentsForSystemPrompt`：

```
The following subagents are available for delegation via the Task tool.

<available_subagents>
  <subagent>
    <name>explorer</name>
    <description>只读的代码库探索：摸清实现位置、调用链与既有约定。</description>
    <tools>read, grep, glob</tools>
    <source>builtin</source>
  </subagent>
  …
</available_subagents>
```

**与技能索引的四点同构**（这是它能被信任的理由）：

| | 技能 | 子智能体 |
| --- | --- | --- |
| 生成函数 | `formatSkillsForSystemPrompt`（内核） | `formatSubagentsForSystemPrompt`（**新写，照抄形状**） |
| 注入点 | `buildSystemPrompt` 的 sections 数组 | **同一个数组**，紧跟技能索引之后 |
| 内容 | 名字 + 描述 + 路径 | 名字 + 描述 + 可用工具 + 来源 |
| 全文怎么拿 | 对 `<location>` 调 `read` | 无需全文（提示词在代码/定义文件里，模型不需要读） |
| 稳定性 | 索引稳定 → 不破坏缓存前缀 | 同理（定义在装配时读一次） |

**两个模式都注入**（这才是 D5 的完整含义：**不写散文，但要有目录**）：

- **standard**：注入索引，**不注入路由规则**（不追加 `buildDelegationPrompt`）。
- **orchestrate**：注入索引 **+ 路由规则**（「何时派 / 何时别派」）。
  路由规则是模式专属的**散文**，索引是共用的**目录** —— 两者职责不同，不要混。

### 4.2 为什么不做成工具（回答「有工具能获取吗」）

做成工具（`list_agents`）**技术上可行**，但对比之后不划算：

| | 系统提示索引（推荐） | 工具（`list_agents`） |
| --- | --- | --- |
| 模型何时知道 | **一开始就知道**，不可能忘 | 得先意识到「我应该查一下」 |
| 往返 | 0 | 每次查 +1 |
| 与现有机制的关系 | **与技能同构**，用户已熟悉 | 新概念 |
| token | 每请求固定（索引很短） | 模型不调则 0，调则一次性 |
| 短任务（高频） | 无额外开销 | **多一次往返是纯开销** |
| `Task` 描述 | 不必再挂清单 | 得两处维护 |

**决定性的一条**：这个清单是**模型每次派发都需要的基础事实**，
而不是「偶尔想查一下」的信息。基础事实应当常驻（像工具 schema、像技能索引），
而不是让模型记得去问。**「得先想起来问」正是不可靠的来源。**

> **不做 `list_agents`。** 若将来实测发现索引太长挤占上下文，再退回工具形态 ——
> 但那时应当先考虑**缩短索引**（只留名字 + 一行描述），而不是换成工具。

### 4.3 这个方案**替掉**了上一版的 `Task` 动态描述

上一版打算改 `buildTools` 的签名（加第 6 个参数 `subagentCatalog`）把清单挂进
`Task` 的描述。**改成系统提示索引之后，那一整块复杂度都不需要了**：

| | 上一版（Task 动态描述） | 本版（系统提示索引） |
| --- | --- | --- |
| `buildTools` 签名 | 要加第 6 个参数 | **不动** |
| 两处调用都要传 | 是（否则 MCP 刷新后清单消失 —— 老坑） | **不存在这个问题** |
| 装配位置 | 工具层（拿不到定义清单） | 系统提示层（**已经拿得到** `loadEnabledSubagents`） |
| 超长截断 | 要自己实现 | 索引天然紧凑 |

**这是纯粹的简化**：`Task` 的描述只留一句「可用的子智能体见系统提示里的清单，
也可以用 `definition` 临时定义」，清单本体交给系统提示。

### 4.4 `Task` 的其余改进

| 改动 | 理由 |
| --- | --- |
| 描述里**删掉**写死的 `BUILTIN_SUBAGENT_ROSTER`（`tools/subagent.ts:255-256`），改成一句指向系统提示索引 | 同一事实不该有两个来源；索引是自动生成的，写死的会漂移 |
| `agent` 参数的示例 `(e.g. "scout")` → `(e.g. "explorer")` | `scout` 不在内置集里（那是初稿打算改的名字） |
| **不改工具名** | `Task` 已在 UI 图标表、权限层、测试与文档里；改名收益远小于成本 |
| **不加 `list_agents`** | 见 §4.2 |

### 4.5 缺口的重新评估

按「模型能不能自己拿到事实」重排（上一版只找到缺口 1，现在它的解法变了）：

| # | 缺口 | 结论 |
| --- | --- | --- |
| **1** | 模型不知道能派谁 | **系统提示索引解决**（§4.1），两个模式都有 |
| **2** | 模型不知道子智能体跑得怎么样 | **假缺口**：`TaskList` 已给状态 / 轮次 / 工具调用数 / 耗时 |
| **3** | 不能 steer 一个跑偏的子级 | 已知，本轮不做（§4.6） |

### 4.6 不做 `send_message`（记录理由）

dsh 有 `send_message` 可以 steer 一个正在跑的子级。Oint 技术上做得到
（`runtime.queue(childSessionId, text, "steer")`），但**本轮不做**：

- 它把子智能体从「一次性委派」变成「可继续会话」，牵动运行记录的终态语义
  （现在是「跑完就是终态」）、`TaskStop` 的语义、以及面板的展示；
- 收益（中途纠偏）与 `TaskStop` + 重派相比并不明显 —— 而后者**已有完整实现与测试**。

→ 列为 P5 观察项。若将来做，参考 dsh 的相邻权限模型
（只有直接 parent 能给直接 child 发消息，且调用只返回「已接受」不返回回复）。

---

## 5. 模式改动（D1 + D5 + D8 + D9）

### 5.1 两个模式

| 模式 | 定位 | 系统提示 | 工具与子智能体能力 |
| --- | --- | --- | --- |
| **standard** | 通用助手：写作、调研、规划、文件处理、编程 | 通用段；**不追加委派段**（D5） | **完整**（D8）：能派内置/用户定义、能用临时定义 |
| **orchestrate** | 只做计划、分派、综合与验收 | 编排段 + **内置子智能体名录与路由阈值**（D9） | **完整**（D8），与标准模式**完全相同** |

**D8 的落实点：模式不改变任何能力。** 具体地说，两个模式下：

- `buildTools(...)` 的调用**完全一样**（含 `subagentTools`）；
- `SUBAGENT_ASSIGNABLE_TOOLS` 不变；
- `Task` 的 `definition` 参数（临时子智能体）**都可用**；
- 唯一的差别是**系统提示里写不写路由段**。

**D5 的落实点：标准模式不追加委派段；名录两个模式都有，走 `<available_subagents>` 索引。**
（原方案是「再加一个 `list_agents` 工具现场查」，§4 论证后改为**不做新工具**；
`Task` 的描述里也**不再抄一份名录**，只指向索引 —— 同一条事实不留第二个来源。）

所以 `tools/subagent.ts` 的改动是：
`BUILTIN_SUBAGENT_ROSTER`（写死的内置清单）→ **装配时生成的完整清单**
（内置 + 用户自定义，超 12 个截断）。详见 §4.3。

**D9 的落实点：编排模式的名录段。** `buildDelegationPrompt`（`runtime.ts:889-922`）
**只在编排模式调用**，内容扩成两块：

- **名录**：七个内置 + 用户定义，每个一行（名字、工具、描述）；
- **路由阈值**：每个内置给「何时派 / 何时别派」两行 —— 这是编排模式的立身之本。

形态（每个专家两行，**负面边界是重点**）：

```
- explorer（只读）：摸清一段实现的位置、调用链与既有约定。
  何时派：要翻很多文件才能得出结论。何时别派：你已经知道文件路径，只是要看内容。
- oracle（只读）：架构取舍、方案对比、两次没修好的疑难、改动前的风险审查。
  何时派：决策代价高、影响面广、或前两次修复都没解决。何时别派：你已经有把握的常规决定。
- designer（可写）：界面与交互的实现、打磨与评审。
  何时派：用户看得见，且「好不好看 / 顺不顺手」有影响。何时别派：纯后端逻辑。
- fixer（可写）：按自包含的规格做多文件改动。
  何时派：规格已经确定、只剩执行。何时别派：还需要探索或设计判断。
- verifier（可写命令）：按验收标准独立复核，给出通过与不通过的证据。
  何时派：一次实现告一段落，需要独立确认。何时别派：只是想知道某条命令的输出。
- test-runner（可写命令）：跑一个具体命令并只汇报失败。
- code-reviewer（只读）：对刚完成的改动做对抗式挑错。
```

**`buildDelegationPrompt` 的改动**：现在它有一个「没有可用子智能体时返回空串」的分支
（`runtime.ts:893`），**保留**（名单为空时列一份空清单只会让模型反复尝试派不存在的子智能体）。

### 5.2 改动清单

**契约层**

| 文件 | 改动 |
| --- | --- |
| `src/shared/contracts/common.ts` | `AGENT_MODES = ["standard","orchestrate"] as const` + `AgentMode`（照 `ALL_THINKING_LEVELS` 的写法） |
| `src/shared/contracts/settings.ts` | `agentMode: AgentMode` |
| `src/shared/contracts/session.ts` | `SessionSummary.mode`、`SessionCreateOptions.mode` |
| `src/shared/contracts/ipc.ts` | `sessions.setMode: "sessions:set-mode"` |
| `src/shared/contracts/api.ts` | `sessions.setMode(id, mode)` |
| `src/shared/contracts/subagent.ts` | **删除** `MAX_SUBAGENT_MAX_TURNS` / `DEFAULT_SUBAGENT_MAX_TURNS` / `SubagentDefinition.maxTurns` / `SubagentRun.maxTurns`；并发常量 → 6（§3.2） |
| `src/main/pisdk/subagent-catalog.ts` | 四个内置重写提示词；新增三个（**定义里不再有 maxTurns**，§2） |
| `src/main/pisdk/tools/subagent.ts` | 描述里删掉写死的 `BUILTIN_SUBAGENT_ROSTER`，改为指向系统提示索引；示例名 `scout`→`explorer`；并发文案。**`buildTools` 签名不动** |
| `src/main/pisdk/subagent-runner.ts` | **删除** `resolveMaxTurns`、`noteSubagentAssistantMessage` 的截断分支、`truncated` 的产生路径（§3.2.7） |
| `src/main/pisdk/repeat-guard.ts` | **新文件**：重复调用守卫（纯逻辑 + 阈值常量，§6 P0.5） |
| `src/shared/contracts/skills.ts` | `SkillSource` 已含 `"builtin"`，**无需改** |
| `src/shared/prompts/agent-modes.ts` | **新文件**：两个模式的策略段 + `{{…}}` 占位符 |

**主进程**

| 文件 | 改动 |
| --- | --- |
| `src/main/settings/store.ts` | `DEFAULT_SETTINGS.agentMode` + `normalizeAgentMode` + `mergeWithDefaults` 显式归一（**两处都要**） |
| `src/main/pisdk/sessions-index.ts` | `SessionIndexEntry.mode` |
| `src/main/pisdk/session-store.ts` | `readMode` / `setMode`（照 `readModel`/`setModel`，545–555 行） |
| `src/main/ipc/sessions.ts` | `sessions:set-mode` 处理器 |
| `src/main/pisdk/runtime.ts` | `resolveSessionMode()`（子会话取父会话）；`buildSystemPrompt` 加 `mode`；`readAgentsMd(cwd)`（§3.1）；**函数式 `systemPrompt`**；`applyMode` 与 `applyModel` 同批；`buildDelegationPrompt` **只在编排模式调用** |
| `src/main/pisdk/subagent-catalog.ts` | 四个内置重写提示词 + 新增三个（§2） |
| `src/main/pisdk/runtime.ts` | 见下方「已含运行时改动」 |
| `src/main/pisdk/permissions.ts` | 无改动（不做新工具）；若将来加工具，记得 `LOW_RISK_TOOLS` |
| `src/main/pisdk/resources.ts` | `resolveBuiltinSkillDir()`（§3.3） |
| `src/main/ipc/skills.ts` | `scanSkillDir` 支持内置来源；内置不可删除 |
| `electron-builder.yml` | `files:` 加 `resources/**/*` |

**渲染层**

| 文件 | 改动 |
| --- | --- |
| `src/renderer/features/chat/Composer.tsx` | `AgentModeChip`（照 `ThinkingChip` 的分段形态）+ 插到 785 行之前（权限 chip 左侧） |
| `src/renderer/stores/chat-store.ts` | `setSessionMode`（照 `setSessionModel`，672–682 行） |
| `src/renderer/features/session/environment-section.tsx` | 环境信息加一行模式（照 `PERMISSION_KEYS` 的 `Record<AgentMode,string>`） |
| `src/renderer/features/settings/panels/PersonalizationPanel.tsx` | 加一句「项目目录里的 AGENTS.md 会与本文件一起生效」 |
| `src/renderer/features/settings/panels/SkillsPanel.tsx` | 内置行隐藏删除按钮（改成禁用） |
| `src/renderer/features/chat/ToolParts.tsx` | 无改动（不做新工具） |

**新增资源**

```
resources/skills/verification-planning/SKILL.md
resources/skills/simplify/SKILL.md
resources/skills/clonedeps/SKILL.md
resources/skills/codemap/SKILL.md          (+ scripts/codemap.mjs)
```

**词条**（`zh-CN.ts` + `en-US.ts` 的 `chat` 段；字段名用 `labelKey`，因为
`check-i18n.mjs:56` 只扫 `labelKey` / `resting` / `active`）

```
chat.agentMode             "Agent 模式"
chat.agentModeStandard     "标准"
chat.agentModeOrchestrate  "编排"
chat.agentModeStandardHint "通用助手：写作、调研、规划、文件处理与编程"
chat.agentModeOrchHint     "只做计划、分派与验收，实现交给子智能体"
chat.agentModePending      "本轮结束后生效"
chat.agentModeCacheNote    "切换会改变请求前缀，本轮请求的提示缓存将失效"
sessionPanel.agentMode     "模式"
settings.agentsMdProject   "项目目录里的 AGENTS.md 会与本文件一起生效"
```

> **词条不需要加 `tools.listAgents`** —— 不做新工具（§4）。

---

## 6. 分阶段实施

### P0 —— 常量 + 内置子智能体 + `<available_subagents>` 索引（D3 + D4 + D7）

不依赖模式骨架，先做完它，模式部分的委派段才有意义。

1. 契约：**删除** `MAX_SUBAGENT_MAX_TURNS` / `DEFAULT_SUBAGENT_MAX_TURNS` /
   `SubagentDefinition.maxTurns` / `SubagentRun.maxTurns`；并发常量 4→**6**（§3.2）。
2. 四个内置：**名字不动**，重写 `prompt` / `description`（§2.1）。
3. 新增三个：`oracle` / `designer` / `verifier`（§2.2）。
4. **新增 `formatSubagentsForSystemPrompt`**（照 `formatSkillsForSystemPrompt` 的形状），
   在 `buildSystemPrompt` 的 sections 数组里**紧跟技能索引之后**注入 ——
   **两个模式都注入**（§4.1）。
5. **清理 `maxTurns` 的全部残留**：运行器的 `resolveMaxTurns` + 截断分支、
   面板的输入框、catalog 的解析/序列化；**旧定义的 `maxTurns:` 键要忽略而不是报错**（§3.2.8）。
6. `Task` 描述：删掉写死的 `BUILTIN_SUBAGENT_ROSTER`，改为指向系统提示索引；
   示例名 `scout`→`explorer`；并发文案（4→6）。
7. 改 `subagent-catalog.test.ts:92-114`（七个名字 / 七个 tools / **删掉 maxTurns 断言**）。
8. `README.md` 的内置集描述（四个 → 七个）。

**验收**：
- 四个门禁全绿；
- 面板「系统」页签列出七个，逐个可禁用；
- **实测并发 6**：一条消息派 6 个 explorer，6 个都起、第 7 个被拒绝且文案是 6；
- **实测索引**：在**标准模式**（系统提示里**没有**委派段）确认
  `<available_subagents>` 里同时列出七个内置**与一个用户自定义定义**
  （先手工在 `~/.oint/subagents/` 建一个）；
- **兼容性**：手工在一个旧定义里留 `maxTurns: 30`，确认它**仍能正常加载**（未知键被忽略）。

### P0.5 —— 重复调用守卫（D3 的唯一异常防线）

> **建议新增的阶段**。它不依赖模式骨架，而且是**取代 `maxTurns` 的那个机制**
> —— 删掉轮次上限之后，它是子智能体唯一的异常防线。
> 设计与阈值见 §3.2.1–§3.2.4。

9. **新建 `src/main/pisdk/repeat-guard.ts`**（纯逻辑，便于单测）：
   - `repeatKey(toolName, args)`：**递归键排序后** `JSON.stringify`（**键顺序无关**）；
   - 链状态：`{ lastKey: string | null; count: number }`，**只与上一次比**（Roo 式，O(1) 内存）；
   - 阈值常量 `REPEAT_SOFT_THRESHOLD = 3` / `REPEAT_HARD_THRESHOLD = 5`（Cline 式两档）；
   - `EXCLUDED_TOOLS = new Set(["todo"])`（整表替换会合法地反复调用）；
   - 产出：`{ level: "soft" | "hard", count, toolName, argsText } | null`。
10. **`runtime.ts` 注册 `after_tool` 钩子**（此前只有 `before_tool`）：
    - **soft（3）** → 把纠正消息**暂存到 runtime 的待注入槽**；
    - **hard（5）** → 先 `noteSubagentRunEnd(status: "failed", error: 原因)` 把终态定下来，
      再 `void stop(sessionId)` 终止运行（**顺序不能反**：`finish` 是先到者为准的幂等操作，
      先落终态才能让运行记录显示「检测到重复调用」而不是笼统的「已停止」）。
11. **`runtime.ts` 注册 `transform_context` 钩子**：把待注入的纠正消息作为
    **custom 消息**追加到 `messages` 尾部，然后清空槽位。
    （内核**没有** dsh 的 `additionalContexts`，这是唯一的适配点。
    用 custom 而不是普通 user 消息：内核的 `convertToLlm` 把它转成 user 角色
    （模型看得见，对齐 Cline 的 `appendMessage({ role: "user", ... })`），
    而 **message-mapper 忽略 custom 条目** —— 所以它不会出现在用户的对话流里。
    它是给模型的自纠提示，不该伪装成用户发言。）
12. **清零点：用户新消息时**（`sendLocked` 入口与 `queue` 入口）。

    > ⚠️ **与初稿的偏差**：初稿写的是「soft 提醒发出后归零（Roo 式）」。
    > 实现时发现那样**硬档永远到不了** —— 归零后要再攒 3 次才 soft、再 2 次才 hard，
    > 而每次 soft 都清一次，计数永远在 0–3 之间循环。
    > 所以**软档之后继续计数**（`softReported` 标志保证只说一次），到 5 才硬档。
    > 「容一次瞬时重试」这个意图由**软档本身不阻断**来满足，不需要清计数。
13. 若连续调用**都失败**，soft 的提醒附上错误摘要（OpenHands 的 nudge 式，
    §3.2.3 给了原文）。
14. **跳过 executed / remote 工具调用**：**不适用** —— Oint 的 `after_tool` 事件里
    没有 Cline 那个 `execution` 标志（工具执行路径是单一的），所以这一条实现为「不做」。

**验收**：
- 单测：构造「同一调用连续 N 次」的序列，断言**恰好**第 3 次产出 soft、
  第 5 次产出 hard、第 4 次**不产出**；
- 单测：参数键顺序不同（`{a,b}` vs `{b,a}`）**算同一次**（**这条最关键** ——
  不排序的话检测器会静默永不触发）；
- 单测：穿插 `todo` **不打断链**（`grep X → todo → grep X` 算连续两次）；
- 单测：换了工具名或参数就**归零**；用户新消息归零（**软档后不清零**，见步骤 12 的偏差说明）；
- 单测（**接线层**，`runtime.send.test.ts`）：三个钩子都挂上了；
  连续 3 次相同调用后纠正消息**真的进了** `transform_context` 的返回里
  （custom 角色、槽位只注入一次、第 3 次之前什么都不返回）；
  硬档确实把运行停了；用户新消息后同样的调用要重新数 3 次；穿插 todo 不打断链。
  > 这一组是**刻意**与纯逻辑测试分开的：`repeat-guard.test.ts` 测阈值与键排序，
  > 而「它有没有被接上」是另一回事 —— 后者不会报错，且本仓真实发生过
  >（系统提示算出来没传给内核，见 §0）。
- **实测**（需真机）：让一个子智能体陷入重复（例如要求它读一个不存在的文件并反复重试），
  观察第 3 次是否有纠正消息、第 5 次是否被终止；
- **回归**：soft **不阻断**调用（对齐四家的「先提醒」共识），
  hard 才终止；两者都不影响现有的 `before_tool` 权限门。

### P1 —— AGENTS.md 两层（D2）

14. `readAgentsMd(cwd)` + 两段注入 + 同路径去重。
15. `PersonalizationPanel` 加说明文案。

**验收**：只写全局 / 只写项目 / 两者都写，三种组合注入正确且**全局在前**；
`OINT_HOME` = cwd 时只注入一次；项目文件不存在时不报错也不出现空段；
现有断言「AGENTS.md 不可读时仍返回可用提示（不抛错）」仍通过。

### P2 —— 内置技能通道 + 前两个技能（D6）

16. `resolveBuiltinSkillDir()` + `loadAgentResources` 三源合并 + `electron-builder.yml`。
17. `ipc/skills.ts` 标 `builtin` + 内置不可删除；`SkillsPanel` 内置行去掉删除按钮。
18. 收 `verification-planning` 与 `simplify`（改造成本最低的两个）。

**验收**：
- 设置里「系统」页签列出两个技能（此前一直是空态）；
- 禁用后系统提示里不再出现；
- **同名用户技能覆盖内置**（在 `~/.oint/skills/` 建同名，确认生效的是用户的）；
- **打包后的应用里同样能看到**（`npm run pack` 后启动确认，这是 `resources/**` 是否进包的唯一验证）。

### P3 —— 模式骨架 + 通用标准模式

19. 契约：`AgentMode` + `Settings.agentMode` + 会话级 `mode` + 存储归一 + `sessions:set-mode`。
20. `shared/prompts/agent-modes.ts`：填标准段。
21. `buildSystemPrompt` 加 `mode`；runtime 用函数式 `systemPrompt` 接上。
22. `AgentModeChip` + 词条 + `Composer` 插入 + `Composer.mode.test.tsx`。
23. 环境信息面板加一行。

**验收**：切模式后下一轮系统提示确实换了；重启后会话模式还在；四个门禁全绿。

**必须同批改的一条现有断言**：`runtime.test.ts:56` 的 `toContain("工作规则")`
→ 改为 `toContain("怎么工作")`。**其余四条断言靠保留子串满足**
（`{{cwd}}` / 「使用…回复用户」/「工具使用：」/「grep / glob」/「todo」），
已用脚本逐条核对过（见 `docs/agent-mode-switching.md` §5.1 的表格）。

### P4 —— 编排模式（D9）

24. 编排段提示词 + **只在编排模式下**调用 `buildDelegationPrompt`（名录 + 路由阈值）。

**验收（功能）**：
- 编排模式下系统提示里出现委派段（`## 委派（子智能体）`），含「何时派 / 何时别派 / 派完怎么收敛」；
  > **名录不在这段里** —— 它在两个模式共用的 `<available_subagents>` 索引里（§4.1）。
  > 两段刻意分工：索引是**目录**，委派段是**策略**，同一条事实不写两遍。
- **标准模式下系统提示里没有委派段**，但模型仍能派 —— 靠系统提示里的
  `<available_subagents>` 索引（内置与用户自定义都在里面）+ `Task` 工具自己的说明；
- 两个模式下 `Task` 的 `definition`（临时子智能体）都能用（D8：能力完全相同）。

**验收（值不值得做）** —— 三条都不成立就砍掉编排模式、把路由表并进标准模式的委派段：

1. 给一个多步任务，编排模式是否**先派发**而不是先自己改文件？
2. `oracle` / `designer` / `verifier` 是否在**该派的场景**被派出去，且没有明显滥用？
3. 收到「改完了」的报告后，是否**读了一遍被改的文件**再下结论？

### P5 —— 观察项（不做，仅记录）

- **整棵子代理树的共享 token 预算**：Codex 的 `rollout_budget`
  （「root thread 与其全部子代理共享的 token 预算」）是直接先例，
  也是**成本维度**的兜底 —— 与守卫（**行为维度**）正好互补。
  Oint 已有 token 统计，具备实现基础。
- **重复检测的加强**（P0.5 的延伸）：
  - **近似变体**（`src/a.ts` → `./src/a.ts`）目前绕过检测
    （四家也都只做精确匹配，这是可以的）；
  - **动作+观察 / 交替模式**：OpenHands 还检测「同动作+同观察」4 次、
    「A/B 交替」6 次、「独白」3 次。Oint 现在只做「同名同参数」，
    若不奏效可加这几档；
  - **跨 compaction 的链**：dsh 明确「compaction 不会重置链」，Oint 应确认同样行为是否合适；
  - **误报逃生口**：Roo 提供 `0 = 不限` 的设置、Cline 提供
    `loopDetection: false`。Oint 若收到误报投诉，应当有同样的开关
    （**但默认开启** —— 参照 Goose 的教训，默认关掉的守卫等于没有）。
- **`send_message`**（§4.6）：steer 一个正在跑的子级。
- **`list_agents` 式工具**：若实测发现系统提示索引不够
  （例如索引太长挤占上下文），可以退回工具形态 —— 但那时应**先考虑缩短索引**。
- `clonedeps` / `codemap` 两个技能（要处理 `.slim/` → `.oint/`、脚本路径、注册步骤）。
- 「严格编排」工具档位（D1 已定默认不限制）。
- `librarian` / `observer`（需要浏览器子系统的「隐藏标签」改造与按图路由）、
  `council`（需要新的调度形态）。

---

## 7. 风险与注意

| # | 风险 | 处置 |
| --- | --- | --- |
| 1 | **`resources/` 打包遗漏** | `electron-builder.yml` 的 `files:` 必须加 `resources/**/*`；漏掉的症状是**开发正常、打包后内置技能为 0**。P2 验收里必须真跑一次 `npm run pack` |
| 2 | **内置技能被误删** | `IPC.skills.remove` 只允许删数据目录里的技能目录；内置的必须明确报错，面板隐藏删除按钮（照 `subagents` 的「内置不可删除」，`ipc/subagents.ts:82-84`） |
| 3 | **并发 6 让一轮上下文暴涨** | 最坏 6×8000 字符 ≈ 48K。验收时实测上下文用量环；超标就调小 `MAX_RESULT_CHARS`，**不要**回调并发 |
| 4 | **守卫写了但永不触发** | **这是调研里最值得引以为戒的一条**：Goose 的 `RepetitionInspector` 代码完全正确，但生产环境用 `RepetitionInspector::new(None)` 构造，**检查直接短路返回 allow**，而 CLI 的 `--max-tool-repetitions` 落进配置后**从未被读取**（§3.2.4 坑 1）。→ **P0.5 的验收必须包含「证明它真的会触发」**，而不只是「不误报」 |
| 5 | **参数不排序 → 检测器静默失效** | 三家 JS 实现都做键排序。`{a,b}` 与 `{b,a}` 不排序就是两次「不同」的调用，**检测器永远不触发且没有任何报错**。单测必须覆盖这一条 |
| 6 | **`after_tool` 与 `before_tool` 的返回值不能互相覆盖** | 两者是**不同的钩子**，各自独立注册（`runtime.ts:2014` 现在只有 `before_tool`）。soft **绝不阻断**调用 —— 这是四家的共识，也是硬阈值存在的理由 |
| 7 | **纠正消息的投递路径要确认** | 内核**没有** dsh 的 `additionalContexts`。必须用 `transform_context` 往 `messages` 追加 **user 角色**的 custom message（对齐 Cline）。**实现前先写一个最小验证**：确认它真的进了下一次请求 |
| 8 | **`buildTools` 第 6 个参数漏传一处** | **已不存在** —— §4 改为系统提示索引后 `buildTools` 签名不动。这条留给将来的类似改动做提醒 |
| 9 | **AGENTS.md 两层重复注入** | 路径 `resolve` 后相等则只读一次；两段用不同标题以便用户与测试区分 |
| 10 | **现有测试断言旧提示词** | 只有 `runtime.test.ts:56` 一条必须改；其余靠保留子串。**不要**为省一行测试把新提示砍回旧形状 |
| 11 | **`subagent-catalog.test.ts` 的断言会真红** | `:93-107` 是新旧内置集的逐项断言，**必须同批改**（七个名字、七个 `tools`、**删掉 maxTurns 断言**） |
| 12 | **改完 README / docs 漏改** | `README.md`（内置集 + 并发数）与 `docs/agent-mode-switching.md`（§3 子智能体规划）都要更新；`docs/agent-tools-and-upgrade-guide.md` **已确认无旧名** |
| 13 | **模式切换破坏前缀缓存** | 只在用户显式切换时一次性发生；chip 弹层里说明一句 |
| 14 | **oh-my-opencode-slim 的 `maxTurns` 未能核实** | 调研中该仓库路径全部 404、jsDelivr 因包体 >50 MB 拒绝。**凡引用它 `maxTurns` 的说法都不可信**；本文的轮次结论来自可核实来源（opencode / Claude Code / Goose / OpenHands / Codex） |

**明确不做**：计划模式（含写入门禁）、按模式换工具目录、
按模式限制子智能体能力（D8 明确所有主 Agent 能力一致）、
模型自行切换模式、`PersonalizationPanel` 的项目级 AGENTS.md 编辑器。

---

## 8. 验收总表

| 阶段 | 命令 / 动作 | 通过标准 |
| --- | --- | --- |
| 全部 | `npm run typecheck` | 无错 |
| 全部 | `npm run test` | 全绿（含 §2.3 改过的 catalog 断言） |
| 全部 | `npm run check:i18n` | 0 缺失键 |
| 全部 | `npm run check:unwired` | 退出码 0 |
| P0 | 一条消息派 6 个 explorer | 6 个都起、第 7 个被拒绝且文案是 6 |
| P0 | `<available_subagents>` 索引（标准模式下） | 同时列出 7 个内置与用户自定义 |
| P0 | 旧定义里留 `maxTurns: 30` | **仍能正常加载**（未知键被忽略，定义不消失） |
| P0 | 设置面板「系统」页签 | 列出七个内置子智能体 |
| **P0.5** | 单测：连续重复调用 | 恰好第 **3** 次 soft、第 **5** 次 hard、第 4 次不产出 |
| **P0.5** | 单测：**参数键顺序** | `{a,b}` 与 `{b,a}` 算同一次（**最关键**：不排序则永不触发） |
| **P0.5** | 单测：穿插 `todo` / 换参数 / 新消息 | 穿插不打断链；换参数与新消息归零 |
| **P0.5** | **接线层**：消息真的进了上下文 | `after_tool` → 暂存 → `transform_context` 注入 custom 消息（只注入一次） |
| **P0.5** | 实测：子智能体陷入重复 | 第 3 次有纠正消息（**不阻断**）、第 5 次被终止 |
| **P0.5** | **负向验证** | 确认守卫**真的会触发**（参照 Goose 的 disarm 教训，§3.2.4 坑 1） |
| P1 | 三组 AGENTS.md 组合 | 全局 / 项目 / 两者，注入正确且**全局在前** |
| P1 | `OINT_HOME` = cwd | 只注入一次 |
| P2 | 设置「系统」页签（技能） | 列出两个内置技能（此前是空态） |
| P2 | 同名用户技能覆盖内置 | 生效的是用户的 |
| P2 | `npm run pack` 后启动 | 内置技能仍在（`resources/**` 进包） |
| P3 | 切换模式后发一条消息 | 系统提示确实换了 |
| P3 | 重启应用 | 会话模式仍在 |
| P4 | 两个模式下的系统提示 | 编排有委派段（含路由阈值）、标准没有 |
| P4 | 两个模式下派临时子智能体 | 都能用（D8） |
| P4 | 三条「值不值得做」验收 | 见 §6 的 P4 |

---

## 附：与 `docs/agent-mode-switching.md` 的关系

那份是**调研报告**，本文件是**计划**。报告已同步的部分与仍需注意的部分：

1. 报告的 §3「编排模式：子智能体规划」**已同步**为「保留四个名字 + 新增三个」，
   并在 §3.2 末尾留了「决定变更记录」，说明 `scout` / `reviewer` / `builder` / `runner`
   那套改名计划作废的原因。
2. 报告的 §3.2 / §3.3 里 `oracle` 的 `maxTurns: 60`、`designer: 120`、`verifier: 90`
   **全部作废** —— 本计划最终**删除了 `maxTurns` 字段**（§3.2）。
   改报告时以本计划为准。
3. 报告的 §4 技能复刻优先级里 `explorer` / `test-runner` 的引用**不用改**（名字保留）。
4. **报告里没有**、本计划新增的四块，将来若整理报告需要补进去：
   - **重复调用守卫**（§3.2.1–§3.2.4）—— 六家的检测器调研（opencode / Roo / Cline /
     OpenHands / Goose / Codex），含 Goose 的「检测器被 disarm」负面案例；
   - **`<available_subagents>` 系统提示索引**取代独立的 `list_agents` 工具（§4）；
   - **`maxTurns` 的整体删除**（D3）；
   - **`Task` 描述里删掉写死的 roster**，改为指向索引。

**改报告时以本文件为准**，因为决定是在报告写完之后才拍板的。
