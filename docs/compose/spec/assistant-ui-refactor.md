---
feature: assistant-ui-refactor
status: delivered
updated: 2026-03-09
branch: main
commits: 6985669..working-tree
---

# PolarAgent × assistant-ui 全面重构

## Report

**What was built** — 将 PolarAgent 聊天 UI 从自研组件切换为 assistant-ui：安装 `@assistant-ui/react@0.15` / `react-markdown` / `tw-shimmer` 与 shadcn 基础件；Elements 落位 `src/components/assistant-ui/elements/`。消息模型废弃 Segment，改为 `ChatMessagePart[]`（text / reasoning / tool-call / data-polar-widget / data-polar-guidance），`extractMessageParts` 在 pi-sdk 边界产出。`PolarAgentRuntimeProvider` 用 ExternalStoreRuntime 桥接 zustand chat-store 与 `promptAgent`（AgentHarness），实现 onNew / onCancel / onReload（截断重生成）/ onEdit（store 已接，UI 入口暂关）。ChatPage 使用 `Thread`；AppSidebar 使用 `ThreadList` 并经 `nav-bridge` 驱动页面导航。Composer 扩展条保留工作目录 / 技能 `/` / 附加文件。`PolarDataUIs` 注册 widget 与 guidance 渲染。删除 MessageRenderer、AgentTrace、ComposerToolbar、HomePage、WidgetRenderer、旧 SkillComposerInput 等。

**Verification** — `npm run typecheck` PASS；`npm test` PASS（3 files / 23 tests）；`npm run build` PASS。独立 Review 首轮 FAIL（5 critical），修复后复审 PASS（C1–C5、M4 均 FIXED）。

**Journey log** —
1. ExternalStore 优于 LocalRuntime：多会话后台并行是产品核心，assistant-ui 单线程 LocalRuntime 无法自然表达。
2. 未提供 onEdit/onArchive 时 UI 仍渲染按钮，点击会 throw——必须成对实现或隐藏。
3. `data-<name>` part 会转成 `{type:\"data\", name}`，DataUI 注册名必须去掉 `data-` 前缀。
4. Reload 正确姿势：`truncateFrom`（含用户消息）+ `appendAssistantPlaceholder`，绝不能再 `startExchange`（会重复用户消息）。
5. tool-call 已完成但 result 为空时仍须写入 `result`（空串），否则 aui 继承 message.status 持续 spinner。

## [S1] Problem

PolarAgent 的聊天 UI（`ChatPage`、`MessageRenderer`、`ComposerToolbar`、`AppSidebar` 会话列表等）全部是自研组件，维护成本高，交互细节（分支、编辑、重生成、附件、思考折叠、工具折叠、ActionBar）需要逐一手写。项目已有 shadcn 基础组件，但未接入 assistant-ui 的 Runtime 与 Elements。

目标：以 **assistant-ui** 作为 UI 层核心，以 **@earendil-works/pi-agent-core / pi-ai（pi-sdk）** 作为 Agent 内核，一次切换完成聊天界面替换与配套页 shadcn 化；不兼容旧消息数据，优先性能、流畅度与架构清晰度。

## [S2] Design

### S2.1 分层架构

```
┌──────────────────────────────────────────────────────┐
│ UI 层（assistant-ui Elements + shadcn）               │
│  Thread / ThreadList / Composer / ActionBar           │
│  MarkdownText / Reasoning / ToolFallback / Attachment │
├──────────────────────────────────────────────────────┤
│ Runtime 桥接层                                        │
│  PolarAgentRuntimeProvider（ExternalStoreRuntime）    │
│  ChatMessage ⇄ ThreadMessageLike 转换                 │
├──────────────────────────────────────────────────────┤
│ 状态层（zustand）                                     │
│  chat-store（按 aui 消息模型重设计）                   │
│  thread-list adapter（多会话 / 后台并行）              │
├──────────────────────────────────────────────────────┤
│ Agent 内核（pi-sdk）                                  │
│  AgentHarness per thread                              │
│  tools / MCP / skills / permissions                   │
├──────────────────────────────────────────────────────┤
│ Electron Main / Preload（保持不变）                    │
└──────────────────────────────────────────────────────┘
```

### S2.2 Runtime 选型

采用 **`useExternalStoreRuntime`**，理由：

1. PolarAgent 核心能力是多会话后台并行运行；LocalRuntime 面向单线程，无法自然表达。
2. 现有 zustand + 会话磁盘持久化可保留并重设计，不必推倒 Electron 侧存储。
3. 性能：消息以 assistant-ui 原生 parts 存储，渲染路径零二次转换；selector 订阅保持 per-thread 隔离。
4. 清晰度：UI 只依赖 assistant-ui runtime context；pi-sdk 只出现在 onNew / onReload / onCancel 等回调里。

