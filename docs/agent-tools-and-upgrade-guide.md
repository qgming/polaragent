# Agent 内置工具与能力对照 · Oint 升级指南

> 调研对象：**Oint**（本项目，基于 pi/pisdk）、**pi**（`@earendil-works/pi-agent-core` 0.85.1）、
> **DeepSeek Harness**（`deepseek-ai/deepseek-harness`，基于 Cordis）、
> **opencode**（`anomalyco/opencode`）、**codex**（`openai/codex`）。
>
> 数据来源：本地 pi 源码 + 各开源仓库当前分支源码/文档。
> 结论只对"调研时点的仓库状态"负责。

---

## 摘要（TL;DR）

1. **Oint 的工具面是四者中最窄的**：只有 `bash`/`read`/`write`/`edit`，且是 pi 内核内置的全部工具。
2. **Oint 的技能（SKILL.md）实际未接入运行时**：`AgentHarness.create` 没有传 `resources`，
   技能只被扫描进设置面板展示，从未进入模型上下文。这是一个**确定性缺陷**，不是设计取舍。
   注意：即使补上 `resources` 也还不够——内核**不会**把技能注入模型上下文，必须自行调用
   `formatSkillsForSystemPrompt`（详见 §7.1 第 1 条）。
3. **Oint 的系统提示只有 3 条规则**，不含任何工具使用指导；而另外三者都把工具指导写进系统提示/工具描述。
4. 升级路径**不需要更换内核**：pi 的 `AgentHarnessTool` 契约允许 Oint 自建任意工具，
   技能与提示模板经 `resources` 注册。改动集中在 `src/main/pisdk/`。
5. **实施前请先读第七部分**：P1/P2 的自研工具路线与 `README` 的「工具固定为原生四件套」定位冲突
   需先决策（§7.4）；另有 5 处技术前提已经核验更正（§7.1）。

---

## 第一部分 · 四方内置工具清单

### 1.1 pi —— 4 个（Oint 的现状基线）

源码：`pi-agent-core/dist/harness/tools/`

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `bash` | `command`, `timeout?` | 一次性命令；`prepare` 回调可改 cwd/env |
| `read` | `path`, `offset?`, `limit?` | UTF-8 读取，支持图片（需 `imageProcessor`） |
| `write` | `path`, `content` | 全量写入 |
| `edit` | `path`, `edits[{oldText,newText}]` | 字面替换，返回 `diff`/`patch` details |

**pi 内核到此为止。** `glob`/`grep`/`todo`/`web`/`subagent`/`mcp` 全部**不在** pi 内，
需要应用自建。内核另提供的是**能力**而非工具：会话压缩、分支 fork、skills 加载、
prompt 模板加载、会话检索服务（`search/` 是服务接口，不是工具）。

### 1.2 DeepSeek Harness —— 工具最多、全部可插拔

源码：`packages/` 下各 `tool-*` 包。工具全部是独立插件，可单独启停。

| 类别 | 工具 / 包 | 说明 |
| --- | --- | --- |
| 文件读 | `tool-fs` → `read` | 带行号 + 分页页脚，`readLimit` 封顶 |
| 文件读（图） | `tool-fs` → `read_image` | PNG/JPEG/WebP/GIF，无扩展名按文件签名识别，自动降采样 |
| 文件写 | `tool-fs` → `write` | 原子写；配 `fs-observation-policy` 后**写前必须读过** |
| 文件改 | `tool-fs` → `edit` | `old_string`/`new_string`/`replace_all`，需唯一匹配 |
| 文件改（CC 风格） | `tool-str-replace-editor` → `str_replace_editor` | `view`/`create`/`str_replace`/`insert` 四合一，绝对路径 |
| 搜索 | `tool-fs-search` → `glob`, `grep` | 无需宿主装 `rg`，含隐藏/忽略文件，结果可 spill 落盘 |
| 终端 | `shell/tool-bash`, `tool-bash-persistent`, `tool-pwsh*` | 一次性 / 持久 shell；`run_in_background` |
| 终端 | `terminal/tool-terminal` | 持久交互式终端：open/send/read/signal/close/list |
| 任务清单 | `todo/tool-todo` | 结构化任务列表，跨轮次/重开会话存活 |
| 目标 | `goal/tool-goal` | 持久化长期目标，read/infer/create/pause/resume |
| 计划 | `plan/plan-mode` | `/plan` 进入规划模式，产出计划待审批 |
| 子代理 | `subagent/tool-subagent`, `tool-subagent-control` | one-shot / continuable 两种模式 |
| 后台作业 | `jobs/tool-jobs` → `job_output`/`job_list`/`job_kill` | 统一操作后台命令、PTY、子代理 |
| 工作流 | `workflow/tool-workflow`, `tool-ralph` | 用 JS 脚本编排大量子代理 |
| 技能 | `skill/tool-skill` | 会话内发现 + 加载 SKILL.md，用户可用 `/name` 调用 |
| 代码智能 | `lsp/tool-lsp` | 跳转定义、引用、实现、hover（只读） |
| 网页 | `web/tool-web` → `web_search`, `web_fetch` | 多搜索后端（deepseek/exa/perplexity） |
| 会话检索 | `session-query/tool-session-query` | 跨会话搜索历史（5 个只读工具） |
| 人机交互 | `interaction/tool-ask-user` → `ask_user_question` | 中途向用户提问 |
| 代码运行 | `code-runtime` | 运行模型写的程序，隔离于会话 |
| 扩展 | `extensions/tool-cordis` | 让模型直接操作 Cordis 插件树 |
| MCP | `mcp/mcp-client` | 外部 MCP server 工具以 `mcp__<server>__<tool>` 暴露 |
| 代理团队 | `experimental/tool-agent-team` | 多代理协作 |

