# Oint 斜杠命令 / 魔法提示：现状核实与方案报告

> 范围：`/` 菜单的数据来源与行为、`/compact`、`/init` 这类「指令」的完成度、指令与魔法提示是不是一回事、以及 `/` 里补齐魔法提示的落地方案。
> 本文只做核实与设计，不含实现。所有结论都带证据位置（`文件:行`）。

---

## 0. 结论（先读这段）

1. **`/` 菜单本来就是两栏：技能 + 魔法提示，代码没有缺。** 你只看到技能，是因为**一份魔法提示都不存在**：随包分发的内置提示包从来没做过（仓库里没有 `resources/prompts/`，目录解析只有「数据目录 → 项目」两层），而本机 `~/.oint/prompts/` 是**空目录**（实测）。空栏在菜单里直接不渲染（`SlashCommandMenu.tsx:82`），所以你连「魔法提示」这四个字都看不到。
2. **`/compact` 不是「没实现」，而是「后端全通、入口为零」。** `chat.compact` 从契约 → preload → IPC → runtime → 内核 `lane.compact` 一路都通（`api.ts:103`、`preload/index.ts:49`、`ipc/chat.ts:53`、`runtime.ts:2958`），但**全仓没有任何地方调用它**（`chat-store.ts:875` 的 `compact()` 动作零调用点）。缺的只是一个菜单项。
3. **`/init` 与 `/compact` 不是同一类东西。** 判据是「**谁执行**」：`/init` 是让模型自己用工具读仓库、写 `AGENTS.md` —— 它本质是**一段内置提示词**，不需要任何新后端；`/compact` 是应用自己去压缩会话 —— 它必须被**拦下来、不发给模型**，需要一条指令通路。
4. 所以「在 `/` 里也要有魔法提示的相关内容」这件事，最直接的落地不是造指令系统，而是**把内置魔法提示层补上**（镜像已经存在的内置技能层）；指令系统是另一件事，用来承接 `/compact` 这种有副作用的动作。

---

## 1. 现状：`/` 菜单到底是怎么来的

### 1.1 一条斜杠命令的完整生命周期（4 步，4 个文件）

| 步骤 | 做什么 | 位置 |
| --- | --- | --- |
| ① 取数 | 并发拉 `skills.list(cwd)` + `prompts.list(cwd)`，拍成菜单项 | `use-slash-commands.ts:45-64`、`slash-commands.ts:51` |
| ② 渲染 | 两栏 `SLASH_GROUPS = ["skill", "template"]`，**空栏整栏不渲染** | `slash-commands.ts:43`、`SlashCommandMenu.tsx:80-110` |
| ③ 选择 | 技能 → 填 `/名称 `（正文在磁盘上，模型自己去读）；模板 → **直接插入正文** | `slash-commands.ts:156-159`、`Composer.tsx:712` |
| ④ 发送 | 发送前展开：模板正文替换整条消息（名称后的文字接在正文后，空行隔开） | `slash-commands.ts:168-174`、`OintRuntimeProvider.tsx:36-47` |

④ 有**两条**发送路径，都必须经过展开：库的发送键/回车走 `onNew`（`OintRuntimeProvider.tsx:85-92`），运行中的「排队 / 插话」走 Composer 自己的按键分支（`Composer.tsx:761`）。这一点对后面的「指令拦截」很关键。

设计口径写在 `slash-commands.ts:8-10`：**模板没有参数**，命令名之后多敲的文字只当作普通正文接在后面，不做 `$1` / `$ARGUMENTS` 替换（有测试钉住：`slash-commands.test.ts:190-191`）。

### 1.2 为什么你现在只看见技能（五条证据）

| # | 证据 | 说明 |
| --- | --- | --- |
| A | `~/.oint/prompts/` **空**（本机实测） | 用户一份魔法提示都没建过 |
| B | 仓库里**没有** `resources/prompts/` | `resources/` 下只有 `skills/`（8 个内置技能）。README「魔法提示」一行承诺的「系统 / 用户页签」里，**系统那一半从来没有内容** |
| C | `resolvePromptTemplateDirs(workingDir?)` 只有两层：数据目录 → 项目，**连 appPath 参数都没有** | `resources.ts:83-89`。对照 `resolveSkillDirs(workingDir, appPath)` 是三层、第三层是内置（`resources.ts:33-42`、`skills.ts:92`） |
| D | 单测把「没有内置来源」写成了断言 | `resources.test.ts:126`：「提示模板：数据目录 → 项目（没有内置来源）」 |
| E | 扫描结果的 `source` 恒为 `"user"` | `ipc/prompts.ts:68`。所以设置面板「系统」页签**永远是空态**（文案早就写好了：`promptsSystemEmpty` / `promptsSystemEmptyHint`，`zh-CN.ts:420-421`） |

