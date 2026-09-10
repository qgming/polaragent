---
feature: slim-refactor
status: in-progress
updated: 2026-09-10
branch: main
commits: # filled at delivery
---

# PolarAgent 精简重构：移除冗余功能 + 收窄到最小 Agent 工作台

## Report

(待交付时填写)

## [S1] Problem

PolarAgent 在对话 + 工具 + 模型路由这条核心闭环之外，累积了大量与产品定位冗余、或与 pisdk 能力重叠的自研功能与配置：

1. **点名可移除项**：知识库（knowledge）、定时任务（schedule）、i18n 国际化、网络搜索/网页读取（web-search/web-fetch）、图片生成（image-generation）、音频 ASR/TTS。
2. **激进精简项（用户追加）**：长期记忆（memory + auto-capture）、目标流程（goal supervisor/evaluator）、项目上下文（project conversations）、办公文档（office）、Widget 渲染、CLI 检测。
3. 这些功能的代码、IPC、UI、Store、内置资源、类型与默认配置、依赖（mammoth / pdfjs-dist / i18next / react-i18next 等）、初始化链（app-init）相互耦合，删除必须成套，否则留下死代码与漂移。

**既定方向（用户确认）**：
- 点名项与冗余项全部删除（"按我说的全删" + "激进精简一切冗余"）。
- 模型/认证/文生图层下沉 pisdk 原生 API（"全面改用 pisdk 原生"）。
- 会话持久化、compaction、分支、Skill、PromptTemplate、bash/read/write/edit 等 pisdk 自带能力作为新基线，保留。
- 直接在当前 main 分支推进，不建 worktree。

**调研结论（附证据）**：
- 模型层**已经**走 pisdk 原生：`src/ai/pi-models.ts`（createModels/createProvider）、`src/ai/providers.ts`（`@earendil-works/pi-ai/api/*` 的 stream/streamSimple）。本轮不是"接入"，而是清理自写残留 + 复用 pisdk 内置模型目录供 UI 展示。
- 网络搜索/图片/音频/知识库/记忆/目标/项目上下文均为应用层自研工具，pisdk 不提供，删除属于"删功能"。
- pisdk 可补充的"开箱即用"：`getBuiltinModels`（约 1400 静态模型目录）供 model 选择下拉；Image Modality（image input）保留为模型能力。文生图（image-generation 工具）按方向整体删除。

## [S2] Design

### S2.0 精简后基线（保留）

- **对话闭环**：assistant-ui Thread + `src/runtime/PolarAgentRuntimeProvider.tsx` → `chat-store` → `src/ai/agent.ts` promptAgent → `agent-manager` AgentHarness → pisdk（pi-ai 模型 + pi-agent-core 内核）。
- **工具**：system_info、文件操作（read/write/edit/list/move/copy/delete/search/create_directory）、run_bash、update_todos、ask_user、delegate_task（子代理）、list_skills/read_skill/read_skill_file/write_skill、MCP（builtin + custom）。
- **能力**：Browser Use、Computer Use、Markdown/公式/图表渲染、会话搜索（Stable `SessionSearchService` 是空接口，不阻塞）、electron-updater 应用更新。
- **pisdk 自带**：JSONL 会话持久化、compaction 摘要、分支 branch/fork、Skill 加载、PromptTemplate。

### S2.1 移除清单 —— 点名项

**知识库 knowledge：**
- `src/ai/tools/knowledge.ts`
- `src/lib/knowledge/`、`src/lib/document-reader.ts`、`src/lib/office.ts`（若仅被知识库/办公使用）
- `src/main/ipc/knowledge.ts`（整文件）、`src/main/index.ts` 移除 `registerKnowledge`
- `src/stores/knowledge-store.ts`
- `src/components/knowledge/`、`src/components/settings/KnowledgePanel.tsx`
- `src/pages/KnowledgePage.tsx`
- `preload` 的 `knowledge` 命名空间
- 依赖：`mammoth`、`pdfjs-dist`
- 引用清理：`app-init` 中 `loadKnowledgeBases`；`chat-store.selectThread` 中 `restoreThreadKnowledgeBaseIds`；`tool-permissions`/`agent-manager` 中 knowledgeBaseIds 相关（仅当结果为空可保留字段）。

**定时任务 schedule：**
- `src/ai/tools/schedule-task.ts`、`schedule-management.ts`、`background-tasks.ts`
- `src/lib/schedule/`、`src/lib/session/schedule.ts`
- `src/stores/schedule-store.ts`
- `src/components/schedule/`、`src/components/settings/panels/AutomationPanel.tsx`（定时部分）
- `src/pages/SchedulePage.tsx`
- `app-init` 的 `useScheduleStore.initialize()`、init 中的 schedule 初始化
- 无专有 npm 依赖（运行时用 setTimout + fs IPC），仅删代码。