**横切能力（非工具）**：`guard/repeat-tool-reminder`（重复调用提醒）、
`guard/timeout-policy`（工具超时）、`spill`（超长输出落盘可回取）、
`context/*`（注入时间 / tmux / 文件引用 / 会话引用 / agent 指令）、
`compaction/*`（压缩 + 工具结果剪枝）。

### 1.3 opencode —— 中等规模，终端导向

源码：`packages/opencode/src/tool/`（每工具配 `.txt` 描述）

| 工具 | 说明 |
| --- | --- |
| `read` | 默认 2000 行，`offset` 翻页 |
| `write` / `edit` | 两者都**强制先 Read**，否则报错 |
| `apply_patch` | 结构化补丁语言（`*** Begin Patch` … `*** End Patch`） |
| `shell` | 命令执行 |
| `glob` / `grep` | 文件发现 / 内容搜索（grep 建议大范围内用 `rg`） |
| `lsp` | goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol |
| `webfetch` / `websearch` | 抓页 / 联网搜索（可配 live crawling） |
| `task` | **子代理**：`subagent_type` 选择代理类型 |
| `todowrite` | 结构化任务列表（3+ 步时主动使用） |
| `skill` | 加载系统提示里列出的技能 |
| `question` | 向用户提问（可选项可自定义） |
| `plan-enter` / `plan-exit` | 建议切换到 plan / build 代理 |
| `code-mode` / `invalid` | 代码模式 / 非法调用兜底 |

### 1.4 codex —— Rust 实现，能力偏"运行时控制"

源码：`codex-rs/core/src/tools/handlers/`

| 工具 | 说明 |
| --- | --- |
| `exec_command` | 统一命令执行（unified exec） |
| `write_stdin` | 向运行中的进程写 stdin |
| `apply_patch` | 补丁语言（lark grammar 约束） |
| `view_image` | 查看图片 |
| `update_plan` | TODO/checklist（Plan 模式下禁用） |
| `request_user_input` | 请求用户输入 |
| `request_permissions` | 主动申请提权（沙箱升级） |
| `mcp` + MCP resource 三件套 | MCP 工具调用 + 列出模板/资源/读资源 |
| `spawn_agent` / `send_input` / `send_message` | **多代理**协作 |
| `tool_search` | 工具检索（工具多了之后按需发现） |
| `get_context_remaining` / `new_context_window` | 上下文余量 / 开新窗口 |
| `current_time` / `sleep` / `wait_for_environment` | 时间与等待 |
| `send_message_to_user_async` | 异步给用户发消息 |
| 插件相关 | `list_available_plugins_to_install` / `request_plugin_install` |

### 1.5 并排对照