**这不是 bug，是缺一层。** 技能有三层来源（数据目录 → 项目 `.oint/skills` → 内置 `<appPath>/resources/skills`，顺序即优先级），提示模板只有两层，而且第二层还要靠会话 cwd 才出现。菜单里 `if (items.length === 0) return null`（`SlashCommandMenu.tsx:82`）把空栏彻底藏了，于是「技能 + 魔法提示」在界面上退化成了「技能」。

顺带一个已经写进契约、但值得知道的口径：**禁用技能仍然出现在 `/` 菜单里**（`shared/contracts/skills.ts:15`：禁用后不进系统提示，但仍可手动调用）。菜单清单与「模型看到的清单」故意不是同一份。

### 1.3 顺手发现：另有一个同名但无关的「命令」概念

Ctrl+K 全局搜索里有一个**只服务于搜索面板**的命令表：`CommandId = "new-chat" | "toggle-theme"`（`SearchModal.tsx:39`、`:204-213`），入口是「加一个搜索命令要改 2 处」（`docs/plugin-system-report.md:55`）。它与 `/` 菜单**零共用代码**。要不要合并进同一套注册表，是一个决策点（见 §6）。

---

## 2. 现状：「常用指令」的完成度盘点

| 能力 | 后端 | 入口 | 缺口 |
| --- | --- | --- | --- |
| **`/compact` 压缩上下文** | **全通**：`api.ts:103` → `preload/index.ts:49` → `ipc/chat.ts:53` → `runtime.ts:2958` → 内核 `lane.compact`；事件 `compaction-started/ended` 也已桥接（`contracts/chat.ts:114-115`、`chat-store.ts:1055-1060`） | **无** —— `store.compact()`（`chat-store.ts:875`）全仓零调用 | 菜单项 + 拦截 + 错误面。另外：自动压缩本来就开着（`runtime.ts:2193`：`enabled: true, reserveTokens: 20_000, keepRecentTokens: 40_000`），手动 `/compact` 的价值在于**带指令压缩** |
| **`/init` 初始化项目 AGENTS.md** | **只有读**：`AGENTS.md` 由 runtime 两层注入（全局 `~/.oint/AGENTS.md` + 项目 `<cwd>/AGENTS.md`，`runtime.ts:821-822`、`:869-870`）；`ipc/agents.ts` 的 `write` **写死数据目录**，项目级没有写入口 | 无 | 不需要新后端：模型自己的 `write` 工具能写 `<cwd>/AGENTS.md`（cwd 在 `sessionAllowedRoots` 里，`runtime.ts:1052-1072`）→ **它可以是一段内置提示词** |
| 停止本轮 | 有（`chat.stop`） | 发送键变停止 | — |
| 重新生成 / 编辑重发 | 有 | 消息操作 | — |
| 新建会话 | 有 | Ctrl+N、侧栏、Ctrl+K | — |
| `/help`、`/model`、`/status` | 无 | 无 | 需要新做（`/model` 的能力在 Composer chip 上已有） |

`/compact` 还有两个必须处理的行为事实：

- **运行中会被内核拒**：`LaneBusy` 时新的 `prompt / compact / navigate` 一律拒收（`runtime.ts:512-519`），所以指令要能声明「运行中不可用」，否则用户看到的是一个失败弹窗。
- **失败现在没人接**：`store.compact()` 没有 try/catch（`chat-store.ts:875-879`），IPC 拒绝会直接变成未处理的 rejection。指令层必须捕获并给出人话错误（压缩摘要条所在的位置就是现成的展示位：`ThreadToolbar.tsx`）。

---

## 3. 指令 与 魔法提示 是一回事吗？

**不是一回事，但也不是两个世界。** 三者的真实边界：

| | 技能 Skill | 魔法提示 Prompt | 指令 Command |
| --- | --- | --- | --- |
| 内容住在哪 | 磁盘（SKILL.md，三层目录） | 磁盘（`*.md`，两层目录）+ **未来的内置层** | 编译期代码（注册表） |
| **谁执行** | 模型（按需读正文） | **模型**（正文就是消息） | **应用**（副作用在本地发生） |
| 有没有「不发给模型」的部分 | 有（只有元数据进菜单） | 没有 | **有**（整条都不发） |
| 用户能否自己创作 | 能（放文件夹 / zip 导入） | 能（设置面板或放文件夹） | **不能**（渲染层是特权层，见 `docs/plugin-system-report.md` 约束 B/C） |
| 参数 | 无 | 现在**刻意无**（内核其实支持，见下） | 有（如 `/compact <保留什么>`） |
| 运行条件 | 无 | 无 | 有（运行中不可用等） |
| 失败长什么样 | 对话本身 | 普通消息失败 | **必须自己渲染结果/错误** |