不兼容旧数据：旧 `Segment` 模型废弃，会话历史可读性降级或丢弃（用户已确认）。

### S2.3 消息模型（对齐 assistant-ui MessagePart）

废弃自定义 `Segment`，改为 assistant-ui 兼容 parts：

| 旧 Segment | 新 MessagePart |
| --- | --- |
| `text` | `{ type: "text", text }` |
| `thinking` | `{ type: "reasoning", text }` |
| `tool` | `{ type: "tool-call", toolCallId, toolName, args, result, state }` |
| `widget` | `{ type: "data-polar-widget", data: { widgetId, title, html, ... } }` |
| `guidance` | `{ type: "text", text }` + metadata（或 data part） |

`ChatMessage` 简化为：

```ts
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  status: "complete" | "running" | "incomplete" | "error";
  content: MessagePart[];      // assistant-ui 原生 parts
  attachments?: CompleteAttachment[];
  metadata?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextTokens?: number;
    skillRefs?: ChatSkillRef[];
    error?: string;
  };
}
```

`convertMessage` 几乎恒等（role/content/id/createdAt/status），避免每帧映射开销。

### S2.4 多会话与 ThreadList

- 使用 `ExternalStoreThreadListAdapter`：`threadIds` / `getState(threadId)` / `onSwitchTo` / `onRename` / `onDelete` / `onCreate`。
- `chat-store` 继续持有 `threads: ChatThread[]`、`activeThreadId`、`runningThreadIds`。
- 侧边栏会话列表替换为 `ThreadList`；项目分组、导航入口保留在侧边栏自定义区域。
- 后台并行：切换会话不中止运行中的 harness；`isRunning` 按 threadId 维度映射到 adapter。

### S2.5 pi-sdk 桥接

`onNew` 流程：

1. 将 `AppendMessage` 写入当前 thread 的 messages（用户消息 + 空 assistant 占位）。
2. 调用既有 `promptAgent` / `AgentHarness.prompt`，把 `onStreamUpdate` 写回该 assistant message 的 parts（text / reasoning / tool-call 原地更新）。
3. `onDone` 写入 usage metadata、`status: "complete"`；`onError` 写 `status: "error"`。

`onCancel` → `abortAgentThread(threadId)`。

`onReload` → 从 parent 消息截断后重新 `promptAgent`。

`onEdit` → 截断到该用户消息并替换文本后重新生成。

工具流式状态映射：

| pi 事件 | tool-call state |
| --- | --- |
| `tool_execution_start` | `{ status: "running" }` |
| `tool_execution_update` | args/result 增量 |
| `tool_execution_end` | `{ status: "complete" \| "error", result }` |

### S2.6 聊天界面替换

| 现有 | 替换为 |
| --- | --- |
| `ChatPage` 骨架 | `Thread`（`thread.aui.tsx`）+ 右侧 TaskMonitor 面板保留 |
| `MessageRenderer` | `Thread` 内置 Message + 自定义 Tool UI |
| `AgentTrace` / ToolSteps | `ToolFallback` + 按 toolName 注册的 renderer |
| `MarkdownContent` | `MarkdownText`（可按需接 streamdown/mermaid/katex） |
| `ComposerToolbar` + `SkillComposerInput` | Composer 附件/斜杠/自定义 actions 槽位 |
| `AppSidebar` 会话列表 | `ThreadList` |
| `HomePage` 空态 | `Thread` Welcome / Suggestions |

Electron 专属能力以 Composer 扩展保留，不塞进 assistant-ui 默认实现：

- 工作目录选择（`pickWorkingDirectory`）
- 技能 `/` 选择（写入发送上下文，UI 显示 chip）
- 知识库选择
- 权限模式菜单
- 语音输入（`useAudioRecorder`）
- 附件（映射到 `AttachmentAdapter`）

### S2.7 配套页 shadcn 化

在同一次切换内，将以下页面/组件的自定义样式控件替换为 shadcn 原语（Button/Dialog/Table/Card/Tabs/Form/Input/Select 等），视觉语言与聊天区一致：

- `HomePage`、`KnowledgePage`、`SkillsPage`、`ToolsPage`、`SchedulePage`
- `SettingsModal`、`ProjectEditorModal`、`AskUserModal`
- `AppSidebar` 导航骨架（非会话列表部分）
- `ContentTopBar`、`GlobalSessionSearch`、`Toast`

不要求像素级重绘，要求：统一 token、统一控件来源、删除重复自实现。