| 能力 | Oint(pi) | dsh | opencode | codex |
| --- | :---: | :---: | :---: | :---: |
| 读文件 | ✅ | ✅ | ✅ | ✅ |
| 读图片 | ⚙️ | ✅ | ➖ | ✅ |
| 写 / 编辑 | ✅ | ✅ | ✅ | ✅ |
| 补丁式编辑 | ❌ | ➖ | ✅ | ✅ |
| glob / grep | ❌ | ✅ | ✅ | ❌(走 shell) |
| 行号 + 分页 | ✅ | ✅ | ✅ | ✅ |
| 任务清单 todo | ❌ | ✅ | ✅ | ✅ |
| 计划模式 | ❌ | ✅ | ✅ | ✅ |
| 子代理 | ❌ | ✅ | ✅ | ✅ |
| 后台作业 | ❌ | ✅ | ⚙️ | ✅ |
| 持久终端 | ❌ | ✅ | ⚙️ | ✅ |
| 技能 | ⚠️未接入 | ✅ | ✅ | ⚙️ |
| LSP | ❌ | ✅ | ✅ | ❌ |
| 网页搜索/抓取 | ❌ | ✅ | ✅ | ⚙️ |
| MCP | ❌ | ✅ | ✅ | ✅ |
| 向用户提问 | ❌ | ✅ | ✅ | ✅ |
| 上下文余量查询 | ❌ | ⚙️ | ⚙️ | ✅ |
| 会话历史检索(工具) | ❌ | ✅ | ⚙️ | ❌ |
| 沙箱提权申请 | ❌ | ✅ | ⚙️ | ✅ |

图例：✅ 有 · ⚙️ 部分/需配置 · ➖ 不适用 · ❌ 无 · ⚠️ 有代码但未生效

---

## 第二部分 · 内置能力对照（非工具）

| 能力 | Oint(pi) | dsh | opencode | codex |
| --- | --- | --- | --- | --- |
| 上下文压缩 | ✅ pi 内置 | ✅ 可换策略 | ✅ | ✅ |
| 分支 / fork | ✅ pi 内置 | ✅ | ⚙️ | ➖ |
| 会话持久化 | ✅ SQLite | ✅ JSONL+zstd+世代迁移 | ✅ | ✅ |
| 技能 SKILL.md | ⚠️ 未注入 | ✅ | ✅ | ⚙️ |
| Prompt 模板 | ❌ 未接入 | ✅ | ✅ | ⚙️ |
| 项目指令 | ✅ AGENTS.md | ✅ agent-instructions | ✅ AGENTS.md | ✅ AGENTS.md |
| 上下文注入 | ❌ | ✅ 时间/tmux/文件/会话引用 | ⚙️ | ✅ |
| 权限/审批 | ✅ 3 模式 + AI 审批 | ✅ 沙箱 + 策略 + hooks | ✅ | ✅ 沙箱 + 提权 |
| 命令黑名单 | ✅ 正则 | ✅ sandbox policy | ⚙️ | ✅ sandbox |
| 重复调用防护 | ❌ | ✅ repeat-tool-reminder | ⚙️ | ⚙️ |
| 工具超时策略 | ❌ | ✅ timeout-policy | ✅ | ✅ |
| 超长输出落盘 | ❌ | ✅ spill | ✅ truncation-dir | ⚙️ |
| 遥测 | ❌ | ✅ OTel | ⚙️ | ⚙️ |
| 跨进程 RPC | ❌ | ✅ | ✅ | ➖ |

---

## 第三部分 · 五个关键设计差异

### 1. 工具粒度：固定数组 vs 可插拔插件
Oint 在 `AgentHarness.create({ tools: buildTools() })` **一次性注入固定数组**，
`setTools()` 从未被调用。dsh 每个工具是独立 `tool-*` 包，可单独启停、
可被上层配置 patch 掉。opencode/codex 在运行时有工具注册表 + 条件启用（如 Plan 模式禁用 `update_plan`）。

### 2. 编辑模型三流派
- **字面替换**（pi `edit`、dsh `edit`）：`old_string → new_string`，要求唯一匹配。
- **补丁语言**（codex / opencode `apply_patch`）：结构化 diff，适合跨文件原子改动。
- **四合一编辑器**（dsh `str_replace_editor`）：Claude Code 风格单工具。

Oint 只有第一种，且**没有工具层强制的 read-before-write 策略**（dsh 用 `fs-observation-policy`
强制先读）——系统提示第 1 条本身就是 read-before-write 指令（`runtime.ts:336`），只是无校验。

### 3. 搜索是不是一等公民
opencode/dsh 把 `glob`/`grep` 做成**独立工具**（给模型明确指引、结构化返回）。
Oint 只能靠 `bash` 跑 `rg`/`find` —— 模型得自己知道该这么做。
codex 也走 shell，但它把 shell 描述写得很详细。