三条判据，按顺序问即可：

1. **谁执行？** 模型能自己做 → 提示词；必须动应用状态（会话、上下文、权限、面板）→ 指令。
2. **要不要「不发消息」？** 要 → 指令。（这正是 `/compact` 不能实现为魔法提示的原因：它的正文一旦发出去，模型会试图"扮演"压缩。）
3. **失败要不要有专门的 UI？** 要 → 指令。

按这三条判据分类常见的 `/xxx`：

- **属于魔法提示**：`/init`、`/review`、`/explain`、`/commit-message`…… 它们的共同点是「模型带着工具去做一件事」，正文就是一段工作说明。
- **属于指令**：`/compact`、`/new`、`/stop`、`/clear`、`/help`、`/model`、`/status`…… 它们的共同点是「应用有事要做，而且消息不该发出去」。
- **边界情况**：`/init` 有人喜欢做成指令（应用先探一遍目录、把模板填好再插入输入框）。这是**体验选择**，不是架构必然；提示词版本零后端成本，指令版本多一层可控性（比如「已存在 AGENTS.md 时先问」）。

**一个容易漏掉的事实**：内核其实**已经提供了参数化模板的能力** —— `parseCommandArgs` / `substituteArgs`（`$1` / `$@` / `$ARGUMENTS` / `${@:N:L}`）/ `formatPromptTemplateInvocation`（`@earendil-works/pi-agent-core/dist/harness/prompt-templates.d.ts:43-48`），而 Oint 明确选择了不做占位符替换（`slash-commands.ts:8-10` + 测试）。所以「斜杠命令带参数」在基础设施上是现成的，缺的只是产品口径的决定。

---

## 4. 建议方案

分三层，可以独立落地、独立验收。

### 4.1 层 1（P0，直接回答「`/` 里也要有魔法提示」）：内置魔法提示包

镜像已经跑通一年的内置技能机制，把提示模板从两层变三层。

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | 新增 `resources/prompts/*.md`（内容随包分发） | 新目录 |
| 2 | 新增 `resolveBuiltinPromptDir(appPath)`（与 `resolveBuiltinSkillDir` 同构，含 `app.asar.unpacked` 回落） | `resources.ts:68-73` 旁边 |
| 3 | `resolvePromptTemplateDirs(workingDir, appPath)` 加第三层；顺序 = 数据目录 → 项目 → 内置 | `resources.ts:83-89` |
| 4 | ⚠️ **同时把内置模板目录加进 `sessionAllowedRoots`** | `runtime.ts:1052-1072`。漏掉的症状与内置技能同款（`runtime.ts:1062-1068` 记录过这个坑）：目录存在却 0 个模板，只有 diagnostics 一行警告 —— 内核侧「每个目录一个 env、allowedRoots 必须包含该目录」的前提见 `ipc/prompts.ts:49-51` |
| 5 | `ipc/prompts.ts` 的 `source` 改成**按路径判定**（照抄 `skills.ts:37-41` 的 `sourceOfDir`），写/删只作用数据目录，内置不可删 | `ipc/prompts.ts:62-70`、`:98-134` |
| 6 | `runtime.ts:925` 的 `loadPromptTemplates` 目录清单同步加上内置层（面板与运行时同源，否则「菜单里看得见、系统提示里没有」） | `runtime.ts:921-934` |
| 7 | 更新 `resources.test.ts:126` 的断言 + 加一条「内置提示完整性」测试（镜像 `resources.test.ts:148` 的内置技能完整性测试：至少 N 个、frontmatter 有 name/description） | 测试 |
| 8 | 设置面板「系统」页签从此有内容（文案已就绪），空态文案变成真正的空态 | `PromptsPanel.tsx` |
| 9 | `electron-builder.yml` 的 `resources/**/*` 已包含，无需改 | — |

优先级规则与技能完全一致：**同名时用户/项目胜出**（内置永远可被覆盖）；内置提示不可删除、随升级整包替换更新。

首批内置提示的建议名单（**数量要克制**，每个都要能独立成立）：

| 名称 | 正文做什么 | 为什么值得内置 |
| --- | --- | --- |
| `init` | 读仓库结构/README/构建配置，写出项目级 `AGENTS.md`（并在已有文件时先确认） | 首次使用价值最高；当前完全没有入口，且它天然是提示词 |
| `review` | 只读走查当前改动，给「问题 + 位置 + 理由」，不改代码 | 与右侧「审查」面板互补 |
| `explain` | 用「先结论后细节」解释选中的文件/目录 | 高频、零风险 |
| `fix-tests`（或 `verify`） | 跑测试、定位失败、最小修复、再跑一遍 | 覆盖「闭环」类需求 |

