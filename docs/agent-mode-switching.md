# Agent 模式切换 · 两模式方案（标准 / 编排）

> **本轮范围：只做两个模式。**
> `标准` 是**通用**助手（不只服务编程）；`编排` 尽量复刻
> [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) 的技能与子智能体体系，
> 并参考 [oh-my-pi](https://github.com/can1357/oh-my-pi) 等同代 harness。
>
> | 项目 | 来源 | 锚点 |
> | --- | --- | --- |
> | **Oint**（本仓库） | 本地 | `cfb4960`，内核 `@earendil-works/pi-agent-core@0.85.1` |
> | **oh-my-opencode-slim**（下称 omo） | `alvinunreal/oh-my-opencode-slim` | `master`（源码直读） |
> | **oh-my-pi**（下称 omp） | `can1357/oh-my-pi` | `main`（官方 README + docs 直读） |
> | **Roo Code** | `RooCodeInc/Roo-Code` | `main`（源码直读） |
> | **Kilo Code** | `Kilo-Org/kilocode` | `main`（官方文档） |
> | 旁证 | dsh、opencode、codex、Claude Code、Cursor、Amp | 不作决策依据 |
>
> 与既有文档的分工：`agent-tools-and-upgrade-guide.md` 管**工具面**，
> `persistent-terminal-jobs-and-ask-user.md` 管**长任务与交互**；本文只回答两件事 ——
> **通用标准模式的提示词怎么写**、**编排模式要复刻哪些技能与子智能体、怎么落地**。
>
> 方法：omo 与 Roo 读源码与 SKILL.md 原文；omp 读官方 README 与 docs；
> Oint 读本仓库与 `node_modules/@earendil-works/pi-agent-core/dist/`。
> 引用一律给 `文件:行号` 或符号名（行号以调研时点为准，检索以符号名为准）。

---

## 0. 摘要

**四句话**

1. **「标准模式」的难点不是写提示词，而是把「编程助手」的语言换成「通用助手」的语言。**
   当前 `buildSystemPrompt` 第一句就是「你是 Oint 桌面应用中的智能编程助手」，
   `TOOL_GUIDANCE` 六条全部围绕改代码。通用模式要把身份、工作方式、工具指导三层都重写，
   且**不能只是把「编程」两个字删掉** —— 通用助手需要显式的「先判断这是什么类型的任务」这一步。

2. **「编排模式」在 omo 里不是一个模式，是一整套可复刻的资产**：
   7 个子智能体 + 8 个技能 + 一张写进主提示的路由表。
   其中**技能是最容易复刻、收益最高的一块**，因为 Oint 的技能链路**已经完整接线**
   （扫描 → 索引注入 → 按需读取 → 斜杠菜单 → 设置面板），而 omo 的 SKILL.md
   全部是纯 markdown、frontmatter 只有 `name` + `description` 两个键，
   **与 Oint 内核的技能契约完全兼容**。

3. **编排模式要不要做、要不要限制工具，是本轮分歧最大的一个问题。**
   三家的做法互不相同，且理由都已从官方文档核实：
   Roo 保留它但给 **`groups: []`（零工具）**，官方理由写得很直白 ——
   「给它读文件的能力会让上下文塞满文件读取，妨碍它保持专注」（上下文毒化）；
   omo 不给工具限制，改用提示词与路由表；
   **而 Kilo 把这个模式整个废弃了**：「全工具的 Code/Plan/Debug 已原生支持 subagent，
   不再需要专门的 orchestrator」。Goose 也移除了 `/plan`。
   → 本文建议：**默认不限制工具**（提示层编排），并给出**判断标准** ——
   若说不出编排模式比「标准模式 + 子智能体」多给了什么，就该采纳 Kilo 的结论、不做它（§6.3）。

4. **Oint 现有的技能面板已经有「系统 / 用户」两个页签和空态文案**
   （`settings.skillsSystemEmpty`：「还没有内置技能」/「随应用提供的技能会显示在这里」），
   `SkillSource` 类型里 `"builtin"` 已经存在，`ipc/skills.ts:35` 也留了一句
   「将来随应用附带内置技能时在这里区分」。**内置技能这个位置是留好的，只是还没填。**

**结论（建议）**

| 模式 | 定位 | 系统提示 | 工具 | 新增技能 | 新增子智能体 |
| --- | --- | --- | --- | --- | --- |
| **标准** | 通用助手：写作、研究、规划、文件处理、编程都是它的工作 | 通用段（§5.1） | 不变 | 无 | 无 |
| **编排** | 主代理只做计划、分派、综合与验收 | 编排者段 + 路由表（§5.2） | **默认不变**（可选严格档） | 4 个内置（§4） | 3 个内置（§3） |

**本轮明确不做**：计划模式（写入门禁）、按模式换工具目录、模型自行切换模式。
上一版报告里的计划模式设计**不再保留**（本文是重写版）。

---

## 1. 两条必须先讲清的约束（源码核验）

这两条会直接否掉一些看起来更优雅的设计，所以放最前面。

### 1.1 Oint 的内核**没有** `sections` API —— 模式切换只能整段换提示

omp 的调研里提到 pi-mono 支持「命名段落替换」：

```
agent.prompt([{ role: "system", content: "", sections: { skills: "<skills>...</skills>" } }])
```

**但这不是 Oint 的内核。** 在 `@earendil-works/pi-agent-core@0.85.1` 的 `dist/` 里
逐文件检索 `sections`，只命中 `utils.js` 里一个与提示词无关的局部变量；
`AgentMessage` 也没有 system/sections 这种形态
（`dist/types.d.ts` 只在 291–292、363–364 两处声明了 `systemPrompt: string`）。

> 这是**版本差异**，不是文档错误：`sections` 属于更新的 pi-mono。Oint 锁在 0.85.1，
> 因此不能依赖它。**若将来升级内核，这一节要重新评估** —— 命名段落替换会比整段替换更省 token。

**结论**：Oint 侧改系统提示只有两条路 ——
(a) `AgentHarness.create` 时传 `systemPrompt`（**可以是函数**，见 §2.2）；
(b) 用 `transform_context` 钩子（`harness/hooks.js`，事件带 `{ messages, systemPrompt }`，
返回值可覆盖两者）。**本文方案用 (a)**，理由见 §2.2。

### 1.2 `AGENTS.md` 只从数据目录读，**不从工作目录读**

`buildSystemPrompt` 读的是 `path.join(dataDir(), "AGENTS.md")`（`runtime.ts:721`），
**不是** `<cwd>/AGENTS.md`。

这一条直接影响技能移植：omo 的 `codemap` 与 `clonedeps` 都靠
「在项目根 `AGENTS.md` 里追加一节」让后续会话自动发现产物。
**在 Oint 里这条路走不通** —— 写进 `<cwd>/AGENTS.md` 不会被注入。

→ 移植时改成「把索引写进技能自己的状态文件」（本文方案，零改造），
或把「项目级 AGENTS.md」列为独立改动（§7 的 P0-6）。

---

## 2. Oint 现状：能直接用的与必须先改的

### 2.1 技能链路**已经完整接线**（最大的有利条件）

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 目录解析（数据目录 + 项目 `.oint/skills`） | `resources.ts` 的 `resolveSkillDirs` | ✅ |
| 扫描 + frontmatter 解析 | 内核 `loadSkills`（`dist/harness/skills.js`） | ✅ |
| 禁用过滤 | `runtime.ts:767`（`disabledSkillNames`） | ✅ |
| **索引注入系统提示** | `runtime.ts:787` `formatSkillsForSystemPrompt(skills)` | ✅ |
| 按需读取全文 | 索引里给 `<location>`，模型用 `read` 取 | ✅ |
| 斜杠菜单调用 | `slash-commands.ts` + `use-slash-commands.ts` | ✅ |
| 设置面板列表 / 启停 / 导入 / 删除 | `ipc/skills.ts` + `SkillsPanel.tsx` | ✅ |
| **内置技能来源** | `SkillSource` 有 `"builtin"`；面板有「系统」页签与空态文案 | ⚠️ **类型与 UI 就位，装配未实现** |

内核的索引格式（`dist/harness/system-prompt.js`，逐字）：

```
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>…</name>
    <description>…</description>
    <location>…</location>
  </skill>
</available_skills>
```

内核的技能 frontmatter 契约（`dist/harness/skills.js` 的 `loadSkillFromFile`）：
只认 **`name`**、**`description`**（**必填，缺失则整个技能被静默丢弃**）、
**`disable-model-invocation`**（true 时 `formatSkillsForSystemPrompt` 会滤掉它）。
`name` 缺省时取**父目录名**。

**这与 omo 的 frontmatter 完全兼容** —— omo 全部 9 个 SKILL.md 都只有
`name` + `description` 两个键，没有 `allowed-tools`、`version`、`model` 之类。
→ **移植 omo 技能几乎是零改造成本**。

### 2.2 系统提示怎么改：用**函数式** `systemPrompt`

内核签名（`harness/agent-harness.d.ts:625`）：

```ts
systemPrompt?: string | ((toolContext: TContext, context: Context) => string | Promise<string>);
```

求值时机在**每次模型请求前**（`harness/runtime/drive/generation.js` 的
`resolveSystemPrompt` → `prepareGeneration`），**不是只在创建时**。

因此模式切换可以做到：**不重建 harness、不动 lane 配置、不动工具表**，
只是下一次请求拿到不同的提示文本。与现有 `applyModel` / `applyThinkingLevel`
（`runtime.ts:2110` / `:2165`）完全同一个套路 —— 在 `sendLocked` 的
「按当前设置对齐」那一段（`runtime.ts:2229-2233`）读一次模式即可。

**代价必须如实说**：切换模式会改变请求前缀，从而失去供应商侧的前缀缓存复用
（**一次性成本**，不是每轮成本）。dsh 在它的 plan-mode README 里专门声明过同一条。
UI 上要在 chip 弹层里说一句。

### 2.3 子智能体链路完备，但**子会话 cwd 写死继承父会话**

- `SubagentDefinition` 形状（`shared/contracts/subagent.ts:78-94`）：
  `name` / `description` / `prompt` / `tools` / `model?` / `thinkingLevel?` / `maxTurns?` / `source`。
- 内置预设写在 `subagent-catalog.ts` 的 `BUILTIN_SUBAGENTS`（现有 4 个：
  explorer / code-reviewer / fixer / test-runner）；用户定义从
  `${dataDir}/subagents/*.md` 与 `<cwd>/.oint/subagents/*.md` 读，**同名用户定义优先**。
- **并发上限 4**（`MAX_CONCURRENT_SUBAGENT_RUNS`），`maxTurns` 上限 80，定义总数上限 16。
- **cwd 不可覆盖**：`subagent-runner.ts:331` 写死 `cwd: parent.cwd`；
  `SubagentStartRequest`（`tools/subagent.ts:102-109`）里**没有** cwd 字段。

→ 这一条决定了 **`worktrees` 技能不能移植**（它要求把所有子智能体的 cwd 钉在 worktree 路径）。详见 §4.3。

---

## 3. 编排模式：子智能体规划

### 3.1 omo 的 7 个专家 vs Oint 现有的 4 个

| omo 专家 | 定位（原文） | 权限 | Oint 现状 | 建议 |
| --- | --- | --- | --- | --- |
| orchestrator | 「You are a **workflow manager** … You are **not the default implementation worker**」 | 读+写+task | ❌ 无 | → **就是编排模式本身**，不做成子智能体 |
| explorer | 「fast codebase navigation specialist」 | 只读 | ✅ 有 `explorer` | **保留名字**，改提示词（D4） |
| oracle | 「strategic technical advisor」；「**You advise, you don't implement**」 | 只读 | ❌ 无 | **新增** |
| librarian | 「research specialist for codebases and documentation」（context7 + gh_grep） | 只读 | ❌ 无 | **不做**（§3.3） |
| designer | 「frontend UI/UX specialist」 | 读+写 | ❌ 无 | **新增** |
| fixer | 「fast, focused implementation specialist」 | 读+写 | ✅ 有 `fixer` | **保留名字**，改提示词（D4） |
| council | 「multi-LLM consensus」；**零工具** | 全 deny | ❌ 无 | **不做**（§3.3） |
| observer | 「visual analysis specialist」 | 只读 | ❌ 无 | **不做**（§3.3） |

**最终内置集 = 7 个**：保留 `explorer` / `code-reviewer` / `fixer` / `test-runner`
（名字不动，只改提示词与 `maxTurns`）+ 新增 `oracle` / `designer` / `verifier`。

### 3.2 建议新增的三个

三个都落在既有的 `SUBAGENT_ASSIGNABLE_TOOLS`
（`read` / `grep` / `glob` / `bash` / `edit` / `write` / `todo`，`subagent.ts:32-40`）之内，
**不引入新的权限面**。

#### (1) `oracle` —— 参谋（只读）

- **工具**：`read` / `grep` / `glob`；`maxTurns: 60`。
- **为什么不能复用 `code-reviewer`**：`code-reviewer` 的提示词是**对抗式挑错**
  （「你的立场是挑错而不是肯定：先假设这段代码有缺陷…」），针对**已完成的改动**；
  oracle 回答的是**还没做的决策**（架构取舍、方案对比、两次没修好的疑难）。
  omo 分成两个 agent，正是因为提示词的**姿态**完全不同。
- **提示词要点**（逐条对齐 omo `oracle.ts`）：
  「You advise, you don't implement」/「Be direct and concise」/
  「Acknowledge uncertainty when present」/
  **「Prefer simpler designs unless complexity clearly earns its keep」**（YAGNI 约束）/
  「Point to specific files/lines when relevant」。
- **路由条件**：决策代价高、影响面广、或**前两次修复都没解决**。
  **必须同时写「何时别派」**：你已经有把握的常规决定。

#### (2) `designer` —— 界面（可写）

- **工具**：`read` / `grep` / `glob` / `edit` / `write`；`maxTurns: 120`。
- **为什么需要**：Oint 是桌面 UI 项目，而现有四个子智能体**没有一个负责「好不好看」**。
  `fixer` 的提示词明确是「照规格做、不要顺手扩大范围」，正好把设计判断排除在外。
- **提示词要点**（对齐 omo `designer.ts`）：一组设计原则（字体 / 配色 / 动效 / 空间 / 层次）
  + 「Respect existing design systems when present」
  + 「Use grounded, normal, regular english」
  （omo 把「文案弱」写成它的已知短板，并让 orchestrator 事后审文案）。
- **对 Oint 的本地化**（omo 没有、但本仓库每处 UI 都在遵守的一条）：
  **「沿用 `src/index.css` 的设计令牌与 `components/assistant-ui/` 的既有形状，
  不要引入新的颜色 / 圆角 / 字号」** —— 与 `README.md` 设计章节一致
  （「令牌集中在 src/index.css，字号角色在 type.ts」）。

#### (3) `verifier` —— 验收（可写命令）

- **工具**：`read` / `grep` / `glob` / `bash`；`maxTurns: 90`。
- **为什么不能复用 `test-runner`**：`test-runner` 是「跑**主代理指定的**那条命令，如实汇报」；
  verifier 要**先读验收标准、自己决定跑什么**，并在结论里区分
  「已验证 / 未验证 / 无法验证」。这是 `code-reviewer`（读代码）与 `test-runner`（跑命令）
  之间的空缺。
- **提示词要点**：移植 omo 的 `verification-planning` 骨架（§4.1）+ 三条硬要求：
  结论三分（established / limited / refuted）、每条结论附证据、
  **不许为了让命令通过而放宽断言或跳过用例**（这条与现有 `test-runner` 同源，措辞保持一致）。

> **决定变更记录（D4）**：本节早先版本写的是「删掉现有四个内置、换成
> `scout` / `reviewer` / `builder` / `runner` 这套新名字」。**该计划已作废** ——
> 用户判定现有四个名字（`explorer` / `code-reviewer` / `fixer` / `test-runner`）已然清晰明了，
> **不需要改名，只改提示词等信息**。因此实际方案是「**保留四个名字 + 新增上面三个**」，
> 详见 `docs/agent-mode-switching-plan.md` §2。这一变更消掉了原本要改 12 个测试文件的夹具工作。
>
> **另一处变更（轮次上限）**：上面写的 `maxTurns: 60 / 120 / 90` 也已被推翻。
> 用户明确该上限的用途是**「解决子代理异常（幻觉导致一直重复）」**，
> 即**异常兜底而非预算**；最终决定是**七个内置一个都不写 `maxTurns`**，
> 由默认值 **1000** 兜底，并**新增「重复调用提醒」作为第一道防线**
> （见计划 §3.2.1–§3.2.5）。

### 3.3 明确**不做**的三个（连同理由）

| 候选 | 为什么不做 |
| --- | --- |
| **librarian** | omo 的 librarian 靠 `context7` 与 `gh_grep` 两个 MCP。Oint 没有 `web_search` / `web_fetch`，联网只能走 `browser_*`，而浏览器工具**被刻意排除在子智能体之外**（`subagent.ts:28-31`：「不该操作用户正盯着的页面」）。前置条件是「给子智能体开一个独立的隐藏浏览器标签」——那是浏览器子系统的一次改造。**P3 观察项。** |
| **observer** | 需要多模态模型与图片读取路径。Oint 的 `ModelEntry.acceptsImages` 是**主会话级**开关，子智能体的模型要么继承父会话要么在定义里固定，**没有按图片自动路由的机制**。且主会话本身就能读图（内核 `read` 支持图片）。 |
| **council** | 它需要的不是「一个子智能体定义」，而是**一种新的 Task 形态**：一个问题并行派给 N 个**不同模型**，再由合成者汇总。Oint 的 `Task` 一次调用只指定一个定义（模型随之固定），并发上限 4，每条报告都要回投主会话。做它等于新造一套调度。**P3。** |

### 3.4 路由表：写进提示词，且**必须带「何时别派」**

这是 omo 提示词工程里**最值得抄的一段**。它的 `AGENT_DESCRIPTIONS`
不给「这个 agent 能干什么」，而是每个都给三段：
**Delegate when / Don't delegate when / Rule of thumb**。

逐字例（omo `orchestrator.ts` 的 librarian 条目）：

```
**Delegate when:** Libraries with frequent API changes (React, Next.js, AI SDKs) •
Complex APIs needing official examples (ORMs, auth) • Version-specific behavior matters •
Unfamiliar library • Edge cases or advanced features • Nuanced best practices …
**Don't delegate when:** Standard usage you're confident • Simple stable APIs •
General programming knowledge • Info already in conversation • Built-in language features
**Rule of thumb:** "How does this library work?" → @librarian. "How does programming work?" → answer directly.
```

**为什么这条最重要**：负面边界把「派发」从「想起来才做」变成**可判定的决策**。

Oint 现有的 `buildDelegationPrompt`（`runtime.ts:889-922`）**已经有这个形状**
（「什么时候该派」/「什么时候不要派」两段），**扩展它即可，不必新写一套**。

---

## 4. 编排模式：技能规划

### 4.1 复刻优先级

omo 的 9 个技能（含一个从未注册的设计残片）。按「价值 ÷ 改造成本」排序：

| 优先级 | 技能 | 大小 | 依赖 | 改造点 |
| --- | --- | --- | --- | --- |
| **P1** | `verification-planning` | 4.6 KB | **零工具依赖** | 删掉 `@librarian` 一句即可**原样收** |
| **P1** | `simplify` | 4.8 KB | 只读 | 几乎原样；「读 AGENTS.md」→「读项目既有约定」 |
| **P2** | `clonedeps` | 8.7 KB | `bash`+git、`ask_user` | 删 OpenCode 专属的 `.ignore` 块；`@librarian` 那步改成主代理自己判断或派 explorer |
| **P2** | `codemap` | 6.8 KB | `bash`、`write`、子智能体扇出 | 三处必改：脚本路径、`AGENTS.md` 注入假设（§1.2）、`.ignore` |
| **P3** | `deepwork` | 6.4 KB | 5 个命名 agent、`todo`、后台作业 | 只移植**结构**（阶段 / 门禁 / 复审预算），roster 全部改写 |
| **P3** | `reflect` | 11.6 KB | 只读 | 只移植通用模式；`--sessions` 要读 Oint 自己的会话库，**必须重写** |
| **不做** | `worktrees` | 6.4 KB | 子智能体 cwd 覆盖 | **Oint 做不到**（§4.3） |
| **不做** | `oh-my-opencode-slim` | 11.7 KB | OpenCode 配置 | 全是 OpenCode 专属路径与 schema |
| **不做** | `loop-engineering` | 1.4 KB | 未实现的运行时 | omo 自己都没注册、没安装、没文档；是设计残片 |

**两个 P1 为什么值得先做**：

- `verification-planning` 是**纯推理脚手架** —— 零工具引用、零文件路径，
  唯一的外部引用是一句 `@librarian`。它的 6 个阶段每个都以
  **「Complete when: …」** 结尾（一个很值得学的形态：把「什么时候算做完」写成可检查的门槛）。
- `simplify` 的五条原则里有一条对 Oint 特别贴切：
  「Simplification that breaks project consistency is not simplification - it's churn.」
  而本仓库的注释风格（解释 **why** 而不是 what）正是这种一致性的一部分。

### 4.2 三个「必须改」的共性

1. **`.slim/` 状态目录 → `.oint/`**。
   Oint 的项目级约定已经是 `<cwd>/.oint/skills`、`.oint/subagents`、`.oint/prompts`
   （`resources.ts`），所以 `<cwd>/.oint/<skill-name>/` 是**顺着既有约定**的落点，
   而不是新造一套。注：本仓库 `.gitignore` 已把 `.oint/` 整目录忽略。
2. **`.ignore` 允许清单 → 整个删掉**。
   那是 OpenCode 的机制（它默认不读被 gitignore 的文件）。Oint 的 `read` / `grep` / `glob`
   没有这个行为，保留这些块只会是死代码。
3. **`AGENTS.md` 注册步骤 → 见 §1.2**。两个选择：
   (a) 索引写进技能自己的状态文件（本文方案，零改造）；
   (b) 让 `buildSystemPrompt` 也读 `<cwd>/AGENTS.md`（更符合业界惯例，但是独立改动，见 P0-6）。

### 4.3 为什么 `worktrees` 不做（值得单独记一笔）

`worktrees` 的 Phase 2 原文：

> 「Run all sub-agents with their working directory set strictly to the worktree path,
> such as `.slim/worktrees/<slug>/`.」
> 「Do not modify the main checkout for lane work.」

而 Oint 的子智能体 **cwd 写死继承父会话**（`subagent-runner.ts:331` `cwd: parent.cwd`），
`SubagentStartRequest` 里没有 cwd 字段。主代理自己切 cwd 也不行 ——
主会话的 `env.cwd` 在 `createRuntime` 时固定（`runtime.ts:1810` + `createExecEnv`）。

→ **结论：worktrees 需要一次「会话级 cwd 可变」的改造**（给 `SubagentStartRequest` 加 `cwd`，
并处理 `sessionAllowedRoots` 的允许根），超出本轮范围。**P3。**

---

## 5. 两个模式的系统提示词草案

### 5.1 标准模式（通用助手）

**设计要点：通用模式与编程模式的区别不是「去掉编程词汇」，而是多一步「先判断任务类型」。**
编程助手的隐含前提是「用户给你的是一个代码任务」；通用助手必须**显式**做这个判断，
否则会拿改代码的习惯去处理写作、研究、日程、文件整理这类请求。

```
你是 Oint —— 用户桌面上的通用助手。你既能读写文件、运行命令、写代码，
也能做调研、写文档、整理资料、规划事情。当前会话工作目录：{{cwd}}，
相对路径均基于该目录解析。

## 边界（一）

- 删除、覆盖、批量改动这类不可撤销的操作，先说清影响再执行。
- 用户让你做的事若明显有害或你做不到，直接说不，并给出替代方案。

## 先判断这是什么任务

动手之前先想清楚用户要的是什么，常见几类：
- 代码与技术工作：读、改、跑、验证；
- 写作与文档：起草、改写、结构化、校对；
- 调研与综合：读多个来源，给出结论与依据；
- 规划与拆解：把一件模糊的事拆成可执行的步骤；
- 文件与数据处理：整理、转换、批量改名、提取信息。

## 怎么问

- **多步任务**（要建文件、要走好几步、要调好几次工具）：**先问一次**再动手；
  只有简单的来回对话或一句话就能答的事实问题才跳过。
- **调研类任务**：**先搜再问** —— 初筛结果会让问题更具体，
  所以不要为了问而把第一次搜索挡住。范围或格式真的含糊时，边搜边问，或搜完再问。
- **无人值守时**（定时任务、你判断没人在看）：不要卡在问题上 ——
  自己选一个合理的做法，在回复里写明你假设了什么，然后继续。
- **每轮最多问一个问题**；触发条件是「答案会改变做法」，不是「有歧义」。
- 能靠读文件、跑命令自己查清的事不要问。

## 怎么工作

先弄清事实再动手：看文件用 read，找东西用 grep / glob，要执行命令用 bash。
不要凭猜测下结论，也不要编造工具的执行结果 —— 只依据工具真实返回的内容作答。
先做能验证的最小一步，再往下走；每一步都让结果可检验。
任务超过两三步时用 todo 记下来，每完成一步就更新它。

## 怎么说话

直接回答，不写开场白，不复述用户的请求，不夸奖用户的提问。
结论先行；需要展开时再展开，能一句话说清就别写三段。
**默认用成段的文字，不要动辄分点列条** —— 写报告、文档、说明时用散文，
只有用户明确要清单时才用列表。
不确定就直说不确定，并说明你依据什么、缺什么。
引用文件给 `路径:行号`；引用外部信息给来源；不要粘贴用户已知的大段内容。
用户的做法有问题时，直接说清顾虑与替代方案，再问他要不要照原样做 —— 不盲从，也不说教。

## 边界（二）

- 改动保持在当前项目内；确有必要动到项目之外时，先说明再动手。
- 使用{{reply_language}}回复用户。
```

> **注意两处刻意的安排**（来自附录 B 的排版结论）：
>
> 1. **「边界」被拆成首尾两段** —— omp 的提示词写作指南实测「'Lost in the Middle':
>    start/end retain; middle degrades ~20%」，所以**关键约束要放两头**，
>    参考资料与环境信息放中间。这不是重复，是刻意的两头压。
> 2. **草案没有「工具使用」一节** —— 那一节就是 `TOOL_GUIDANCE`
>    （`runtime.ts:687-695`，以「工具使用：」开头），由 `buildSystemPrompt` 的
>    sections 数组**单独拼进去**，与模式无关。草案里不要再抄一遍，否则同一段内容出现两次。

**相对现状的实质变化**（不是措辞润色）：

| 变化 | 现状 | 通用版 |
| --- | --- | --- |
| 身份 | 「智能**编程**助手」 | 「通用助手」，并**列出五类任务** |
| 任务判断 | 无（隐含前提：是代码任务） | **显式的「先判断这是什么任务」一节** |
| 沟通风格 | 只有「使用中文回复」 | 补齐：结论先行 / 不奉承 / 不确定就说不确定 / 引用给位置 |
| 边界 | 只有「不要编造执行结果」 | 追加：不可撤销操作先说影响；做不到就直接说 |

**「怎么说话」与「边界」两节的来源**：omo orchestrator 提示词里的
`<Communication>` 段，四节原文可直接核实 ——
「Clarity Over Assumptions」/「Concise Execution」/「No Flattery」/「Honest Pushback」。
可核对的逐字句：「Never: "Great question!" "Excellent idea!" "Smart choice!" or any praise of
user input.」/「Answer directly, no preamble」/「State concern + alternative concisely…
Don't lecture, don't blindly implement.」

#### 与现有测试断言的关系（逐条核对过 `runtime.test.ts:52-92`）

草案**刻意保留**其中 4 条断言所需的子串，只让 1 条需要同批修改：

| 断言 | 草案 | 说明 |
| --- | --- | --- |
| `toContain("D:\\workspace\\demo")` | ✅ | `{{cwd}}` 渲染 |
| `toContain("使用简体中文回复用户")` | ✅ | 末行 `使用{{reply_language}}回复用户`（**必留**：语言要求与模式无关） |
| `toContain("工具使用：")` | ✅ | 来自 `TOOL_GUIDANCE`，原样保留 |
| `toContain("grep / glob")`、`toContain("todo")` | ✅ | 同上，都在 `TOOL_GUIDANCE` 里 |
| `toContain("工作规则")` | ❌ **不满足** | 草案把这一节重命名为「怎么工作」 |

→ **必须同批改这一条断言**：`expect(prompt).toContain("工作规则")`
改为 `expect(prompt).toContain("怎么工作")`。

**这是本轮唯一一处要动现有测试的地方，且是有意的** ——
「工作规则」是编程语境的名字，通用模式里叫「怎么工作」更贴。
其余断言一律靠**保留子串**满足；**不要**为了少改一行测试就把新提示砍回旧形状。

#### 刻意保留不变的部分

`TOOL_GUIDANCE` 六条（工具选择指导与模式无关；通用助手照样用 read / grep / bash）、
技能索引段、AGENTS.md 段、委派段（标准模式下按现有四个子智能体生成）。

### 5.2 编排模式

```
你是 Oint 的编排者：负责计划、分派、跟踪、综合与验收，
而不是默认的实现者。

非平凡的工作，先识别出可以独立推进的工作线，把边界清晰的部分派给合适的专家。
只有在「一个孤立、清晰、低风险的动作，派发的开销大于自己动手」时，才自己做。

优化目标同时是四个：质量、速度、成本、可靠。

## 可用的专家

{{delegation_catalog}}

## 路由阈值

- 一个孤立、清晰、低风险的动作 → 自己做。
- 多步实现、大范围探索、复杂调试 → 派给合适的专家。
- 决策代价高、或前两次修复都没解决 → 派给 oracle，不要自己硬猜。
- 界面与设计判断（布局、层次、间距、动效、响应式、组件手感）→ 派给 designer，不要自己做。
- 一次实现告一段落 → 派给 verifier 独立复核，不要自己宣布通过。
- 两条以上工作线互不依赖 → 在同一条消息里并行派发。
- 不要因为「有这个专家」就派；也不要因为「每一步看起来都不难」就把全部工作留在自己手里。

## 派发的纪律

- 引用路径与行号，不要粘贴整个文件（`src/app.ts:42` 而不是全文）。
- 每次派发前，用一句话告诉用户这次要做什么。
- 派出去的 Task 要给出可验收的边界：做什么、做到什么程度、不要动什么。
  子智能体看不到这段对话，缺了背景它只能猜。
- 两个可写的子智能体不要同时改同一批文件。
- 上限是 4 个并发；超了会被直接拒绝，不要靠重试绕过。

## 收敛与综合

- 派完独立的后台任务后不要立刻空等：继续做不冲突的部分。
  报告会作为消息自动送到你这里（你正在跑就插进当前轮次，空闲就起一轮）。
- 下一步确实依赖结论时才用 TaskWait 收敛；用 TaskList 看进度；
  用 TaskStop 停掉确实不该继续的活 —— 不要用它「催」。
- 报告要由你综合后再给用户，并说明结论来自哪个子智能体。
- 说「子智能体完成了」不等于「它的结论是对的」：
  涉及改动的报告，自己 read 一遍被改的文件再下结论。

## 验收

- 所有会写文件的工作线都收敛之后，再做最终验证。
- 已经成立过的证据不要重复跑，除非最终状态变了或验收标准要求。
- 与用户沟通时按标准模式的风格：结论先行、不奉承、不确定就说不确定。
```

**「自己 read 一遍被改的文件再下结论」这一条的来源**：omp 的 `/vibe` director 模式，
逐字：

> 「Workers do the searching, editing, running, and building; the director **verifies
> their claims by reading touched files**.」
> 「The director remains responsible for the final outcome: **worker completion means the
> turn settled, not that its claims are correct**.」

这是本轮调研里对「编排者到底要不要保留 read」最直接的回答，也是 §6.3 的判据之一。

**`{{delegation_catalog}}` 的形态**（由 `buildDelegationPrompt` 按模式生成，
每个专家带「何时派 / 何时别派」两行）：

```
- oracle（只读）：架构取舍、方案对比、两次没修好的疑难、改动前的风险审查。
  何时派：决策代价高、影响面广、或前两次修复都没解决。何时别派：你已经有把握的常规决定。
- explorer（只读）：摸清一段实现的位置、调用链与既有约定。
  何时派：要翻很多文件才能得出结论。何时别派：你已经知道文件路径，只是要看内容。
- designer（可写）：界面与交互的实现、打磨与评审。
  何时派：用户看得见、且「好不好看 / 顺不顺手」有影响。何时别派：纯后端逻辑。
- fixer（可写）：按自包含的规格做多文件改动。
  何时派：规格已经确定、只剩执行。何时别派：还需要探索或设计判断。
- verifier（可写命令）：按验收标准独立复核，给出通过与不通过的证据。
  何时派：一次实现告一段落，需要独立确认。何时别派：只是想知道某条命令的输出。
- test-runner（可写命令）：跑一个具体命令并只汇报失败。
- code-reviewer（只读）：对刚完成的改动做对抗式挑错。
```

---

## 6. 设计方案

### 6.1 两条轴，别混

| 轴 | 现状 | 本轮改动 | 强制力 |
| --- | --- | --- | --- |
| **权限轴** | `permissionMode`：default / ai_review / full | **不动** | **强制**（`gateTool`） |
| **模式轴** | 无 | 新增 `agentMode`：`standard` / `orchestrate` | **纯引导**（提示层） |

**本轮两个模式都不带硬约束。** 这一点要在 UI 上讲清：
**「编排模式」不等于「不能自己写代码」**，它是「默认不自己写，而是派出去」。

### 6.2 作用域与生效时机

**建议：会话级绑定 + 全局默认，与 `model` 完全同构。**

现成通路（照抄即可）：`SessionSummary.model`（`session.ts:59-65`）→
`SessionIndexEntry.model`（`sessions-index.ts:19-20`）→
`sessionStore.readModel/setModel`（`session-store.ts:545-555`）→
`IPC.sessions.setModel` + `window.oint.sessions.setModel`（`api.ts:63`）→
`chatStore.setSessionModel`（`chat-store.ts:672-682`）。

理由：模式改的是「我在跟谁说话」，与 `model` 同类；而 `permissionMode` 是信任级别，
全局是对的。两个窗口里的会话不该互相影响。

**生效时机：下一次发送（轮的边界）。** 运行中切换不打断当前轮，
chip 上标注「本轮结束后生效」；在 `sendLocked`（`runtime.ts:2229-2233`）
与 `applyModel` / `applyThinkingLevel` 同批读取。

### 6.3 编排模式要不要限制工具？—— 必须记录的取舍

**这是本轮调研里最重要的一组对立证据。三家的做法互不相同，且都已核实。**

| | Roo Code | Kilo Code | oh-my-pi |
| --- | --- | --- | --- |
| 编排模式 | **有**：`slug: "orchestrator"` | **已废弃** | **有**：`/vibe` |
| 工具 | **`groups: []` —— 零工具**（源码事实） | — | 收窄为 `read` + `todo` + 5 个 worker 工具 |
| 理由 | **上下文毒化**（官方 FAQ 原文，见下） | 全工具 agent 已原生支持 subagent | 语境隔离 |

**Roo 侧（官方 FAQ 原文，已核实）** —— 这一条是本轮唯一给出**明确理由**的来源，
出自 `RooCodeInc/Roo-Code-Docs/docs/features/boomerang-tasks.mdx` 的 FAQ：

> **Why can't Orchestrator mode read files, write files, call MCPs, or run commands?**
>
> The Orchestrator mode is intentionally limited to focus on high-level workflow management.
> Giving it the ability to read files by default **causes the context to become filled with
> file reads, hampering its ability to remain focused on orchestration**. The design philosophy
> is that subtasks should handle the detailed work and return only the necessary information
> (via their completion summaries) for the orchestrator to delegate further tasks effectively.
>
> This limitation helps prevent **context poisoning**, where irrelevant or excessive information
> contaminates the model's active context, leading to degraded performance and task deviation.

同一文档还给了官方的**解除方式**（把 `groups: ["read"]` 写进自定义 orchestrator），
并附一句警告：「Adding capabilities to the Orchestrator mode should be done thoughtfully.
The limited default capabilities help maintain focus on orchestration rather than implementation details.」

> ✅ **纠错已撤回**：本节早先版本把这条理由标为「未核实」——当时的抓取路径
> （`docs.roocode.com`、`roocodeinc.github.io`）都不可达。现已从官方文档仓库
> `RooCodeInc/Roo-Code-Docs` 取到原文，**理由成立且逐字可引**。

**Kilo 侧（官方文档原文，已核实）** —— 出自 `kilo.ai/docs/code-with-ai/agents/using-agents`，
在 `### orchestrator (Deprecated)` 一节下：

> ⚠️ Orchestrator is deprecated and will be removed in a future release.
> **Agents with full tool access (Code, Plan, Debug) now support subagents natively —
> there's no need for a dedicated orchestrator.**

同一页还写明它的工具面是「Limited access to create new tasks and coordinate workflows」，
且「also has access to the **explore** subagent for codebase exploration」。

> ✅ **纠错已撤回**：这条早先标为「二手转述」。现已直接抓到 Kilo 官方文档原文。

**oh-my-pi 侧（官方文档原文，已核实）** —— `docs/vibe-mode.md`：

> Vibe mode turns the top-level interactive session into a **director** for persistent
> background worker sessions instead of letting it edit or execute commands itself.
> The director's active tools are reduced to `read`, optional parent-owned `todo`,
> and five worker-control tools. Workers do the searching, editing, running, and building;
> **the director verifies their claims by reading touched files.**

**本文建议：默认走「不限制工具」（提示层编排），理由有四**：

1. **「零工具」的理由在 Oint 不成立**。Roo 的论据是「文件读入会塞满 orchestrator 的上下文」，
   但 Oint 的编排者**本来就要读文件**（见第 3 条），而且 Oint 有 `compaction`
   与 `todo` 分担上下文压力 —— 这是 Roo 当年不具备的条件。
2. **限制工具有实际代价，且 omp 给了正面反证**：omp 的 director **保留 `read`**，
   正是为了「verify their claims by reading touched files」。
   完全零工具会让「验收」退化成「相信报告」—— 而报告可能是错的。
3. **Oint 的编排者需要自己验货**。Oint 的子智能体报告是**自然语言摘要**
   （不像 omp 有结构化 `output` schema），因此「读一遍被改的文件」是唯一可靠的核对手段。
4. **不想动工具表**：任何按模式过滤工具的做法都会撞上 `applyMcpTools` 的整表替换
   （`runtime.ts:1705-1720`，它不传 `subagentTools`、不做过滤），
   这个 bug 类仓库自己已经踩过（「漏一处会让它在 MCP 刷新后消失」）。

**但必须记下这组反证**：**八家里有三家（Kilo 废弃 orchestrator、Goose 移除 `/plan`、
Amp 禁止线程内换模式）正在远离「专门的编排模式」**。
它们的共同论点是「全工具 agent 已经能自己委派，专门切一个模式是多余的一步」。

→ **这对 Oint 的含义**：如果做编排模式，**必须能说清它比「标准模式 + 子智能体」多给了什么**。
本文的答案是**提示层**的三件事（标准模式里都不成立）：

1. **默认不自己动手**：标准模式的第一反应是自己做；编排模式的第一反应是派出去。
   omo 把这条写成角色定义：「You are **not** the default implementation worker」。
2. **一张带「何时别派」的路由表**：标准模式只列「有哪些子智能体」；
   编排模式给出每个专家的**派发阈值与反例**（§3.4）。
3. **验收纪律**：标准模式没有「派完还要自己核对」这一条。

**若这三条说不成立，就应当采纳 Kilo 的结论、不做这个模式** —— 这个判断标准写在
§7 的 P2 验收里。

**保留一个「严格编排」的可选档位（P2，不进本轮）**：把工具收窄到
`read` / `grep` / `glob` / `todo` + Task 四件套 —— 即 omp 的 `/vibe` director 形态
减去它独有的 `vibe_*` 工具。做成设置里的开关，而不是模式的一部分。
（Roo 的官方 FAQ 也正是这么建议的：默认收紧 + 明确告知如何放开。）

**另外记一笔**：omp 把「编排强度」做成了**提示词里的一个三值开关**
（`delegationBias: gated | eager | restrained`，替换整个 `# Delegation` 段）。
三档的原文分别是：

- `gated`：「No subagents unless user or applicable AGENTS.md/skill explicitly requests
  subagents, delegation, or parallel agent work.」
- `eager`：「Delegation default. Once design settles, MUST fan work to `task`, except ONLY:
  approximately-under-30-line single-file edit; direct answer/explanation without code changes;
  or user explicitly asks you to run a command.」
- `restrained`：「Inline first. Fan out only when 2+ independent slices each cost more than
  a handful of your own calls… decide after your own first grep/read, never before it.」

`restrained` 那档的三条禁令尤其值得抄进 Oint 的编排段：
「NEVER open with a scout.」「NEVER delegate one slice.」
「NEVER babysit. Spawn → keep working → read the result.」

**这组开关说明「编排」本质上是策略强度，而不是能力开关** ——
支持本文「不进工具层」的结论，同时也提示了**将来可以给编排模式加一档强度设置**。

### 6.4 内置资产的落地方式

**技能**（本轮最划算的一块）：

```
resources/skills/<name>/SKILL.md      ← 新增目录，随包分发
```

需要三处改动，都很小：

1. **`resources.ts` 加 `resolveBuiltinSkillDir()`**，返回 `app.getAppPath()` 下的
   `resources/skills`；**`electron-builder.yml` 的 `files:` 必须加一行 `resources/**/*`**。
2. **`loadAgentResources` 把内置目录放进 `loadSkills` 的目录列表**（`runtime.ts:760`）。
   顺序定死：**项目 `.oint/skills` → 数据目录 `skills/` → 内置 `resources/skills`**，
   让用户永远能覆盖内置（与 `loadSubagentCatalog` 的「同名用户定义优先」同一条原则）。
3. **`ipc/skills.ts` 的 `scanSkillDir` 要能标出 `source: "builtin"`** ——
   现在它硬编码 `source: "user"`（第 35 行那句注释就是留给这一处的）。

**子智能体**：直接在 `subagent-catalog.ts` 的 `BUILTIN_SUBAGENTS` 里加三个定义
（`source: "builtin"`）。**设置面板零改动** —— 它读的是 `loadSubagentCatalog` +
`disabledSubagentNames`，新预设自动出现在「系统」页签。
**i18n 也零改动**：内置定义的名字与描述**本来就是中文硬编码**（现有四个就是）。

### 6.5 切换 UI

- **形态**：两个模式用**分段控件**（照 `Composer.tsx` 里 `ThinkingChip` 的
  `PopoverContent` 内那一排 `field` 圆角按钮，390–450 行），一眼看全 + 一键切换。
- **位置**：`Composer.tsx` 第 785 行**之前**，即权限 chip 的**左侧**（用户指定）。
  左到右正好是「我是谁 → 我多信任它 → 用哪个模型 → 想多久」，作用域越来越窄。
- **触发键**：`<Icon/> + 模式名 + ChevronDown`；图标建议 `Sparkles`(标准) / `Network`(编排)；
  `aria-label` = `chat.agentMode`。
- **弹层底部一行说明**（照 `ThinkingChip` 的 `thinkingClamped` 那行说明的形态）：
  - 标准：「通用助手：写作、调研、规划、文件处理与编程」
  - 编排：「只做计划、分派与验收，实现交给子智能体 —— 它仍然可以自己读写文件」
  - 两行都可加一句：「切换会改变请求前缀，本轮请求的提示缓存将失效」。
- **切换提示**：运行中切换 → chip 内联提示「本轮结束后生效」（不打断当前轮）。
- **不做快捷键**（本轮）：`Tab` 在 Web 里是焦点键，抢它是净损失。

### 6.6 改动清单

**契约层**

| 文件 | 改动 |
| --- | --- |
| `src/shared/contracts/common.ts` | `AGENT_MODES = ["standard","orchestrate"] as const` + `AgentMode`（照 `ALL_THINKING_LEVELS` 的数组式写法，26–28 行） |
| `src/shared/contracts/settings.ts` | `agentMode: AgentMode`（注释点名消费它的 chip） |
| `src/shared/contracts/session.ts` | `SessionSummary.mode`、`SessionCreateOptions.mode` |
| `src/shared/contracts/ipc.ts` | `sessions.setMode: "sessions:set-mode"` |
| `src/shared/contracts/api.ts` | `sessions.setMode(id, mode)` |
| `src/shared/prompts/agent-modes.ts` | **新文件**：两个模式的策略段 + `{{…}}` 占位符（沿用 `shared/prompts/template.ts` 的 `renderPrompt`） |

**主进程**

| 文件 | 改动 |
| --- | --- |
| `src/main/settings/store.ts` | `DEFAULT_SETTINGS.agentMode` + `normalizeAgentMode` + `mergeWithDefaults` 显式归一（**两处都要**：只做前者等于让 `settings.json` 里的非法值直达运行时） |
| `src/main/pisdk/sessions-index.ts` | `SessionIndexEntry.mode` |
| `src/main/pisdk/session-store.ts` | `readMode` / `setMode`（照 `readModel`/`setModel`，545–555 行） |
| `src/main/ipc/sessions.ts` | `sessions:set-mode` 处理器 |
| `src/main/pisdk/runtime.ts` | `resolveSessionMode()`（子会话取父会话）；`buildSystemPrompt` 加 `mode` 参数；**函数式 `systemPrompt`**；`applyMode` 与 `applyModel` 同批；`buildDelegationPrompt` 按模式换措辞 |
| `src/main/pisdk/resources.ts` | `resolveBuiltinSkillDir()` |
| `src/main/pisdk/subagent-catalog.ts` | **保留四个名字**、重写其提示词与 `maxTurns`；**新增** oracle / designer / verifier（D4） |
| `src/main/pisdk/tools/subagent.ts` | **新增 `list_agents` 工具**（D7）；`Task` 描述微调 |
| `src/main/pisdk/permissions.ts` | `LOW_RISK_TOOLS` 加 `list_agents` |
| `src/main/ipc/skills.ts` | `scanSkillDir` 支持内置来源（35 行那处） |
| `electron-builder.yml` | `files:` 加 `resources/**/*` |

**渲染层**

| 文件 | 改动 |
| --- | --- |
| `src/renderer/features/chat/Composer.tsx` | `AgentModeChip`（照 `ThinkingChip` 的分段形态）+ 插到 785 行之前 |
| `src/renderer/stores/chat-store.ts` | `setSessionMode`（照 `setSessionModel`，672–682 行） |
| `src/renderer/features/session/environment-section.tsx` | 「环境信息」加一行模式（照 `PERMISSION_KEYS` 的 `Record<AgentMode,string>` 写法，15–20 行） |

**新增资源**

```
resources/skills/verification-planning/SKILL.md
resources/skills/simplify/SKILL.md
resources/skills/clonedeps/SKILL.md
resources/skills/codemap/SKILL.md          (+ scripts/codemap.mjs)
```

**词条**（`zh-CN.ts` + `en-US.ts` 的 `chat` 段；字段名用 `labelKey`，
因为 `check-i18n.mjs:56` 只扫 `labelKey` / `resting` / `active` 三个字段名）

```
chat.agentMode             "Agent 模式"
chat.agentModeStandard     "标准"
chat.agentModeOrchestrate  "编排"
chat.agentModeStandardHint "通用助手：写作、调研、规划、文件处理与编程"
chat.agentModeOrchHint     "只做计划、分派与验收，实现交给子智能体"
chat.agentModePending      "本轮结束后生效"
chat.agentModeCacheNote    "切换会改变请求前缀，本轮请求的提示缓存将失效"
sessionPanel.agentMode     "模式"
```

**测试**

| 文件 | 断言 |
| --- | --- |
| `main/settings/store.test.ts` | 模式往返 + 非法值回落（照 `permissionMode` 那两条，217–237 行） |
| `main/pisdk/runtime.test.ts` | **改** 1 条现有断言（「工作规则」→「怎么工作」）；**加**：两个模式的提示段不同；通用段含「通用助手」且**不含**「智能编程助手」；委派段按模式换措辞 |
| `main/pisdk/subagent-catalog.test.ts` | 三个新内置定义的工具集在 `SUBAGENT_ASSIGNABLE_TOOLS` 之内 |
| `main/ipc/skills.test.ts` | 内置技能被标为 `source: "builtin"`；同名用户技能覆盖内置 |
| `renderer/features/chat/Composer.mode.test.tsx` | 两个选项、选中写回、运行中显示「本轮结束后生效」 |

门禁：`npm run typecheck` / `test` / `check:i18n` / `check:unwired` 全绿。

---

## 7. 分阶段实施

### P0 —— 模式骨架 + 通用标准模式

1. 契约：`AgentMode` + `Settings.agentMode` + 会话级 `mode` + 存储归一 + `sessions:set-mode`。
2. `shared/prompts/agent-modes.ts`：先只填标准段（§5.1）。
3. `buildSystemPrompt` 加 `mode` 参数；runtime 用**函数式 `systemPrompt`** 接上。
4. `AgentModeChip` + 词条 + `Composer` 插入 + `Composer.mode.test.tsx`。
5. 环境信息面板加一行。
6. **（可选，但与「通用」定位强相关）** 让 `buildSystemPrompt` 也读 `<cwd>/AGENTS.md`
   —— 通用助手更常在「某个项目目录」里工作，只读数据目录的做法在通用场景下更别扭（§1.2）。

**验收**：切模式后下一轮系统提示确实换了；重启后会话模式还在；四个门禁全绿。

### P1 —— 内置技能通道 + 前两个技能

7. `resolveBuiltinSkillDir()` + `loadAgentResources` 三源合并 + `electron-builder.yml`。
8. `ipc/skills.ts` 标记 `builtin`（面板「系统」页签从此有内容）。
9. 收 `verification-planning` 与 `simplify`（改造成本最低的两个）。

**验收**：设置里「系统」页签列出两个技能；禁用后系统提示里不再出现；
**打包后的应用里同样能看到**（`resources/**` 进包）。

### P2 —— 编排模式 + 三个子智能体

10. 保留 explorer / code-reviewer / fixer / test-runner 四个名字并重写其提示词，新增 oracle / designer / verifier 三个内置定义。
11. **新增 `list_agents` 工具**（D7）：列出当前可用的子智能体定义。
12. 编排段提示词 + `buildDelegationPrompt` **只在编排模式调用**（D5）。
11. 编排段提示词 + `buildDelegationPrompt` 按模式生成路由表。
12. （可选）`clonedeps` 与 `codemap`（处理 `.slim/` → `.oint/`、脚本路径、§1.2 的注册步骤）。
13. （可选）设置里的「严格编排」工具档位（§6.3）。

**验收（功能）**：编排模式下提示里列出 7 个专家且带「何时派 / 何时别派」；标准模式下只列 4 个；
`check:unwired` 仍为 0。

**验收（值不值得做）** —— §6.3 的判断标准，**P2 结束时必须回答**：

> 编排模式相比「标准模式 + 子智能体」，实际多给了什么？

具体看三件事有没有真的发生（在真实会话里观察，不是看提示词写没写）：

1. **默认不自己动手**：给一个多步任务，编排模式是否**先派发**而不是先自己改文件？
2. **路由表被用上**：oracle / designer / verifier 是否在**该派的场景**里被派出去，
   且没有在**不该派的场景**里被滥用（派发率明显过高说明路由阈值写松了）？
3. **验收纪律生效**：收到「改完了」的报告后，是否**读了一遍被改的文件**再下结论？

**三条都不成立 → 采纳 Kilo 的结论，砍掉编排模式**，把路由表与验收纪律
并进标准模式的委派段即可（增量更小，且没有「多一个模式」的认知成本）。
这条刻意写成**可失败的验收**，而不是「做完了就算」。

### P3 —— 观察项（不做，仅记录）

- librarian / observer：需要浏览器子系统的「隐藏标签」改造与按图路由。
- council：需要「一个问题并行派给 N 个不同模型」的新调度形态。
- worktrees：需要「会话级 cwd 可变」（§4.3）。
- `deepwork` / `reflect`：移植**结构**而非 roster；`reflect --sessions` 要针对 Oint 自己的会话库重写。

---

## 8. 风险与已知边界

| # | 风险 | 处置 |
| --- | --- | --- |
| 1 | **「通用」写成「编程助手去掉编程二字」** | 标准段必须含**显式的任务类型判断**一节（§5.1）；测试断言通用段**不含**「智能编程助手」 |
| 2 | **切模式破坏前缀缓存** | 只在用户显式切换时发生（一次性）；模式在会话内不变时前缀逐字稳定；UI 上说明一句 |
| 3 | **现有测试断言旧提示词** | `runtime.test.ts:52-92` 的 5 条断言里，4 条靠**保留子串**满足（`{{cwd}}` / 「使用…回复用户」/「工具使用：」/「grep / glob」/「todo」），**只有「工作规则」一条必须同批改成「怎么工作」**。逐条核对见 §5.1。**不要**为了少改一行测试把新提示砍回旧形状 |
| 4 | **`resources/` 打包遗漏** | `electron-builder.yml` 的 `files:` 必须加 `resources/**/*`；漏掉的症状是**开发模式一切正常、打包后内置技能为 0**。P1 验收里加一条打包冒烟 |
| 5 | **技能 description 缺失被静默丢弃** | 内核行为（`loadSkillFromFile`）：缺 `description` 直接返回 `null`。移植时逐个核对 frontmatter；`loadAgentResources` 已有 diagnostics 打 warning（`runtime.ts:761-764`），**保留它** |
| 6 | **内置技能被用户同名技能遮蔽** | 这是**刻意**的（与子智能体同一条原则：用户优先）。但诊断里要说清「同名内置技能已被你的定义覆盖」，否则用户会以为内置的坏了 |
| 7 | **`applyMcpTools` 整表替换** | 本方案**不改工具目录**，从根上绕开 |
| 8 | **子智能体绕过编排模式** | 编排模式是纯引导，不构成约束；子会话取父会话模式只用于**提示措辞**（子智能体本来就不写编排段） |
| 9 | **第四个模式的扩展成本** | 设计目标：加一个模式 = 加一条 `AGENT_MODES` 项 + 一段策略文本 + 两个语言包的词条 + 一条 `Record<AgentMode,string>` 映射。编译器会在 `Record` 处报错逼你补齐 —— 这是刻意的 |

**明确不做**（本轮）

- 不做计划模式（上一版报告的写入门禁设计**不再保留**）；
- 不做「按模式换工具目录」（§6.3）；
- 不做「模型自行切换模式」——用户要的是输入框旁边那个开关。

---

## 9. 与产品定位的关系

`agent-tools-and-upgrade-guide.md` §7.4 的判据是「是否引入新的权限面」。

- **标准模式**：提示词重写，零新权限面。
- **编排模式**：三个新子智能体都落在既有 `SUBAGENT_ASSIGNABLE_TOOLS` 之内，
  与现有四个内置预设同级同权限；编排本身只是提示策略。
- **四个内置技能**：纯 markdown，不改权限面。`clonedeps` 会 clone 仓库（走 `bash`，已有审批），
  `codemap` 会写 `.oint/` 下的文件（走 `write`，已有审批）。

**结论：不越界。** 而且内置技能这一块**正好兑现了仓库里已经留好的位置** ——
`SkillSource` 的 `"builtin"`、面板的「系统」页签、
`ipc/skills.ts:35` 那句「将来随应用附带内置技能时在这里区分」，
以及两个已经写好却没人看得到的空态文案（「还没有内置技能」/「随应用提供的技能会显示在这里」）。

---

## 附录 A · 证据索引

### 本仓库（Oint）

| 主题 | 位置 |
| --- | --- |
| chip 行 / 插入点 | `src/renderer/features/chat/Composer.tsx:773-796`（`PermissionChip` 785） |
| 分段控件形态（照抄对象） | 同上 `ThinkingChip` 390-450；「chip 只负责画」570-576 |
| chip 复用件 | 同上 `chipTrigger` 106-111、`menuPanel` 114、`PickerItem` 124-152 |
| 系统提示装配 | `src/main/pisdk/runtime.ts:687-695`（`TOOL_GUIDANCE`）、`697-728`（`buildSystemPrompt`）、`1903-1911`（调用点） |
| **AGENTS.md 只从数据目录读** | 同上 `721` |
| 委派段 | 同上 `889-922`；子智能体段 `865-878`；名录加载 `828-841` |
| 技能装载 | 同上 `751-788`（`loadAgentResources`）、`760`（`loadSkills`）、`767`（禁用过滤）、`787`（索引） |
| 发送前「按当前设置对齐」 | 同上 `2229-2233`（`applyModel` 2110 / `applyThinkingLevel` 2165） |
| 工具表与陷阱 | 同上 `1705-1720`（MCP 整表替换）、`356`（运行中不换工具） |
| 风险分级 | `src/main/pisdk/permissions.ts:51-61`、`97-104` |
| 内置子智能体 | `src/main/pisdk/subagent-catalog.ts:69-105`；目录读取 `334-393` |
| 可分配工具 / 并发上限 | `src/shared/contracts/subagent.ts:32-40`、`45`、`63`；排除理由 `21-31` |
| **子会话 cwd 写死继承父** | `src/main/pisdk/subagent-runner.ts:331`；`SubagentStartRequest` 无 cwd：`tools/subagent.ts:102-109` |
| 技能契约 / 面板来源 | `src/shared/contracts/skills.ts:7`（`SkillSource`）；`src/main/ipc/skills.ts:35`（`source: "user"` 硬编码 + 注释） |
| 面板的「系统」页签与空态 | `SkillsPanel.tsx:31-37,195-201`；`zh-CN.ts:329-330,336-337` |
| 资源目录解析 | `src/main/pisdk/resources.ts:26-32`、`42-48`、`58-64` |
| 会话级绑定的完整先例 | `contracts/session.ts:59-65`、`sessions-index.ts:19-20`、`session-store.ts:545-555`、`contracts/api.ts:63`、`chat-store.ts:672-682` |
| 设置容错先例 | `src/main/settings/store.ts:29-42`（默认值）、`88-113`（合并）、`122-125`（归一） |
| 打包文件清单 | `electron-builder.yml:9-12` |
| 启动序列 | `src/main/index.ts:28-40`（`registerIpcHandlers` → `ensureAppDirs` → `bootstrapPisdk`） |
| 门禁脚本 | `scripts/check-i18n.mjs:55-56`（只扫 `labelKey`/`resting`/`active` 字段名）、`scripts/check-unwired.mjs`（反向校验 allowlist） |

### pi 内核（`node_modules/@earendil-works/pi-agent-core/dist/`，版本 0.85.1）

| 主题 | 位置 |
| --- | --- |
| `systemPrompt` 可为函数 | `harness/agent-harness.d.ts:625` |
| 每次 generation 前求值 | `harness/runtime/drive/generation.js`（`resolveSystemPrompt` / `prepareGeneration`） |
| `transform_context` 钩子 | `harness/hooks.js`；`generation.js`（`performGeneration` 的 `transformContext`） |
| **无 `sections` API**（与新版 pi-mono 不同） | 全 `dist/` 检索 `sections` 只命中 `utils.js` 的无关局部变量；`types.d.ts:291-292,363-364` 只有 `systemPrompt: string` |
| 技能装载契约 | `harness/skills.js`（`loadSkillFromFile`：`name` / `description` 必填 / `disable-model-invocation`；缺 description 静默丢弃；`name` 缺省取父目录名） |
| 技能索引格式 | `harness/system-prompt.js`（`formatSkillsForSystemPrompt`） |
| 技能类型导出 | `harness/skills.d.ts`（`loadSkills` / `loadSourcedSkills` / `formatSkillInvocation`） |
| 消息类型（无 system sections） | `harness/messages.d.ts:18-25`（`CustomMessage` 只有 `role: "custom"`） |
| `activeToolNames` 默认全部 | `harness/runtime/harness.js` |

### oh-my-opencode-slim（`master`）

| 主题 | 来源 |
| --- | --- |
| 7 个专家提示词 + 路由表 | `src/agents/{orchestrator,explorer,oracle,librarian,designer,fixer,council,observer}.ts` |
| 只读 / 可写规则常量、phase reminder | `src/config/constants.ts` |
| 8 个技能全文 | `src/skills/<name>/SKILL.md` |
| 逐技能分配表 | `src/cli/custom-skills-registry.ts`（`CUSTOM_SKILLS` 的 `allowedAgents`） |
| 技能机制（分配 / 装载 / 注入 / `--skills=force`） | `docs/skills.md`、`src/cli/skills.ts`、`src/hooks/auto-update-checker/skill-sync.ts` |
| 后台编排纪律 | `docs/background-orchestration.md` |
| preset 热切换的拒绝理由 | `docs/preset-switching.md` |

### oh-my-pi（`main`）

| 主题 | 来源 |
| --- | --- |
| 三条 mode-ish 机制（magic keywords / `delegationBias` / `/vibe`） | `README.md`、`docs/magic-keywords.md`、`docs/vibe-mode.md` |
| **director 形态与验收要求** | `docs/vibe-mode.md`（「the director verifies their claims by reading touched files」/「worker completion means the turn settled, not that its claims are correct」） |
| 子智能体发现与合并 | `docs/task-agent-discovery.md` |
| 结构化输出 frontmatter（可借鉴） | `packages/coding-agent/src/prompts/agents/scout.md`（`output.properties` + `optionalProperties.report`） |
| advisor / watchdog 机制 | `docs/advisor-watchdog.md` |
| task 工具描述与派发纪律 | `packages/coding-agent/src/prompts/tools/task.md`、`prompts/agents/task.md` |

### Roo Code / Kilo Code（模式与工具限制的证据）

| 主题 | 来源 | 核实程度 |
| --- | --- | --- |
| `ModeConfig` schema 与 5 个内置模式全文 | `packages/types/src/mode.ts`（`roleDefinition` / `whenToUse` / `customInstructions` / `groups`） | ✅ 源码直读 |
| **Orchestrator `groups: []`** | 同上（`DEFAULT_MODES` 里 orchestrator 条目） | ✅ 源码直读 |
| 模式解析与合并 | `src/shared/modes.ts`（`getModeSelection` / `getAllModes` / `FileRestrictionError`） | ✅ 源码直读 |
| **Roo「零工具」的官方理由（上下文毒化）** | `RooCodeInc/Roo-Code-Docs/docs/features/boomerang-tasks.mdx` 的 FAQ「Why can't Orchestrator mode read files…」 | ✅ **原文直读** |
| **Kilo 废弃 orchestrator 及其理由** | `kilo.ai/docs/code-with-ai/agents/using-agents`（`### orchestrator (Deprecated)`） | ✅ **原文直读** |
| omp `/vibe` director 形态 | `docs/vibe-mode.md` | ✅ 文档直读 |
| omp `delegationBias` 三档 | `packages/coding-agent/src/prompts/system/system-prompt.md` | ✅ 源码直读 |

---

## 附录 B · 通用（非编程）助手提示词的行业对照

> 这一节回答 §5.1 的核心问题：**通用助手怎么写才不像一个编程助手？**
>
> ⚠️ **来源说明**：本节的通用助手提示词全部来自**泄露/转述类仓库**
> （`jujumilk3/leaked-system-prompts`、`asgeirtj/system_prompts_leaks`、
> `x1xhlol/system-prompts-and-models-of-ai-tools`），**不是厂商发布的一手来源**。
> 它们只用于**看结构**，不作为逐字引用的权威依据。
> OpenAI Model Spec 与 OpenHands SDK 是**一手**来源（前者官方发布，后者开源仓库源码）。

### B.1 关键结论：没有一家把能力写成「工程学科清单」

**通用助手表达能力的单位是「任务产出」（gather / write / analyse / plan / deliver files），
而把 shell / browser / 文件读写当成**工具**来描述。** 六种可核实的手法：

| 手法 | 出处 | 原文 |
| --- | --- | --- |
| **工具化从属** —— 编程只作为手段被提及 | Manus | 「5. Using programming to solve various problems beyond development」 |
| **目录降权** —— 编程是众多条目中的一条 | Manus | 「### Content Creation … - Creating and editing code in various programming languages」（5 条里的第 3 条） |
| **工具而非身份** —— 只列 shell/文件工具，完全不把「编程」列为能力 | Claude Cowork | 「Claude has a private Linux workspace with file tools (Read, Write, Edit), a shell for running code, and the ability to deliver files to the user.」 |
| **产品切割** —— 明确否认编程产品的身份 | Claude Cowork | 「Claude is NOT Claude Code and should not refer to itself as such.」 |
| **格式条件** —— 代码块是**格式**决策，不是能力 | OpenAI Model Spec | 代码块处理列在 `interactive=true` 的行为里 |
| **反面教材** | OpenHands `<ROLE>` | 「Your primary role is to assist users by executing commands, modifying code, and solving technical problems effectively.」 |

**Manus 的段落配比是最有说服力的一条**：它有约 21 个同级段落
（`<intro>` / `<writing_rules>` / `<coding_rules>` / `<browser_rules>` / …），
`<coding_rules>` 只占其中**一个**，且**没有** `<code_quality>` / `<version_control>` /
`<pull_requests>` 这类兄弟段落。而 `<writing_rules>` 比 `<coding_rules>` **更长、更具体**。

→ **对 §5.1 草案的含义：草案目前的方向是对的**（能力写成五类任务产出、
编程只占其一），但**还可以更彻底**：把「怎么说话」的篇幅写到超过「工具使用」。

### B.2 「先问还是先做」—— 这一条各家明确分歧，需要拍板

这是 §5.1 草案里唯一一个**各家没有共识**的点，而且分歧是「默认还是例外」：

| 立场 | 出处 | 原文 |
| --- | --- | --- |
| **多步任务默认先问** | Claude Cowork | 「Claude should always use this tool **before starting any real work**—multi-step tasks, file creation, or any workflow involving multiple steps or tool calls. The only exception is simple back-and-forth conversation or quick factual questions.」 |
| **研究类任务先搜再问** | Claude Cowork | 「For research or information-gathering tasks, Claude begins searching immediately rather than gating the first search on a clarifying question—because initial results often make follow-up questions more concrete and useful.」 |
| **无人值守时自行假设并说明** | Claude Cowork | 「the session is running on a schedule or otherwise unattended — in that case Claude makes a reasonable choice, states the assumption clearly in its response, and proceeds rather than blocking on a question no one is there to answer.」 |
| **先答再问** | Claude Sonnet 4.5（转述） | 「Claude does its best to address the user's query, even if ambiguous, before asking for clarification」+「avoids overwhelming the person with more than one question per response」 |
| **不要问，直接做** | ChatGPT 5.5（转述） | 「Partial completion is better than unnecessary clarification questions.」/「Penalties apply for asking for information already present in the user context.」 |
| **按交互模式切换** | OpenAI Model Spec（一手） | 「if `interactive=false`, the assistant should default to not asking clarifying questions and just respond programmatically」 |

**建议的合成规则（写进 §5.1 草案）**：

1. **多步任务默认先问一次**（Cowork 的默认），
2. **但研究类任务先搜再问**（初筛结果会让问题更具体），
3. **无人值守时自行假设并在回复里写明假设**，不要卡住，
4. **每轮最多问一个问题**，
5. **触发条件是「会不会改变做法」**，而不是「有没有歧义」。

→ 这将替换草案现在那句笼统的「判断不清…先问一句」。
（codex 的 `default.md` 站在对立面：「strongly prefer making reasonable assumptions…
rather than stopping to ask questions」—— 那是**编程模式**的立场，
通用模式采用上面的五条更合适，因为通用任务里「问错方向」的返工代价更高。）

### B.3 可直接借鉴的两个**一手**结构

**(1) OpenAI Model Spec 的权威阶梯**（`model-spec.openai.com`，官方发布）——
任何模式系统都需要的一条脊柱：

> **Root** → **System** → **Developer** → **User** → **Guideline**
> 「To maximally empower end users and avoid being paternalistic,
> we prefer to place as many instructions as possible at this level.」

对 Oint 的含义：**权威阶梯说明「模式」应当落在 Developer 层**（部署方/应用设定的规则），
而不是 Root 或 System 层 —— 也就是说，**用户应当能覆盖模式的行为**。
这支持 §6.2「会话级绑定 + 全局默认」且**不做硬约束**的设计。

**(2) OpenHands 的 `guard()` 段落注册表**（开源 SDK 源码）——
不是措辞，是**结构**：

> 每个提示词段落都有**自己的 `guard(ctx)` 断言**与 `cache_tier`（STATIC / DYNAMIC），
> 按 preset 组合；`DateTimeSection` **刻意排在最后**以保持缓存前缀稳定。

对 Oint 的含义：`buildSystemPrompt` 现在是一个手写的 sections 数组
（`runtime.ts:704-727`）。**模式段的引入正好是把这个数组变成「带 guard 的段落表」的时机** ——
每个段落声明「什么模式下出现」，而不是在函数体里写 `if`。
这同时解决了 §8 风险 9（加第四个模式的成本）。

**OpenHands 的三级同意模型也值得抄**（这是本附录里最可复用的安全块）：

> **OK to do without Explicit User Consent** — 从用户指定的仓库下载并运行代码 /
> 在原仓库上开 PR / 从**官方**包registry 安装并运行流行包 / 用 API 操作 GitHub 等平台
> **Do only with Explicit User Consent** — 把代码上传到取得地之外的任何地方 /
> 上传 API key 或 token 到任何地方 / 把含密钥的文件搬到更广受众可读的位置
> **Never Do** — 任何违法活动 / 运行加密货币挖矿软件

### B.4 不要抄的三件事

| 反模式 | 出处 | 为什么 |
| --- | --- | --- |
| 把能力写成工程学科（`<CODE_QUALITY>` / `<VERSION_CONTROL>` / `<PULL_REQUESTS>` 三兄弟） | OpenHands 默认段落表 | 这正是「通用模式读起来像编程模式」的成因 |
| 通篇强制列表格式 | Manus | 通用助手要写文档；Manus 反而明确「Avoid using pure lists and bullet points format in any language」并把 `<writing_rules>` 写得比 `<coding_rules>` 长 |
| 用「Be efficient with tokens」这类激励式措辞 | omp 的提示词写作指南（`.omp/skills/system-prompts/SKILL.md`） | 该指南把它列为反模式，会导致「premature task abandonment」 |

**另外两条来自同一份 omp 提示词写作指南、可直接用的排版规则**：

> 「'Lost in the Middle': start/end retain; middle degrades ~20%.
> **Critical constraints at both edges**; reference material, environment,
> templated content in middle.」

→ **对 §5.1 草案的修订建议**：把「边界」一节（不可撤销操作、做不到就说）
**同时放到开头和结尾**，而不是只留在末尾。这条改动零成本、有明确收益。

### B.5 仍未核实的事项

- **Cursor / Amp / Cline / Goose 的模式细节**：本轮未逐一核实其提示词结构，不作论据。
- **Amp 的线程内模式锁定的理由**（违反会导致 prompt cache 失效）：来自其官方文档，
  但本轮未能独立复核，**与 §6.2「允许切换」的建议存在张力** ——
  若将来实测切换后首轮成本明显上升，应重新评估是否改为「新会话才能换模式」。
- **「模式 = 模型 + 推理档 + 提示 + 工具」的整体打包**（Amp 的定义）：
  Oint 本轮**只做提示层**，模型与推理档仍是独立的 chip。这是有意的简化，
  不是对 Amp 做法的否定。

---

## 变更记录

- **本轮（重写）**：按用户要求收敛为**两个模式**，并把上一版的计划模式设计**整体移除**。
  新增：Oint 两条硬约束的源码核验（内核无 `sections` API、AGENTS.md 只读数据目录）；
  omo 全部 9 个技能的复刻优先级与逐项改造点；omo 7 专家 vs Oint 现有 4 个的对照与
  「做 / 不做」决策；omp 的 `/vibe` director 形态、magic keywords、`delegationBias`
  三条 mode-ish 机制的对照；通用标准模式草案（§5.1）与编排模式草案 + 路由表（§5.2）；
  内置技能通道的三处改动与打包风险（§6.4、§8）。
- **补全**：附录 B 从「未完成」补成完整章节（通用助手的六种写法、先问/先做的六方对立与
  合成规则、两个一手结构、三个反模式）。
- **撤回两处「未核实」标注**：Roo 的「零工具」理由（上下文毒化）与 Kilo 废弃 orchestrator
  的理由，均已从官方文档取到原文（`RooCodeInc/Roo-Code-Docs` 与 `kilo.ai/docs`）。
  §6.3 据此重写为四家对照，并新增一条判断标准：**若说不出编排模式比「标准 + 子智能体」
  多给了什么，就应当采纳 Kilo 的结论、不做这个模式**。
- 上一版（已废弃）：五方模式机制对照 + 标准 / 计划 / 编排三模式方案。
  其中「五方对照」（dsh / opencode / codex / omo / Claude Code·Cursor·Amp 的机制拆解）
  与「计划模式」设计**在本轮被移除**；如需查阅请从 git 历史取回。