### S2.8 清理范围

删除或归档不再被引用的自定义聊天组件：

- `src/components/chat/MessageRenderer.tsx`
- `src/components/chat/AgentTrace.tsx`
- `src/components/chat/ComposerToolbar.tsx`（若逻辑已迁入 Composer 扩展）
- `src/lib/chat/types.ts` 中的 `Segment` 及相关联合类型
- 旧 `MarkdownContent` 专用路径（若完全由 `MarkdownText` 接管）
- 无引用的 `animate-ui` 局部组件、重复 modal/toast 实现

保留：Electron IPC、pi-sdk tools、MCP、技能加载、知识库后端、定时任务后端、Computer Use / Browser Use 工具实现。只换 UI 与消息桥接。

### S2.9 依赖与目录约定

已安装：

- `@assistant-ui/react@0.15.x`、`@assistant-ui/react-markdown`、`tw-shimmer`
- shadcn：`button` `skeleton` `dialog` `tooltip` `avatar` `collapsible` `textarea` `input` `scroll-area` `separator`
- Elements 落位：`src/components/assistant-ui/elements/`（thread、thread-list、attachment、reasoning、tool-fallback、tool-group、markdown-text、follow-up-suggestions、tooltip-icon-button、file、image）

`components.json` 已注册 `@assistant-ui` registry。

自定义扩展与官方 elements 分离：

```
src/components/assistant-ui/
  elements/          # 官方 registry 安装件（可升级覆盖）
  extensions/        # PolarAgent 自定义：工具 UI、Composer 槽、Welcome
src/runtime/         # ExternalStore 桥接、convert、thread-list adapter
```

## [S3] Out of Scope

- 不迁移 pi-sdk 到其他 Agent 框架。
- 不引入 Assistant Cloud / 云端线程同步。
- 不重写 Electron 主进程安全模型与 IPC。
- 不保证旧会话 JSON 历史 100% 可读。
- 不做像素级视觉重设计（以 assistant-ui 默认风格 + 现有 token 为主）。
- Computer Use / Browser Use / 知识库 / 定时任务的后端逻辑不改，只改其管理页 UI。

## Tasks

- [x] T1: 重设计消息模型与 chat-store — 以 MessagePart 为核心定义 ChatMessage/ChatThread，删除 Segment 联合类型；acceptance: `tsc --noEmit` 对新类型无错，旧 Segment 引用点全部改写或删除 (covers: S2.3)
- [x] T2: 实现 PolarAgentRuntimeProvider — ExternalStoreRuntime + threadList adapter + convertMessage + onNew/onCancel/onReload/onEdit 桥接 pi-sdk；acceptance: 最小 Thread 可发送并流式收到 assistant 回复 (covers: S2.2, S2.4, S2.5)
- [x] T3: 替换聊天主界面 — App/ChatPage 改用 `Thread`，接入自定义 Tool UI 与 Markdown；acceptance: 打开应用可见 assistant-ui Thread，历史会话可切换，流式/停止/工具折叠可用 (covers: S2.6)
- [x] T4: 替换侧边栏会话列表 — AppSidebar 接入 `ThreadList`，保留项目/导航；acceptance: 新建/切换/重命名/删除会话走 runtime adapter (covers: S2.4, S2.6)
- [x] T5: Composer 扩展 — 附件、技能 `/`、工作目录迁入扩展条；知识库/权限模式/语音暂缺；acceptance: 发送含附件/技能引用的消息可被 pi-sdk 正确接收 (covers: S2.6)
- [x] T6: 注册关键 Tool UI — 默认 ToolFallback + polar-widget/guidance DataUI；自定义工具卡片待后续；acceptance: 工具调用在消息内以折叠 UI 呈现状态与结果 (covers: S2.5, S2.6)
- [ ] T7: 配套页 shadcn 化 — 部分完成（沿用既有 shadcn）；像素级统一与 Home 删除后空态由 Thread Welcome 承担 (covers: S2.7)
- [x] T8: 清理废弃组件与死代码 — 删除 MessageRenderer/AgentTrace/旧 Composer 路径/Segment 类型及无引用文件；acceptance: `rg` 无对已删模块的 import，typecheck/build 通过 (covers: S2.8)
- [x] T9: 全量验证 — `npm run typecheck`、`npm test`、`npm run build` 全部通过；acceptance: 三条命令 PASS (covers: S2.1–S2.8)
- [x] T10: 独立 Review — 首轮 FAIL（5 critical）→ 修复 → 复审 PASS；acceptance: 无 critical 未修复项 (covers: S2.1–S2.8)