### 4. 编排能力：单代理 vs 多代理
dsh（subagent/workflow/agent-team）、opencode（task）、codex（spawn_agent/multi_agents）
都支持**把任务委派给子代理**。Oint 没有——pi 内核也没有，但 pi 的 `lane()` 机制
（多 lane、分支、`navigateTree`）在架构上支持自建。

### 5. 观察式 vs 流水线式权限
Oint 的权限只挂在 `before_tool` 一个点上：
`assessToolRisk` → 规则库 → 审批卡 → block。
dsh 用 `tools/pre-execute`/`execute`/`post-execute` 三段 waterfall + 独立
`sandbox` 包 + 策略插件。Oint 的粒度较粗，但实现简单、易审计。

---

## 第四部分 · Oint 现状诊断

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 工具集 | 4 个 | `runtime.ts:876 tools: buildTools()`；`tools.ts` 只有 4 个 |
| 技能注入 | **未生效** | `grep -r resources src/main/pisdk/` 为空；`create` 未传 `resources` |
| 技能扫描 | 仅展示 | `ipc/skills.ts` 注释称"注入由 pisdk 完成"，但运行时无对应代码 |
| Prompt 模板 | 未接入 | 无 `loadPromptTemplates` 调用 |
| 系统提示 | 3 条规则 + AGENTS.md | `runtime.ts:330 buildSystemPrompt` |
| 工具指导 | 无 | 系统提示不含任何工具用法说明 |
| 动态工具开关 | 无 | `activeToolNames`/`setTools` 均未使用 |
| 工具 details | 已处理 | `message-mapper.ts:131` 保留 `details`，再由 `message-converter.ts:43` 映射进 assistant-ui 的 `artifact`；`tool-presentation.ts` 处理 `edit` 的 diff |
| 权限门 | 单点 | `runtime.ts:901 hooks.on("before_tool")` |

**结论**：Oint 在"外壳"层已经做得不错（diff 渲染、审批卡、技能管理 UI），
但**内核接口几乎没有被用起来**——`resources`、`setTools`、`activeToolNames` 全是空白。

---

## 第五部分 · 升级路线图

### P0 —— 修复"已建好但没接上"（低成本、高回报）

#### P0-1 接通技能注入 ★最高优先
技能 UI 已存在，但"只差把 `loadSkills` 的结果传给 harness"**不成立**（见 §7.1 第 1 条）：
`resources.skills` 只让 `lane.skill(name)` 能按名查到技能，内核**不会**把它注入模型上下文。
必须完成四步，缺一不可：

```ts
// src/main/pisdk/runtime.ts — createRuntime()
import {
  BACKGROUND_CONTEXT, formatSkillsForSystemPrompt, loadSkills, loadPromptTemplates,
} from "@earendil-works/pi-agent-core";

// 1) 加载（需要 ExecutionEnv，复用 createExecEnv 得到的 env）
const { skills, diagnostics } = await loadSkills(env, skillDirs, BACKGROUND_CONTEXT);
// 2) 过滤禁用项——disabledSkillNames 目前只影响设置面板展示
const enabled = skills.filter((s) => !settings.disabledSkillNames.includes(s.name));
const { promptTemplates } = await loadPromptTemplates(env, templateDirs, BACKGROUND_CONTEXT);

const created = await AgentHarness.create({
  // ...现有字段
  systemPrompt: await buildSystemPrompt(settings, cwd, formatSkillsForSystemPrompt(enabled)), // 3) 关键
  resources: { skills: enabled, promptTemplates },                                           // 4) 让 lane.skill() 可用
}, BACKGROUND_CONTEXT);
```

要点：
- **第 3 步才是"模型看得见技能"的那一步。** `formatSkillsForSystemPrompt` 是内核导出但
  **从不自己调用**的函数（`dist/harness/system-prompt.js:1`），输出 `<available_skills>`
  中 name / description / filePath 的紧凑索引。索引稳定不变，放在系统提示前缀里**不破坏缓存**；
  完整 SKILL.md 内容仍由模型按需通过 `lane.skill(name, instructions, context)` 读取。
- **不要**把 SKILL.md 全文拼进系统提示——那才是每轮重复、破坏缓存前缀。
- `loadSkills` 的第二个参数是目录（单值或数组），第三个参数是 `Context`（`BACKGROUND_CONTEXT`
  是 `EmptyContext` 单例，不是布尔开关）。缺 `description` 的技能会被**静默丢弃**，诊断只发
  warning 不抛错——排查"加载了但技能为 0"时先看 `diagnostics`。