效果：**`/` 菜单立刻出现「魔法提示」栏**，且是随包分发的、开箱即用的内容 —— 这正是你说的「在 `/` 里也要有魔法提示的相关内容」。

### 4.2 层 2（P1，承接 `/compact` 这种指令）：指令机制

| # | 改动 | 说明 |
| --- | --- | --- |
| 1 | `SlashCommand.kind` 加 `"command"`；`SLASH_GROUPS = ["command", "skill", "template"]`（指令排最前，因为它最"重"） | `slash-commands.ts:24-30`、`:43`。菜单分组、键盘走位、`optionKey` 都已经是按 kind 泛化的，改动面小 |
| 2 | 新增指令注册表：`src/shared/contracts/commands.ts`（id / 名称 / i18n 键 / 是否可用 / 描述），渲染层 `features/chat/commands.ts` 放 handler | 新文件；与 `SearchModal` 的命令表风格一致，先不做合并 |
| 3 | **两个拦截点，缺一不可**：① `OintRuntimeProvider.onNew`（发送主路径）② `Composer.handleInputKeyDown` 的排队/插话分支 | `OintRuntimeProvider.tsx:85-92`、`Composer.tsx:757-767`。只拦 ① 的话，运行中敲 `/compact` 会被当普通文本排队发出去 |
| 4 | 命中指令 → 执行副作用 → **不发送消息**（清空输入框）；未命中 → 走原有展开 | 同上 |
| 5 | 可用性声明：`/compact` 在运行中不可用（内核 `LaneBusy` 会拒，`runtime.ts:512`），菜单里置灰 + 说明 | `SlashCommandMenu.tsx` 行状态 |
| 6 | 失败面：指令层 try/catch，把原因显示出来（store 现在不接，`chat-store.ts:875`） | 建议复用「系统通知行」口径（`chat.systemNotice`，`zh-CN.ts:220-222`） |
| 7 | 参数：`/compact 保留数据库相关的讨论` → `rest` 作为 `customInstructions`（后端已支持 `instructions`） | `runtime.ts:2958-2966` |
| 8 | i18n 双语言 + `npm run check:i18n`；测试：`slash-commands.test.ts`（纯逻辑）+ `Composer.slash.test.tsx`（UI，已有同类用例可扩展） | — |

首批指令建议：**`/compact`（后端已就绪，成本最低，价值最高）**、`/new`、`/stop`、`/help`。`/help` 特别值得做：指令一旦有多种，用户需要一个地方看到「有哪些、在什么条件下可用」。

### 4.3 层 3（P2，可选）：参数与模板占位符

- 指令参数：见 4.2 第 7 条。
- 模板参数（`$1` / `$ARGUMENTS`）：内核助手函数现成，改口径即可 —— 但**当前「模板无参数」是有意为之**（`slash-commands.ts:8-10` 的理由：正文里的 `$1` 可能只是普通字符），要做就得同时决定「哪些模板声明参数」。建议后置，不要和层 1 绑在一起。

### 4.4 明确不做（这次不动的地方）

- **不让用户自定义「有副作用的指令」**：渲染层是特权层（`window.oint` 约 70 个白名单方法），用户级指令等于把动作执行权交给数据文件。这与 `docs/plugin-system-report.md` 的约束 B/C 一致；内置技能 / 内置提示那套「数据驱动、零 UI 扩展」可以，动作不行。
- **不动 CSP、不为指令单开 IPC**：`/compact` 需要的通道已经存在；层 1 一个 IPC 都不新增。
- **不把 Ctrl+K 搜索命令表一起重构**：可以后续合并，但先别把两件事捆在一个改动里。

---

## 5. 成本与影响面（文件级，便于估工）

| 交付物 | 新增 | 修改 | 主要风险 |
| --- | --- | --- | --- |
| 层 1 内置魔法提示 | `resources/prompts/*.md`（N 个）、可能一个 `prompts-catalog` 测试 | `resources.ts`、`resources.test.ts`、`runtime.ts`（目录 + allowedRoots）、`ipc/prompts.ts`、README | **漏 allowedRoots** → 静默 0 个内置提示（最容易踩）；打包后路径要用 `appPath` 注入而**不能 import electron**（照 `resolveBuiltinSkillDir` 的做法） |
| 层 2 指令机制 | `shared/contracts/commands.ts`、`features/chat/commands.ts` | `slash-commands.ts`、`SlashCommandMenu.tsx`、`Composer.tsx`、`OintRuntimeProvider.tsx`、两个语言包、两个测试文件 | **只拦一条发送路径** → 运行中指令被当文本发出；运行中可用性没声明 → 用户撞 `LaneBusy` 报错 |
| 层 3 参数 | — | `slash-commands.ts` + 测试 + 文档口径 | 与「模板无参数」的既有决定冲突，需要你先点头 |