**i18n 国际化：**
- `src/i18n/**`、`src/hooks/useLanguage.ts`
- `Settings.appearance.language`（`src/types/config.ts`）、`PreferencesPanel.tsx` 语言项
- 依赖：`i18next`、`react-i18next`
- 全部 `useTranslation()` / `t("...")` 调用机械替换为**中文常量**（本产品定位中文 UI，固定中文）。

**网络搜索/网页读取：**
- `src/ai/tools/web-search.ts`、`web-fetch.ts`、`web-fetch-core.ts`
- `src/main/ipc/network.ts` 中 `webSearch` 及 tavily/exa/serper/searxng/brave 分支
- `src/components/settings/WebSearchPanel.tsx`、`web-search/`（5 个 ConfigCard）
- `WebSearchConfig`（`src/types/config.ts`）、相应默认值
- 无专有 npm 依赖（走主进程 net.fetch + IPC），仅删代码。

**图片生成：**
- `src/ai/tools/image-generation.ts`、`src/lib/image-params.ts`
- `src/main/ipc/network.ts` 中 `openaiImageEdit`、`downloadUrlAsBase64`（若仅被图片用）
- `src/components/settings/image/`、`ImageGenerationPanel.tsx`
- `ImageGenerationConfig`（config.ts）、相应默认值
- `image_generation` / `image_edit` 工具的 TOOL_REGISTRY / TOOL_CAPABILITIES 条目
- 说明：**图生文的 model `input:["text","image"]` 保留**（这是模型多模态能力，不是独立工具）；自研文生图工具整体删除。

**音频 ASR/TTS：**
- `src/ai/tools/audio.ts`、`src/ai/voice-text-refine.ts`
- `src/main/ipc/network.ts` 中 `openaiTranscription`、`openaiSpeech`、`mimoSpeech`
- `src/components/settings/audio/`、`AudioPanel.tsx`、`src/components/audio/AudioPlayerDialog.tsx`（若仅音频）
- `src/hooks/useAudioRecorder.ts`（若仅语音输入）
- `AudioConfig`（config.ts）、默认值；`asrAvailable`/`ttsAvailable` 辅助函数
- 无专有 npm 依赖，仅删代码。

### S2.2 移除清单 —— 激进精简项

**长期记忆 memory：**
- `src/ai/tools/memory.ts`、`src/ai/memory-capture.ts`
- `src/lib/memory/`、`src/main/ipc/memory.ts`（整文件）及 main/index 引用
- `src/stores/memory-store.ts`
- `src/components/settings/MemoryPanel.tsx`
- `MemoryConfig`（config.ts）与默认值
- 引用清理：`chat-store.finishAssistant` 中 `captureMemoriesFromExchange`；`agent-manager` 组装系统提示时的 memory block。

**目标 goal：**
- `src/ai/goal-supervisor.ts`、`src/ai/goal-evaluator.ts`
- `src/lib/goal/`、`src/lib/session/goal.ts`
- `src/stores/goal-store.ts`
- `src/components/goal/`
- 引用清理：`chat-store.selectThread` 中 `restoreGoalState`；`startExchange` 中 goal 相关。
- 注：goal 的"自动续跑"与 pisdk `AgentLane.steer/followUp` 重叠，删自研循环，未来如需续跑直接用 pisdk 队列机制。

**项目上下文 project：**
- `src/ai/tools/project-conversations.ts`
- `src/lib/session/project-context.ts`
- `src/stores/project/projects-store.ts`、`src/components/project/`、`ProjectEditorModal`
- `list_project_conversations` / `read_project_conversation` 工具条目
- `app-init` 中 `useProjectsStore.loadProjects()`；agent-manager 系统提示中 project block。
- 说明：工作目录/workingDir 保留（工具需要），仅删"项目历史会话上下文"这一应用层自研注入。

**办公文档 office：**
- `src/ai/tools/office.ts`（`create_office_document` 工具）
- `src/main/ipc/office.ts`（整文件）及 main/index 引用
- `src/main/lib/office.ts`（若仅被该工具用）与 session partition "polaragent-office"（若一并回退）
- 工具注册表 office 分组。

**Widget 渲染：**
- `src/ai/tools/widget-render.ts`（`render_widget`）
- `src/components/widget/`、`src/components/preview/`（若仅 widget）
- `render_widget` 工具条目与 widget 分组 / PolarDataUIs widget 注册（保留 guidance？按现状评估）

**CLI 检测：**
- `src/main/ipc/cli-detect.ts`（整文件）及 main/index 引用、`cli:detect` IPC。

### S2.3 pisdk 原生落地