- `Skill.disableModelInvocation` 的过滤由 `formatSkillsForSystemPrompt` 内部完成
  （`system-prompt.js:2`），不需要在这里额外处理。
- 技能目录计算现在独立写在 `ipc/skills.ts:13-27`，应抽成共享函数，避免两处漂移。
- 顺手删掉 `src/main/ipc/skills.ts:2` 那句与事实相反的注释。

#### P0-2 增强工具指导
对齐 dsh/opencode 的做法，但**比写系统提示更精准的做法是覆盖四个工具的 `description`**：
Oint 现在完全复用 pi 工厂，生效描述只有 127–326 字符的纯操作说明、零场景指导
（`dist/harness/tools/{bash,read,write,edit}.js`）。复用工厂后改写 `description` 字段即可，
既比系统提示更贴近工具定义，也不增加每轮提示长度。

系统提示侧（`runtime.ts:330 buildSystemPrompt`）补 `TOOL_GUIDANCE`：
- 改文件前必须 `read`；`edit` 需唯一匹配的 `oldText`。
- 搜索用 `bash` 跑 `rg`/`find`，不要用 `read` 全量读大文件。
- 工具输出超长会被截断（bash 截断为末 2000 行 / 50KB），优先抽样而非全量读取。
- 不要凭空编造工具执行结果。

**工作量**：小。**风险**：低（技能注入后会改变现有会话行为，建议加开关）。

---

### P1 —— 补齐 coding agent 的基础工具面

#### P1-1 新增 `grep` / `glob` 工具
dsh 的 `tool-fs-search` 不依赖宿主 `rg`；opencode 用 `rg`。
Oint 建议**自建**（避免依赖外部二进制），用 Node 实现：

```ts
// src/main/pisdk/tools/grep.ts
import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";

const grepSchema = Type.Object({
  pattern: Type.String(),
  include: Type.Optional(Type.String()),   // 如 "*.ts"
  limit: Type.Optional(Type.Number()),
});

export function createGrepTool(): AgentHarnessTool<ExecutionToolContext, typeof grepSchema> {
  return {
    name: "grep",
    description: "在工作目录内按正则搜索文件内容，返回 文件:行号:内容。大范围搜索优先用它而不是 bash。",
    parameters: grepSchema,
    async execute(_id, params, onUpdate, toolContext, _inv, _ctx) {
      // 1. 从 toolContext.env.cwd 出发遍历
      // 2. 用 path-guard.validatePathAccess 约束在 workdir 内
      // 3. 只读：无需走审批（permissions.ts 的 LOW_RISK_TOOLS 加 "grep"/"glob"）
      return { content: [{ type: "text", text: result }] };
    },
  };
}
```

配套改动：
- `permissions.ts:24`：`LOW_RISK_TOOLS` 目前**只有 `read`**，必须加入 `"grep"`、`"glob"`，
  否则每次搜索都弹审批卡。
- `tools.ts:27`：`buildTools()` 加入新工具。注意 `AgentHarnessTool` 必须有 `label` 字段，
  且 `execute` 返回的 `details` 不可选。
- 路径约束复用 `src/main/security/path-guard.ts` 的 `validatePathAccess`（已由 `exec-env.ts:137`
  调用），不要另写一套。
- 前端要改 4 处才能有渲染：`tool-presentation.ts:148`（`ToolDetail` 联合）、`:166`（硬门，
  新分支必须插在它之前）、`ToolParts.tsx:115`（`ResolvedDetail`）、`:35/:45`（图标与标签表）。

#### P1-2 新增 `todo` 工具
对齐 codex `update_plan` / opencode `todowrite`。这是**提升长任务质量最划算的一步**。

实现要点：
- 工具无副作用风险 → 加入 `LOW_RISK_TOOLS`。
- 状态需**跨轮次存活**，但原方案（`setMemo/getMemo` 或 `appendCustomEntry`）都不成立，见 §7.1 第 3 条。
  可行路线只有两条：
  1. **架构正确**：`lane.appendCustomEntry("todo", data, context)` 落进会话库，同时在内核注册
     `entryProjectors: { todo: ... }`，并给 `message-mapper.ts` 的 custom 丢弃逻辑开白名单、
     扩展 `SessionSnapshot` 契约。约动 5 个文件；好处是随会话持久化、重启可恢复。
  2. **最省事**：状态放主进程内存（按会话 id 索引）+ 现有 IPC 事件推给渲染层。
     工作量是上一条的零头，代价是应用重启后丢失。
  → 只有"重开也必须存活"是硬需求时才走路线 1。
