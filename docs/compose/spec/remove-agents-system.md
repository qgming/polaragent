---
feature: remove-agents-system
status: delivered
updated: 2026-02-27
branch: main
commits: 1c1897f..HEAD
---

# 移除内置助手体系 · 全局 AGENTS.md · pi API 全面适配

## Report

**What was built** — 完全移除 PolarAgent 内置多助手体系：删除内置助手 JSON、助手广场、AgentsPage、输入框/会话头助手选择、`list_agents`、按已安装助手目标的 `delegate_task`、会话级 `agentId` 关联与 `AgentConfig` 驱动的模型路由。运行时简化为单一全局 AgentHarness，系统提示由「临时子代理委托块 + AGENTS.md + 项目提示词 + 技能清单 + 记忆」组装。

设置页新增「AGENTS.md」面板：可配置文件路径（默认 `{dataDir}/AGENTS.md`）、启用开关与内容编辑器；harness 创建时读取并注入系统提示，带 5s 内存缓存。

全部内置工具从旧 `AgentTool` 签名迁移为 pi-agent-core 0.85.1 原生 `AgentHarnessTool`：execute 签名为 `(toolCallId, params, onUpdate, toolContext, invocation, context)`，abort signal 取自 `context.abortSignal`，`toolContext` 由 harness 的 `toolContext` 选项注入。删除 `toHarnessTool` 兼容适配器与 0.84/0.85 兼容注释。

**Verification** — `npm run typecheck` PASS；`npm test` 23 tests PASS；`npm run build` PASS。独立审查后修复：子代理 `temporarySystemPrompt` 未注入系统提示（critical）、AGENTS.md IPC 相对路径解析、`start_background_task` 死 `agentId` 参数、教程/定时任务 i18n 助手残留文案。

**Journey log**
- 工具层从「工厂闭包捕获 ctx」改为「harness 注入 toolContext」是本次最大架构变化；`AgentHarnessOptions.toolContext` 是关键 API。
- 批量 codemod 改 tools 时曾误伤 `image-generation.ts` 尾部，typecheck 及时发现。
- `AgentTurnPayload.agentId` 在 types/schedule.ts 删除后，schedule-task / schedule-management 两处 payload 构造仍写该字段，需同步删除。
- 独立审查发现 `promptParts` 漏了 `subagentContext.systemPrompt`——`runtimeConfigSignature` 已计入签名说明本意要生效，静态拼装时遗漏。
- 用户选择不使用 worktree，直接在 main 上实施。

## [S1] Problem

PolarAgent 当前内置一整套多助手体系：内置助手 JSON、助手广场、AgentsPage、输入框/会话头助手选择、`list_agents`、按已安装助手目标的 `delegate_task`、会话级 `agentId` 关联，以及 `AgentConfig` 驱动的模型路由。这套体系：

1. 与产品新方向冲突——用户希望单一全局 Agent，用 AGENTS.md 表达全局指令。
2. 使系统提示构建过度耦合「助手清单」与「子代理目标选择」。
3. 与 pi 0.85.1 的 `AgentHarnessTool` 原生签名之间存在一层 `toHarnessTool` 兼容适配，工具仍停留在旧 `AgentTool.execute(toolCallId, params, signal?, onUpdate?)` 签名。

目标：删除整套助手体系与兼容层，改为单一全局运行时 + 设置页可配置的 AGENTS.md，工具层直接实现 pi 最新 API。

## [S2] Design

### S2.1 助手体系移除

**删除的资源与模块**

| 类别 | 路径 |
| --- | --- |
| 内置助手 JSON | `resources/builtin/agents/*` |
| 助手广场数据 | `resources/market/agents/*` |
| 助手页 | `src/pages/AgentsPage.tsx` |
| 助手编辑器 | `src/components/AgentEditorModal.tsx` |
| 助手广场 Store | `src/stores/agents-market-store.ts` |
| list_agents 工具 | `src/ai/tools/agents.ts` |
| 教程 AgentGuide | `src/components/tutorial/AgentGuide.tsx` |
| i18n agents 命名空间 | `src/i18n/locales/*/agents.json` |
| IPC 助手配置 | `config:read-agent` / `write-agent` / `delete-agent` / `list-agents` |
| IPC 助手广场 | `fetchAgentIndex` / `fetchAgentCategory` |
| 导航 agent 页 | `PageId` 去掉 `"agent"` |

**保留并简化的概念**

- `chat-store.activeAgentId` / `thread.agentId` / 会话 meta `agentId`：**全部删除**。会话不再关联助手。
- `config-store.agents`：**删除**。
- `AgentConfig` 类型：**删除**。
- `model-router`：去掉 `agentId` 参数，统一使用 `defaultProvider` / `defaultModel` 路由。
- `agent-manager`：简化为单一全局 harness 运行时，缓存键仅 `threadId`（子代理为 `subagent:sessionId`，定时任务为 `schedule:sessionId`）。
- `delegate_task`：仅保留 `temporaryAgentName` + `temporarySystemPrompt` 创建临时子代理；删除 `agentId` / `agentName` / `list_agents` 联动。
- 定时任务 payload：去掉 `agentId` 字段（历史任务忽略该字段）。
- 会话 preferences：不再读写 `agentId`。
- Skills / MCP / 知识库 / 记忆 / 项目 systemPrompt **保持不变**。

**系统提示构建（不再传助手）**

```
systemPrompt =
  [ 临时子代理委托块（仅 subagent 时） | 默认委托说明（仅主会话，说明 temporary 子代理） ]
  + AGENTS.md 内容
  + 项目 systemPrompt
  + 技能清单 block
  + 记忆 block
```