---

## 6. 需要你拍板

1. **内置魔法提示首批名单**：我建议 `init` / `review` / `explain` / `fix-tests` 四个（先小后多）。要不要以别的为准？
2. **指令首批名单**：`/compact` 必做；`/new`、`/stop`、`/help` 要不要一起上？
3. **运行中敲 `/compact` 的行为**：菜单里直接隐藏 / 置灰并说明 / 允许排队等这一轮结束（内核会拒，需要额外做排队逻辑）。
4. **`/init` 放哪一层**：内置提示（推荐，零后端）还是指令（可做「已有 AGENTS.md 先确认」这类交互）？
5. **`/compact` 的位置**：只做斜杠命令，还是同时给一个显式按钮（例如上下文用量环旁边的菜单项，`Composer.tsx:634` 已有 `ContextMeter`）？

---

## 7. 附录 A：pi 引擎里已有的「指令」面（本次核实）

**一句话：pi 没有「斜杠命令」这个概念** —— 全部四个包（`pi-agent-core` / `pi-ai` / `pi-session-backend-sqlite-node` / `pi-telemetry`）里搜不到任何 `/` 解析、命令名表或内置命令（`/compact`、`/init`、`/help` 都不存在）。**但它把「指令」实现成了 lane 上的具名操作**，而且这套操作正是斜杠命令需要的底座。

`AgentLane`（`pi-agent-core/dist/harness/agent-harness.d.ts:636-675`）上与本议题相关的操作：

| 引擎操作 | 语义 | 相当于一条指令 | Oint 是否已用 |
| --- | --- | --- | --- |
| `prompt(text \| message, images)` | 发一条用户消息 | 普通发送 | ✅ `runtime.ts:2624` |
| `skill(name, additionalInstructions?)` | **按名调用技能**：内核把 `<skill name location>正文</skill>` 拼成一条 user 消息（`skills.js:8-11`）；名字不存在时**准入即失败**（`UnknownSkill`，`lane.js:355-367`） | `/技能名` | ❌ 未使用（`runtime.ts:857` 那句「由模型按需通过 lane.skill 读取」与实际不符：模型是用 `read` 工具读 `<location>`） |
| `promptFromTemplate(name, args?)` | **按名调用提示模板，带参数**：`formatPromptTemplateInvocation` → `substituteArgs` 支持 `$1` / `$@` / `$ARGUMENTS` / `${@:N}` / `${@:N:L}`（`prompt-templates.js:205-223`）；名字不存在 → `UnknownTemplate` | `/模板名 参数…` | ❌ 未使用（Oint 在渲染层自己展开，且刻意不支持参数） |
| `compact({customInstructions?})` | 压缩上下文（`NothingToCompact` 表示没东西可压） | `/compact [说明]` | ⚠️ 已接线、无入口（§2） |
| `navigateTree(targetId, {summarize?, label?, customInstructions?})` | 分支 / 回退，可顺带生成分支摘要 | `/branch`、`/rewind` | ✅ 用于重新生成与分支（`runtime.ts:2609`） |
| `resume()` | 续跑被挂起的操作（`NothingToResume`） | `/resume` | ❌ |
| `abort()` | 中止当前操作 | `/stop` | ✅（`runtime.ts:2868`） |
| `steer` / `followUp` / `nextRun` / `cancelQueued` | 运行中插话、排队、撤回 | `/steer`、`/queue` | ✅ 前三个（`runtime.ts:2917-2918`） |
| `setModel` / `setThinkingLevel` / `setActiveTools` / `setResources` / `setCompactionSettings` / `setSteeringMode` / `setFollowUpMode` / `setRetryPolicy` | 运行配置 | `/model`、`/think`、`/tools` | 部分（模型/思考档位） |
| `findEntry` / `getTipId` / `appendMessage` / `appendCustomEntry` / `recordUsage` | 会话读写与记账 | `/export`、`/pin` 之类的底座 | 部分 |

两个直接可用的设计红利：