**现状**（已基本就绪，本轮只补缺）：
- `pi-models.ts` / `providers.ts` 已是 pisdk 原生桥接 → 保留，做一次清理确认（去掉死亡分支）。
- 会话持久化 / compaction / skill / delegate_task 子代理已走 pisdk → 保留。

**本轮新增**：
- **内置模型目录供 UI 选择**：模型设置下拉改用 pisdk `getBuiltinModel(s)/getBuiltinModels()`（约 1400 模型，含 thinking/contextWindow）作为"从官方目录选模型"的选项源，减轻手填。
- **清理自研请求残留**：确认 `main/ipc/llm.ts` 的 OpenAI 兼容调用不再被模型链路引用（若仅被 image/audio 等已删功能使用则一并移除），模型流式统一走 pisdk providers 的 `stream`（经 `installIpcFetch` 出网）。
- **文生图**：按方向删除自研 image-generation 工具；不强引 pisdk createImagesModels（除非后续需要，此项列为非阻塞候选）。

### S2.4 组合清理（贯穿性）

- `src/ai/tools/index.ts`：TOOL_REGISTRY / TOOL_GROUPS / TOOL_CAPABILITIES / `summarizeToolResult` 死代码 全部按移除清单收缩。
- `src/types/config.ts`：移除 WebSearchConfig / ImageGenerationConfig / AudioConfig / KnowledgeConfig / MemoryConfig / automation.schedule 相关 / Appearance.language；同步 `src/config/defaults.ts`。
- `src/lib/app-init.ts`：初始化链去掉 knowledge/schedule/projects/(若 project 删) 初始化。
- `src/stores/tools-store.ts` 的 `isBuiltinToolEnabled` 白名单：自动覆盖（工具目录收缩后 disabledTools 默认集随之调整，需确认无残留工具引用）。
- `Package.json`：移除 mammoth / pdfjs-dist / i18next / react-i18next；`npm run sync:builtin` 丢弃相关内置 skill——**强依赖图片/视频生成的 seedance-prompt、gptimage2-prompt 等多模态 skill 一并移除（用户确认）**，保留纯开发辅助类 skill（taste、task-planning、document-writing 等）。
- `preload/index.ts`：移除 knowledge/memory（及 office 若删）命名空间，精简 contextBridge 面。
- 结果验收：`npm run typecheck` 全绿 且仓库内 grep 无被删符号残留。

## [S3] Out of Scope

- 不重写 pisdk 内部（session/compaction/skill/PromptTemplate 实现不动）。
- 不迁移/保留旧用户数据（已建的 knowledge 库、schedule 任务、记忆等磁盘文件保留但运行时不再读取；不自动删除用户文件）。
- 不做 UI 重构（assistant-ui 布局不比改）；Chromium 主进程架构不变。
- 非必要不引入新依赖；Bundle 体积优化不在本轮（已由 deep-optimize 覆盖）。
- Browser Use / Computer Use / MCP / 技能系统 / 应用更新 / Markdown 渲染 保持现状，不做功能增改。

## Tasks

- [ ] P1: 卸载依赖 + 删除点名项静态资源与页面（knowledge/schedule） — acceptance: `npm run typecheck` 通过；仓库无 knowledge/schedule 页面与 store 引用 (covers: S2.1)
- [ ] P2: 删除 i18n 并全局机械替换为中文 — acceptance: 无 `useTranslation`/`t(` 引用；`npm run typecheck` 通过 (covers: S2.1)
- [ ] P3: 删除网络搜索/网页读取 — acceptance: 无 web-search/web-fetch 工具与 network.ts webSearch 分支；typecheck 通过 (covers: S2.1)
- [ ] P4: 删除图片生成与音频 ASR/TTS — acceptance: 无 image-generation/audio 工具与 network 对应分支；typecheck 通过 (covers: S2.1)
- [ ] P5: 删除激进精简项（memory/goal/project/office/widget/cli-detect） — acceptance: 对应工具/IPC/store/组件/初始化调用全部移除；typecheck 通过 (covers: S2.2; depends: P4)
- [ ] P6: 工具注册表/config 类型与默认值/初始化链 组合清理 — acceptance: TOOL_REGISTRY/TOOL_GROUPS/TOOL_CAPABILITIES/`summarizeToolResult`/config.ts/defaults/app-init 无残留；typecheck 通过 (covers: S2.4; depends: P1-P5)
- [ ] P7: pisdk 原生落地（模型目录 UI + 自研请求残留清理 + 内置 skill 评估） — acceptance: 模型设置可用 pisdk 内置模型目录；无残留 self-help 请求层引用；`sync:builtin` 精简 (covers: S2.3; depends: P6)
- [ ] P8: 全量验证 — acceptance: `npm run typecheck` / `npm run test` / `npm run build` 全绿，并记录结果 (covers: S2.0-S2.4; depends: P7)