不再读取任何 `AgentConfig.systemPrompt` / 助手名称 / 已安装助手清单。

### S2.2 全局 AGENTS.md

**存储**

- 路径固定为 `{dataDir}/AGENTS.md`，始终启用，无 settings 配置项。
- `ensureDataDir` 首启时若文件不存在则写入默认内容（Cowork 风格的执行型协作伙伴提示词），已存在则不覆盖。

**设置页**

- Section `agentsMd`，图标 `FileText`，归入「通用」分组（`memory` 之后）。
- 面板组件 `AgentsMdPanel`：仅内容编辑器（Textarea + 保存按钮），无开关、无路径配置。

**注入时机**

- `agent-manager.createHarness` 时读取 AGENTS.md（带 5s 内存缓存，保存后失效）。
- 读取失败：返回空串，不阻塞 harness 创建。

**IPC**

- `config:read-agents-md` / `config:write-agents-md`：固定读写 `{dataDir}/AGENTS.md`，无 path 参数。

### S2.3 pi 0.85.1 原生 API 全面适配

**工具层**

- 所有内置工具从 `AgentTool<TParams>` 改为 `AgentHarnessTool<AgentToolContext, TParams, TDetails>`。
- 新签名：

```ts
execute(
  toolCallId: string,
  params: Static<TParameters>,
  onUpdate: AgentHarnessToolUpdateCallback<TDetails>,
  toolContext: AgentToolContext,
  invocation: AgentHarnessToolInvocation,
  context: Context,
): Promise<AgentToolResult<TDetails>>
```

- 取消：工厂闭包捕获 `ToolContext` 的模式改为由 harness 注入 `toolContext`。
- 取消：`toHarnessTool` 适配器。
- abort：使用 `context.abortSignal`，不再传 `signal` 参数。
- 工具注册表 `buildAgentTools` 返回 `AgentHarnessTool<AgentToolContext, ...>[]`。

**agent-manager**

- `AgentHarness.create({ tools, ... })` 直接收原生 `AgentHarnessTool`。
- 通过 `AgentHarness` 的 context source 注入 `AgentToolContext`（threadId、workingDir、permissionMode、skills、knowledgeBaseIds 等）。
- 删除 0.84/0.85 兼容注释与旧路径说明。

**model-router / pi-models**

- 保持 `createModels` / `createProvider` 桥接（已是 0.85 形态），仅去掉 agent 相关分支。

### S2.4 UI 变更

| 位置 | 变更 |
| --- | --- |
| HomePage 输入框下方 | 删除助手 Dropdown |
| ChatPage 会话头 | 删除助手 Dropdown |
| 侧边栏扩展组 | 移除「助手」入口 |
| Settings 导航 | 新增「AGENTS.md」 |
| Schedule 编辑器 | 移除助手选择 |
| App.tsx | 去掉 agents / activeAgentId / setThreadAgentId 传递 |

### S2.5 历史数据

- 已有会话 meta 中的 `agentId` 字段：读取时忽略，不再写回。
- 已有定时任务 payload 中的 `agentId`：忽略。
- `{dataDir}/agents/` 目录：启动时可不迁移（保留磁盘文件，运行时不再读取）。不自动删除用户数据。

## [S3] Out of Scope

- 不迁移/导入旧助手 systemPrompt 到 AGENTS.md（用户自行粘贴）。
- 不重写 pi Session / compaction / skill loader。
- 不改变工具权限链路（`before_tool` hook 逻辑保留）。
- 不删除 Skills 内置技能与 MCP 内置配置。
- 不做 Electron 主进程架构调整。
- 不引入新的子代理 UI。

## Tasks

- [ ] T1: 删除助手资源、页面、Store、IPC 与导航入口 — acceptance: 项目内无 AgentsPage/agents-market-store/builtin agents 引用；`npm run typecheck` 不因缺失模块失败 (covers: S2.1)
- [ ] T2: 移除 chat-store/config-store/会话 preferences/定时任务中的 agentId — acceptance: 类型与运行时不再出现 agentId；新建会话可正常发送 (covers: S2.1; depends: T1)
- [ ] T3: 简化 model-router 与 agent-manager 为单一全局运行时 — acceptance: promptAgent 不再接收 agentId；harness 缓存键仅会话维度 (covers: S2.1; depends: T2)
- [ ] T4: 简化 delegate_task 为临时子代理 only，删除 list_agents — acceptance: 工具注册表无 list_agents；delegate_task 仅 temporary 参数 (covers: S2.1; depends: T3)
- [ ] T5: 实现 AGENTS.md 配置（类型、默认值、IPC、设置面板、注入） — acceptance: 设置页可编辑/保存 AGENTS.md；系统提示包含其内容 (covers: S2.2)
- [ ] T6: 工具层改为 AgentHarnessTool 原生签名并删除 toHarnessTool — acceptance: 无 AgentTool.execute 旧签名；typecheck 通过 (covers: S2.3; depends: T3)
- [ ] T7: 清理 HomePage/ChatPage/Schedule/App 中的助手选择 UI — acceptance: 输入框与会话头无助手下拉；应用可启动 (covers: S2.4; depends: T1)
- [ ] T8: 清理 i18n、教程 AgentGuide、过时注释 — acceptance: 无 agents 命名空间引用 (covers: S2.1)
- [ ] T9: typecheck + build + vitest 全绿 — acceptance: `npm run typecheck` / `npm run build` / `npm test` 通过 (covers: S2.1 S2.2 S2.3 S2.4)