1. **准入模型现成**。`accept()` 对整族操作返回带 tag 的错误：`LaneBusy` / `UnknownSkill` / `UnknownTemplate` / `NothingToCompact` / `NothingToResume` / `InvalidNavigation` / `UnknownTarget` / `InvalidMessage` / `Closed`（`result.d.ts`、`agent-harness.d.ts:83`）。指令系统要的「能不能执行、为什么不能」不用自己发明 —— Oint 现在只识别了其中的 `LaneBusy`（`runtime.ts:515-519`）。
2. **「模型看不见、但用户能从菜单调用」是内核的既定语义**：SKILL.md 的 `disable-model-invocation: true` 只把它从 `<available_skills>` 索引里摘掉（`system-prompt.js:2`），`resources.skills` 里仍在，因此 `lane.skill(name)` 照样能调用。这正是斜杠菜单想要的语义。

⚠️ 一处需要先对齐的冲突：Oint 自己的「禁用技能」（`settings.disabledSkillNames`）是在 `loadAgentResources` 里**直接从 `resources.skills` 过滤掉**的（`runtime.ts:916`），所以若把菜单改成走 `lane.skill()`，被禁用的技能会变成 `UnknownSkill` —— 与契约里写明的「禁用后仍可在斜杠菜单手动调用」（`shared/contracts/skills.ts:15`）直接冲突。要合并这两套语义，应改为「禁用 = 只从系统提示索引里摘掉（等价于内核的 disableModelInvocation），仍留在 resources 里」。

结论对方案的修订：§4.2 的指令层**不需要自己实现技能的调用与模板的参数替换** —— 技能走 `lane.skill()`、模板走 `lane.promptFromTemplate(name, args)`、压缩走 `lane.compact()` 即可；应用侧只需负责「菜单里有什么、点了之后发哪个操作、失败怎么显示」。

---

## 8. 附录 B：DSH（DeepSeek Harness）的 `/` 命令子系统核实

核实对象：本机安装的 DSH Desktop `2.0.13`（`D:\DSH Desktop\resources\app`，随包只有 `lib/`，含 README 与实现）。结论：**DSH 把「斜杠命令」做成了一套完整的三层子系统**，与 §3 的判据（谁执行）完全一致，可以直接当设计参照。

### 8.1 三层结构

| 层 | 包 | 职责 |
| --- | --- | --- |
| 触发管线 | `dsh-client-ui-input-trigger` | 光标处 `/` 与 `@` 检测、分组候选菜单、键盘/指针选择、Tab 下钻、`aria-activedescendant`、把 pick 路由到已注册 source；空格/回车按注册序轮询 `matchSpace` / `matchEnter` 钩子（第一个非 undefined 者胜出） |
| 客户端命令面 | `dsh-client-ui-commands` | 在触发管线上注册 `trigger: "/"` 的 `command` source；会话级命令目录；三类派发；`popupSelect` / `action` 贡献与 `decorate`（给宿主命令挂裸调用弹窗）；模糊匹配（大小写不敏感的子序列，前缀优先） |
| 宿主命令注册表 | `dsh-commands` | `ctx.commands.register()`；按 agent 作用域（全局 + agent 私有，私有遮蔽同名全局）；执行、附件准入、取消、生命周期落盘 |

### 8.2 这个安装里实际存在的命令（`dsh-base` + `dsh-web-app` bundle 核实）

**宿主命令**（`ctx.commands.register`，会产生 `command/run` + `command/done` 日志事件）：

| 命令 | 描述 | 输入声明 | 包 |
| --- | --- | --- | --- |
| `/compact` | Compact older conversation history | 无参（带参数直接 `Usage: /compact (no arguments)`） | `dsh-command-compact` |
| `/export` | Download this Session log as a ZIP archive | 无参 | `dsh-session-log-export` |
| `/feedback` | record feedback about this session | `hint: <text>`，`recordInput: false` | `dsh-command-feedback` |
| `/goal` | set or view the goal for a long-running task | `hint: [<objective>\|clear\|edit <objective>\|pause\|resume]`，**接受附件** | `dsh-command-goal` |
| `/permission` | Switch the permission preset (sandbox mode + approval policy) | `hint: <preset>` | `dsh-permission-presets` |
| `/plan` | Enter or leave plan mode | `hint: [off\|message]`，**接受附件** | `dsh-plan-mode` |

**客户端贡献**（`ctx.commandUi`，在浏览器里派发，不经过宿主注册表）：

| 名称 | 种类 | 行为 |
| --- | --- | --- |
| `/model` | `popupSelect` | 打开模型选择弹窗（子智能体会话里不可用） |
| `/permission` | `decorate` + `popupSelect` | 裸 `/permission` 开弹窗，选中后回调宿主 `/permission <id>` |
| `/feedback` | `decorate` + `action` | 直接打开反馈弹窗 |
| `/` 技能组 | 独立 source（`trigger: "/"`, order 2） | 列出 `userInvocable` 的技能；**pick 只插入 `/<技能名> ` 文本** |

