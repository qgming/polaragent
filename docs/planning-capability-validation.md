# 计划通用能力重构：交付与验证

日期：2026-10-04。设计依据：[重构报告](./planning-capability-report.md)。使用说明：[目标与计划能力](./goal-plan-modes.md)。

## 已交付

- 仅保留智能体与编排两种工作方式；计划、目标、待办和委派均按需组合。默认方式直接完成任务，编排仅在独立子任务有收益时委派，不强制额外确认或重复清单。
- Plan 正文与历史版本原生持久化，支持查看、修改、归档和执行明确版本。移除旧计划模式、返回模式、文件路径/哈希及特殊读取通道，不迁移旧数据。
- 工作约束独立于计划存在与否。普通输入先登记待处理；模型消化已进入对话的输入后才能实施。自然语言限制由模型解释，结构化“新工作”和版本执行按钮提供明确的宿主控制，模型不能自行批准。
- 版本执行预留之后，批准、冻结正文、原生输入和 GenerationTask 在同一事务中受理。预留取消不留下授权；相同控制请求幂等重放，旧版本和未处理需求不能领取。
- 只读约束覆盖文件、任意 shell、未知 MCP、浏览器、插件钩子和后台启动。子任务在创建事务中保存父工作权限上限，当前约束继续收紧它；停止或收紧工作同时取消子任务及其后台作业。
- Goal 区分研究成果与实施成果：研究可在只读范围续行；实施需具备实施权限。人工暂停独立保持，用户输入优先，实际受理的自动轮次才计数。
- 界面原生渲染 Markdown、查看历史版本，并保留未发送草稿；状态区分仅方案、待确认、已开始和归档。工具记录使用工作状态、目标和方案的可读名称。

## 验收证据

| 要求 | 证据 |
| --- | --- |
| 两种方式均可规划、普通任务不多建目标 | `runtime.send.test.ts`、`agent-mode-prompt.test.ts`、`Composer.mode.test.tsx` |
| 原生正文、历史、陈旧版本、跨工作引用、模型不能自行批准 | `workflow-capability.test.ts` |
| 自然语言首条输入先阻止实施、只读与未知工具门禁、插件限制 | `runtime.send.test.ts` |
| 审批提交原子性、取消回滚、重复开始幂等 | `workflow-capability.test.ts`、`runtime.send.test.ts`、真实应用探针 |
| 研究/实施目标续行、额度、暂停、用户队列优先 | `runtime.send.test.ts` |
| 子任务权限持久化及重开 | `subagent-runner.test.ts`；`execution-policy.ts` 的权限交集 |
| 文档投影、重开、历史分支恢复与权限隔离 | `native-view.test.ts`、`workflow-capability.test.ts`、`runtime.send.test.ts` |
| 正文、历史、修订、归档、精确版本、草稿保留、新工作入口 | `Composer.mode.test.tsx` |
| 真实 preload/IPC、模型工具、原生状态、界面重载及版本执行 | `scripts/probe-planning-app.mjs`，已构建应用与 Windows 打包版均通过 |
| 普通文件路径边界仍有效 | `src/main/ipc/files.test.ts` |

最终检查：

- `npm test -- --reporter=dot`：196 个测试文件通过、1 个跳过；2550 项通过、18 项按现有配置跳过。
- `npm run build`：通过，包括渲染与 Electron TypeScript 检查、依赖检查、插件构建与生产资源构建。
- `npx electron-builder --dir`：通过，输出 `release/win-unpacked/Oint.exe`。
- `npm run check:i18n`：773 个引用词条在中英文中均存在。
- `npm run check:unwired`：新增未接线 0、失效白名单 0；17 项既有白名单保留。
- `npm run probe:packaged`：打包依赖、原生文件 API、SQLite 提交/fork/重开及 MCP 握手均通过。
- `node scripts/probe-planning-app.mjs` 与 `--packaged`：真实应用完成保存、重载查看、指定版本执行、冻结正文、重复请求幂等和不改变工作方式的闭环。
- Electron 视觉检查：卡片操作顺序、窄窗口无溢出、正文对话框、暂停和完成态均通过。

探针使用临时应用数据和本地确定性模型服务，不调用真实付费模型。它证明产品链路、权限与状态处理，不证明任意模型解释自然语言的准确率，也不宣称 token、延迟或任务成功率提升比例。原有可选联网测试保持跳过。

开发日志与截图位于 `.slim/deepwork/planning-*`。当前改动留在工作区，未创建提交；原有请求重试和文件查看改动保留。