- 前端 `todo-list.tsx` 已实现完整（84 行），但整条数据链上没有 todo 状态，接线不是一行的事（见 §7.2）。

**工作量**：中。**风险**：中（取决于选哪条持久化路线）。

---

### P2 —— 打开架构上限

#### P2-1 按模式动态启用工具
先按真实签名修正原示例（见 §7.1 第 4 条）：

```ts
// lane.d.ts: setActiveTools(activeToolNames: string[], context: Context): Promise<void>
await lane.setActiveTools(["read", "grep", "glob", "bash"], BACKGROUND_CONTEXT);
// 注意：工具本体仍须经 options.tools 注入；内置工具要求 toolContext 含 { env }
```

但**真正的瓶颈不在 `setActiveTools`，而在命令入口**：当前 `Composer.tsx:439-586` 的 chip 行
只有「附件 / 权限 / 模型 / 思考」，没有 slash 输入路径，`Settings` 里也没有模式字段。
所以 P2-1 的实际工作量在"做命令注册表 + 输入框 slash 触发 + 模式状态"，`setActiveTools` 只是最后一步。

好消息是 `elements/composer.tsx` 里 `useSlashMatches` / `ComposerMenu` / `ComposerCommandItem`
已经写好（又一个"已建好未接线"，见 §7.3），这是全线里最容易见效的一步。

#### P2-2 子代理（subagent）
pi 无内置 subagent，但 `AgentHarness` 支持多 lane：
- 简单版：`lane("sub")` 建独立 lane，用 `promptFromTemplate` 驱动，结果回填主 lane。
- 完整版：参照 dsh 的 `subagent` 包设计 one-shot / continuable 两种模式。

**前置**：需要解决子会话的 UI 展示。`subagent-list.tsx` **不是占位组件**，它是完整实现
（每代理进度条 + `aria-valuenow` + 汇总 shimmer），只是从未被挂载（见 §7.2）。

#### P2-3 MCP 接入
dsh（`mcp-client`）、opencode、codex 都支持。pi 无内置，需要：
- 实现 MCP client（stdio/SSE）
- 把 MCP 工具包装成 `AgentHarnessTool`，命名 `mcp__<server>__<tool>`
- 在 `before_tool` 权限门里对 MCP 工具按 `high` 风险兜底（现状 `assessToolRisk` 已经是
  未知工具返回 `high`，天然安全）

**工作量**：大。**风险**：中高（引入外部进程，需沙箱考量）。

**文档未提的前置阻塞**：`assessToolRisk` 对未知工具返回 `high` 虽然安全，但对 MCP 意味着
**每一次工具调用都会弹审批卡**，接完实际不可用。接 MCP 之前必须先设计"按 server 批量授权"
的规则模型（现有"始终允许"规则库按工具名精确匹配，需扩展到按 `mcp__<server>__` 前缀匹配），
否则这个功能做出来也没法用。

---

### P3 —— 长期方向

| 项 | 说明 |
| --- | --- |
| `apply_patch` 工具 | 跨文件原子编辑，对齐 codex/opencode |
| read-before-write 策略 | 对齐 dsh `fs-observation-policy`，防"盲改" |
| LSP 工具 | 对齐 dsh/opencode，精确符号导航 |
| 超长输出落盘 | 对齐 dsh `spill`，避免 bash 输出挤爆上下文 |
| 上下文注入 | 时间 / 文件引用 / 会话引用（dsh `context/*`） |
| 插拔式工具注册 | 若要做生态，参照 chord facet 把工具做成可配置项 |

---

## 第六部分 · 升级时的注意事项

1. **权限门必须先于工具更新**：任何新工具都要在 `permissions.ts` 里明确风险等级。
   当前默认策略是「未知工具 = high」，这是安全的，但会让新加的工具都弹审批卡——
   只读工具记得加进 `LOW_RISK_TOOLS`。
2. **工具描述要写"什么时候用"**：dsh/opencode 的工具描述都非常长且带反例
   （"什么时候**不**用它"）。Oint 目前工具描述空泛，会显著影响模型选工具的准确率。