**`/` 菜单因此有两组**：`command`（上面的命令）与 `skill`（技能名）。

### 8.3 关键语义（逐项，可直接对照 Oint 的缺口）

1. **不产生模型消息**：命令行与结果都不进模型上下文（README 明说 token 影响为零、KV cache 零影响）。已注册命令**永不降级**为提示词。
2. **命令语法归属命令自己**：`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u` —— 名称之后**包括分隔空白在内**的全部字节都是 `rawInput`，解析由命令自己负责（`dsh-commands/lib/index.js:95-103`）。
3. **结果契约**：handler 返回 `{kind: 'success' | 'error', text}`；文本只在 UI 渲染。**错误结果保留 composer 草稿**，用户可直接改。
4. **生命周期落盘**：`command/run` 与 `command/done` 成对（`commandId`），只写日志、不包在轮次里；成功结果可用 `sourceEventSeq` 指向更早的权威领域事件；`recordInput: false` 用于「载荷已由领域事件持有」的命令，避免重复记录。
5. **两种作用域**：全局注册对所有 agent 生效；挂在 `agent.ctx` 下的插件注册的命令**只遮蔽该 agent 的同名全局命令**（`ScopedLayers`）。同层重名在注册时抛错；`commands/change` 通知运行中的适配器刷新发现结果。
6. **适配器三入口**：`execute(agent, line, attachments, signal)` / `list(agent)` / `find(agent, name)`；**语法无效或名称未知返回 `undefined`**，不执行也不写事件。
7. **附件是声明式的**：`input.attachments: true` 才收；图片走 base64、通用文件走上传凭证（命令提交不再读字节）；顺序按用户选择冻结。未声明却带附件 → 处理器运行前就以本地化 notice 拒绝（`"/{command} 不接受附件，请先移除附件"`），草稿与附件卡原位保留。
8. **取消是协作式的**：调用方 abort 后注册表停止等待；handler 忽略信号则外部副作用可能继续；取消或抛异常都以 `error` 记入 `command/done`。
9. **客户端三类派发**（`matchEnter` / `dispatch` 的决策表）：
   - `leadingInput`：宿主命令声明了 `input` → 菜单选择/空格后认领 `/name `，回车提交时把 `args` 交给 `command.execute`；
   - `popupSelect`：客户端贡献或装饰 → 打开会话级弹窗，选中后回调；
   - `action`：客户端贡献或装饰 → 立即执行；
   - 没有 `input` 的宿主裸命令 → 直接 `execute`（detached，结果走 notice）。
10. **健壮性细节**：会话级目录以 epoch 把关（被取代的旧拉取永不覆盖新结果）、`commands/change` 软失效、`connection/reset` 硬失效；`matchEnter` 强等目录预热，**预热失败即拒绝（不静默降级）**；`/name` 与技能手势在草稿里会被装饰成 token。
11. **技能走「手势」而不是命令**：`SKILL.md` 可用 `disable-model-invocation` 控制 `modelInvocable`，与 `userInvocable` 组成四象限（`{false,true}` = 只能从 `/` 菜单进）；菜单 pick 只插入文本 `/<技能名> `，提交后由宿主 `agent/pre-step` 钩子扫描 `(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)`，命中 `userInvocable` 技能就把正文作为**额外 user 消息**注入（`source.kind = "skill-invocation"`）。未命中的 `/xxx` 就只是普通消息。
12. **明确没有的东西**：没有 `/help`、`/init`、`/clear`；README 自陈「**仅支持非结构化文本输入** —— 表单、补全 schema 与类型化参数仍由各命令自行解析」。

`/compact` 的行为值得单独抄：无参数；没有可压缩历史 → `No compactable history yet.`；成功 → `Compacted N history items (~M tokens).`；把「正忙 / 历史已变 / 摘要失败 / 提交失败 / 持久化失败」逐条转成稳定的人话错误，而不是抛原始错误。

### 8.4 对 Oint 方案的修订建议

- **结构对得上**：Oint 现在缺的正是 DSH 的第 2、3 层（`/` 只有数据源，没有命令面与宿主注册表）。最小实现不必引入 cordis 或插件平面：`SlashCommand.kind: "command"` + 一张编译期注册表 + 两个拦截点即可覆盖 §4.2 的全部语义。
- **直接可抄的 5 条**：① 三类派发（有参命令 / 弹窗选择 / 立即动作）；② `decorate`（给宿主命令挂裸调用弹窗，而不是重注册）；③ `rawInput` 归命令自己解析；④ 附件声明式准入 + 拒绝保留草稿；⑤ 失败转人话（`/compact` 那张表就是模板）。
- **值得比 DSH 更进一步的一点**：内核已提供 `lane.skill()` / `lane.promptFromTemplate()`（§7），所以 Oint 不需要 DSH 那套「文本手势 + pre-step 注入」的迂回：菜单 pick 可以直接派发到具名操作，并在准入层拿到 `UnknownSkill` / `UnknownTemplate`。

---

## 附 C：证据索引

- 菜单数据流：`src/renderer/features/chat/use-slash-commands.ts:45-64`、`slash-commands.ts:24-30,43,51,100-174`、`SlashCommandMenu.tsx:80-110`、`Composer.tsx:649-744`
- 发送展开（两条路径）：`src/renderer/runtime/OintRuntimeProvider.tsx:36-47,85-92`、`src/renderer/features/chat/Composer.tsx:757-767`
- 提示模板目录解析（缺内置层）：`src/main/pisdk/resources.ts:83-89`、`src/main/pisdk/resources.test.ts:126`、`src/main/ipc/prompts.ts:62-70`
- 内置技能三层（对照物）：`src/main/pisdk/resources.ts:33-73`、`src/main/ipc/skills.ts:37-41,84-108`、`electron-builder.yml:13-18`
- 路径守卫：`src/main/pisdk/runtime.ts:1052-1072`
- 压缩链路：`src/shared/contracts/api.ts:103`、`src/preload/index.ts:49-50`、`src/main/ipc/chat.ts:53-59`、`src/main/pisdk/runtime.ts:2958-2966`、`src/renderer/stores/chat-store.ts:875-879,1055-1060`、`src/renderer/features/chat/ThreadToolbar.tsx`
- 压缩自动配置 / LaneBusy：`src/main/pisdk/runtime.ts:2193`、`:512-519`
- AGENTS.md：`src/main/ipc/agents.ts`、`src/main/pisdk/runtime.ts:821-822,869-870`
- 内核参数化模板助手：`node_modules/@earendil-works/pi-agent-core/dist/harness/prompt-templates.d.ts:43-48`
- 内核 lane 操作与准入错误：`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:48-84,636-675`、`dist/harness/result.d.ts`、`dist/harness/runtime/lane.js:355-380,884-904`
- 内核技能/模板调用语义：`dist/harness/skills.js:8-11,226-238`、`dist/harness/system-prompt.js:1-25`、`dist/harness/prompt-templates.js:175-223`
- Oint 的禁用技能语义冲突：`src/main/pisdk/runtime.ts:916`、`src/shared/contracts/skills.ts:15`
- 另一个「命令」概念：`src/renderer/features/search/SearchModal.tsx:39,204-213`
- DSH 命令面文档：`D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-commands\README.zh.md`、`dsh-client-ui-commands\README.zh.md`、`dsh-client-ui-input-trigger\README.zh.md`、`dsh-command-compact\README.zh.md`、`dsh-command-goal\README.zh.md`
- DSH 命令实现：`dsh-commands\lib\index.js:95-103,318-386`（语法与执行）、`dsh-command-compact\lib\index.js:20-80`（失败转人话）、`dsh-client-ui-commands\lib\client.js:485-493`（宿主机命令描述表）、`:530,662-810`（source 注册与 dispatch/matchSpace/matchEnter/execute）、`dsh-command-goal\lib\index.js:174-183`（带子命令与附件）
- DSH 挂载与版本：`dsh-base\cordis.patch.yml:286-326`、`dsh-web-app\cordis.patch.yml:286-343`、`D:\DSH Desktop\resources\app\package.json`（`2.0.13`）、`C:\Users\31645\.dsh\profiles\web\package.json`（profile bundles）
- DSH 技能手势 `agent/pre-step` 注入：`dsh-tool-skill\lib\index.js:167-202,373-394`、`dsh-skill\README.zh.md`（四象限调用策略）
- 扩展成本与约束参考：`docs/plugin-system-report.md:45-56,57-104`

---

## 附 D：落地记录（本文档写成之后的改动）

- **§4.1 层 1（内置魔法提示包）已落地**：`resources/prompts/*.md` 十个提示随包分发；
  `resolveBuiltinPromptDir` + `resolvePromptTemplateDirs(workingDir, appPath)` 三层；
  `sessionAllowedRoots` 已放行内置提示目录（本文档 §4.1 第 4 条点名的那个坑）；
  `ipc/prompts.ts` 的来源改按路径判定，内置不可改删；设置面板「系统」页签从此有内容
  （点开是只读查看器，想改就新建同名提示覆盖）。
  与它同批做的还有 **MCP 的系统预设层**（`src/shared/mcp/builtin-servers.ts`）。
  两层的完整规则、准入标准与验证入口见 **`docs/system-presets-layer.md`**。