3. **`resources` 与 `tools` 是两件事，但技能必须自己拼进系统提示**（原文此处有误，见 §7.1 第 1 条）：
   技能不是工具，走 `resources.skills`；工具走 `tools` 数组。但 `resources.skills` 只让
   `lane.skill(name)` 能按名查到技能，**内核不会把它注入模型上下文**——必须显式调用内核导出的
   `formatSkillsForSystemPrompt(skills)` 并拼进 `systemPrompt`。该函数只输出 `<available_skills>`
   的 name / description / filePath 紧凑索引（稳定不变，放前缀不破坏缓存），完整内容仍按需由
   `lane.skill()` 读取；`disableModelInvocation` 的过滤也在该函数内部完成。
   **不要**把 SKILL.md 全文拼进系统提示，那才是每轮重复。
4. **不要动 `compaction` 参数**：`reserveTokens`/`keepRecentTokens` 与工具输出体积强相关。
   加了 `grep`/`todo` 之后如果输出变大，需重新评估（当前 `runtime.ts:879` 为
   `reserveTokens: 20_000` / `keepRecentTokens: 40_000`）。
5. **pnpm/Node 版本无关**：Oint 保持 npm + Node 20+；dsh 要求 Node 22.19+ 和 pnpm 11。
   注意 `package.json` 目前没有 `engines` 字段，该要求在构建产物里无人强制。
6. **新工具要同时想清楚"状态放哪"**：内核的 `memo` 是调用内作用域、自定义 entry 默认对模型
   不可见（见 §7.1 第 3 条）。跨轮状态是每个新工具都要单独设计的问题，不要默认它存在。

---

## 第七部分 · 复核修正（源码核验结果）

> 本节由源码复核产生，修正前六部分中与 `pi-agent-core@0.85.1` 实际行为不符之处。
> 复核范围：`src/main/pisdk/`、`src/main/ipc/`、`src/main/security/`、`src/renderer/`、
> `node_modules/@earendil-works/pi-agent-core/dist/`。

### 7.1 必须修正的技术前提（否则会导致返工）

| # | 原稿位置 | 原稿说法 | 源码事实 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 第六部分 · 注意事项 3 | 技能走 `resources.skills`，"由 pi 在首轮请求前注入持久目录"；并告诫"不要自己把 SKILL.md 拼进 systemPrompt" | `resources.skills` 在内核里只有一处消费：`dist/harness/runtime/lane.js:356`，用于 `lane.skill(name)` 按名查找。`formatSkillsForSystemPrompt`（`dist/harness/system-prompt.js:1`）**内核从不调用** | 只加 `resources` 字段，模型仍看不到任何技能——P0-1 会白做 |
| 2 | P0-1 原注意第 3 条 | `disableModelInvocation` 让技能"不进模型列表" | 该过滤在 `formatSkillsForSystemPrompt` 内部（`system-prompt.js:2`）完成，不在 `resources` 层 | 同上 |
| 3 | P1-2 原实现要点 | todo 状态用 `setMemo/getMemo` 或 `appendCustomEntry` 跨轮存活 | `memo` 是**调用内**作用域，值在 operation 结束时删除（`dist/harness/runtime/drive/tools.js:37-83`）；`appendCustomEntry` 存在，但自定义 entry 默认对模型不可见（需注册 `entryProjectors`），且 Oint 自己在 `message-mapper.ts:138,154` 丢弃 `type !== "message"` 的条目 | 两个方案都不能直接用于跨轮持久化 |
| 4 | P2-1 原代码示例 | `await lane.setActiveTools(["read", ...])` | 真实签名是 `setActiveTools(activeToolNames: string[], context: Context): Promise<void>`（`lane.d.ts`），必须带尾参 `context`；且工具本体仍需经 `options.tools` 注入，内置工具要求 `toolContext` 含 `{ env }` | 示例编译不过 |
| 5 | 第四部分 · 权限门行 | 权限门在 `runtime.ts:874 hooks.on("before_tool")` | 实际注册在 `src/main/pisdk/runtime.ts:901`（874 是 `model,` 那行） | 仅行号错 |

第 1、4、5 条已就地改正；第 2、3 条的原文表述已从正文替换（详见 P0-1 与 P1-2）。

### 7.2 被低估的工作量

- **P1-1 配套改动**原写「为 `grep` 增加结果渲染（可选）」——不是可选。`tool-presentation.ts:166` 有硬门 `if (toolName !== "edit") return null;`，且 `ToolDetail`（`tool-presentation.ts:148`）与 `ResolvedDetail`（`ToolParts.tsx:115`）只认 `diff`/`terminal` 两种，`TOOL_ICONS`/`TOOL_LABELS`（`ToolParts.tsx:35,45`）也要加分支。
- **P1-2** 原写「前端已有 `todo-list.tsx`，直接接线」——组件确实存在（84 行、完整实现），但整条数据链上没有 todo 状态：`message-mapper` 只映射 message 与压缩摘要，`Thread.tsx:417` 的 `case "data"` 分支从未被产生。
- **P2-2** 原写「`subagent-list.tsx` 占位组件」——不准确，它是**完整实现**（每代理进度条 + `aria-valuenow` + 汇总 shimmer），准确说法是"已实现但从未挂载"。

### 7.3 已存在但文档未提的资产

- **`path-guard` 已存在且已接入**：`src/main/security/path-guard.ts` 导出 `normalizePath` / `isInsidePath` / `validatePathAccess`，由 `src/main/pisdk/exec-env.ts:137` 真实调用。新增文件类工具应复用它，不要另写一套。
- **死组件坟场**：`src/renderer/components/assistant-ui/elements/` 下有 20 个零引用文件——`todo-list`、`subagent-list`、`agent-plan`、`agent-status`、`context-breakdown`、`conversation-search`、`cost-meter`、`draft-restore`、`error-state`、`file-tree`、`message-actions`、`message-branches`、`message-queue`、`message-timing`、`permission-grant`、`prompt-library`、`reviewable-diff`、`stopped-run`、`composer.tsx`（整套 slash 菜单）、`tool-group.aui.tsx`。
  → **"技能未接通"不是孤立缺陷，而是同一模式的第 N 个实例：UI 先建、内核后接、然后断线。** P0 的正确目标不只是修好技能这一条线，还要建立"接不上就不合"的检查，否则 P1/P2 新增的工具会继续堆出第二个坟场。
- **`compaction` 实际值**：`runtime.ts:879` 为 `{ enabled: true, reserveTokens: 20_000, keepRecentTokens: 40_000 }`（内核默认是 16384 / 20000）。

### 7.4 与产品定位的冲突（需先决策）

`README.md:25-28` 明确写着「不自研工具与中间层，把 pisdk 的能力**原样呈现**」、「Agent 可见工具**固定**为 pisdk 原生四件套」。
本指南第三、四部分把"工具面最窄"当缺点，P1/P2 全是自研工具——这实质上是要求推翻该定位。
建议的折中：**不推翻，改为补充**——定位表述调整为「内核原生四件套 + 少量只读增强」。`grep`/`glob`/`todo` 这类纯只读、不引入新权力的工具符合"原样呈现"的精神；持久终端、代码执行、插件树操作等则明显越界。

### 7.5 工程现状（影响排期）

- **测试是 node 环境且只收 `src/**/*.test.ts`**（`vitest.config.ts:10-14`）→ **React 组件无法测试**，新增工具的 UI 部分只能靠 `scripts/e2e-smoke.mjs` 覆盖。
- `src/main/ipc/skills.ts` 目前**零测试**。
- `package.json` **没有 `engines` 字段**，「Node 20+」只写在 README 里，构建产物中无人强制。
- 复核时工作区有 34 个已修改文件与若干未跟踪路径（`docs/`、projects 特性整条链、`kernel-deps`、`ipc/handler.ts`），且刚完成 PolarAgent → Oint 改名——**建议先收成一个 commit 再改 pisdk**，否则后续问题难以二分。

---

## 附录 · 可直接复用的参考实现

| 需求 | 参考位置 |
| --- | --- |
| 无 `rg` 依赖的搜索工具 | dsh `packages/fs/tool-fs-search` |
| 文件工具 + read-before-write | dsh `packages/fs/tool-fs` + `fs-observation-policy` |
| 任务清单状态设计 | dsh `packages/todo/tool-todo`；codex `handlers/plan.rs` |
| 子代理两模式 | dsh `packages/subagent/tool-subagent` |
| MCP bridge | dsh `packages/mcp/mcp-client` |
| 工具描述写法 | opencode `*.txt`；codex `*_spec.rs` |
| 工具前置校验/超时 | dsh `packages/guard/timeout-policy` |
| 权限流水线 | dsh `docs/subsystems/tools.md` 的 `tools/pre-execute` |

---

## 变更记录

- 初版：四方工具/能力对照 + Oint 诊断 + P0–P3 路线图。
- 复核修正：源码核验（新增 §7）；修正 P0-1 技能注入前提、P1-2 状态持久化方案、P2-1 签名与命令入口瓶颈、权限门行号；补充死组件坟场、产品定位冲突与工程现状。
