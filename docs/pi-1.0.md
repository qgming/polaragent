# Pi 1.0.0 版本、API 调研与原生重构

调研日期：2026-10-02（北京时间）。依据 npm 正式发布元数据、tarball 的声明与实现，以及对应官方提交 `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。Context7 索引仍包含 0.87.1/0.99.0 内容，最终结论以 1.0.0 正式发布物为准。

本次按项目要求直接采用最新生态，**不兼容旧代码、旧会话数据库，不实现迁移层**。旧版文件不被导入或改写。应用功能以聊天、流式展示、权限、工具、附件、MCP、分支、压缩、队列、作业和子智能体为回归范围。

## 1. 确认的最新版本

| 包（`@earendil-works/`） | npm latest | 北京发布时间 | 本项目决策 |
| --- | --- | --- | --- |
| `pi-ai` | 1.0.0 | 10-02 03:12 | 直接依赖，精确固定 |
| `pi-durable` | 1.0.0 | 10-02 03:11 | 直接依赖，替代旧 harness / SQLite 后端 |
| `pi-mcp` | 1.0.0 | 10-02 03:11 | 直接依赖，替代自写 MCP 协议与传输 |
| `chord` | 1.0.0 | 10-02 03:12 | 直接依赖，使用 Context、取消和数据类型 |
| `pi-agent-core` | 1.0.0 | 10-02 03:10 | 不再依赖；其职责不再包含 durable harness |
| `pi-session-backend-sqlite-node` | 0.99.2 | 10-01 03:26 | 移除；没有 1.0.0，保留会拉入旧内核 |
| `pi-telemetry` | 1.0.0 | 10-02 03:12 | 由上游依赖链管理 |
| `pi-codemode` | 1.0.0 | 10-02 03:13 | 不需要为普通 MCP 接入而添加 |

运行要求为 **Node ≥22.19.0**；应用仍使用 Electron 44。TypeBox 与上游保持精确版本 **1.3.27**，没有为了“最新”而引入不同的 schema 类型版本。

权威元数据：[AI](https://registry.npmjs.org/@earendil-works%2fpi-ai)、[durable](https://registry.npmjs.org/@earendil-works%2fpi-durable)、[MCP](https://registry.npmjs.org/@earendil-works%2fpi-mcp)、[Chord](https://registry.npmjs.org/@earendil-works%2fchord)、[core](https://registry.npmjs.org/@earendil-works%2fpi-agent-core)、[旧 SQLite](https://registry.npmjs.org/@earendil-works%2fpi-session-backend-sqlite-node)。

## 2. 1.0.0 的架构断点

[core 官方变更记录](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/agent/CHANGELOG.md) 明确删除整个实验性 `AgentHarness`、lane、session/storage、harness tools、compaction、skills、prompt helpers 及 `./harness/*` 等子路径。`pi-agent-core` 现在聚焦 `Agent`、agent loop、proxy 和相关类型。

官方推荐持久化应用使用 [`pi-durable`](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md)。它仍明确标记为 **Experimental，API 可能随版本改变**；1.0.0 不代表这个新包承诺了稳定 API。项目因此固定精确版本，并使用真实原生集成测试约束升级。

新模型包含：

- `Harness`：一个存储实例与持久任务调度器。
- `Conversation`：可分支的不可变记录序列。
- `Entry`：`pi.user`、`pi.assistant`、`pi.tool-result`、`pi.system`、`pi.compaction` 等记录。
- `Document`：会话配置、当前任务、队列、用量及应用状态。
- `Task`：持久化执行状态；工具意图先提交，再产生外部副作用。
- `Submission`：输入或被动写入的持久化收据。
- `Registry` / extension：工具、提示段、hooks 与任务的进程内注册表。

新版 SQLite 使用 `conversations/entries/tasks/submissions/documents/document_revisions` 等表和数字 ID，与旧版库不兼容。这里直接创建新版数据库，不调用所谓旧库自动 migration。

## 3. 核心 API 的落点

| 旧调用 | 采用的新 API | 应用职责 |
| --- | --- | --- |
| `AgentHarness.create` | `Harness.open(storage, options, context)` | 每个打开的存储只允许一个 owner |
| `harness.lane` | `harness.root` / `harness.conversation` | 保存当前 conversation 选择 |
| `lane.prompt` | `conversation.submit`、`submission.wait` | 输入顺序、附件、UI 状态 |
| `steer` / `followUp` | `submit({whenBusy:"steer"/"followUp"})` | 队列展示使用 submission ID |
| `cancelQueued` | `harness.abortSubmission` | 限定所属 conversation |
| `lane.abort` | `conversation.abort` | 防止新发送与上一次停止竞争 |
| 模型、思考档位、工具白名单 | `conversation.configure` | 与设置及子智能体权限同步 |
| `harness.setTools` | 同名 `registry.install(defineExtension(...))` | 保留运行时空闲时整体刷新策略 |
| `before_tool` / `after_tool` | `hook(ToolTask,{beforeTool,afterTool})` | 插件限制、审批、重复调用保护 |
| `transform_context` | `hook(GenerationTask,{beforeRequest})` | 临时提示只影响本次模型请求 |
| 旧事件总线 | `watchEvents` | 提交批次、完整 snapshot、增量展示转换 |
| `navigateTree` | 原生 conversation fork + 当前指针事务更新 | 编辑重试不继续旧分支 |
| `lane.compact` | `conversation.compact` + task/submission 收据 | 区分完成、无须压缩、失败和取消 |
| 旧独立 SQLite 包 | `pi-durable/storage/sqlite/node` | 每个应用会话独立文件与删除生命周期 |
| 旧工具上下文参数 | `execute(args, api, context)` | `api.env/callId/output/details` |
| 旧 env 子路径 | `pi-durable/env`、`pi-durable/env/node` | 保留路径与子进程环境守卫 |

原生事件的 `message_update` 是结构化 `changes[]`；工具参数变更携带路径，不能当作 JSON 文本盲拼。工具运行输出还包含 `append/trimStart/set`，需先恢复保留窗口，再发送 UI 增量。`watchEvents` 初始和拥塞恢复都可能给完整 snapshot，不能只消费首次 snapshot。

原生 `NodeExecutionEnv` 新增 `id`、`truncateFile`、`flushFile`；路径方法继续经过应用守卫。工具默认不应声明 `replay:"safe"`，以免崩溃恢复时重新执行有副作用的外部调用。原生 durable `read` 暂不处理图片，应用的 `read_image` 保留。

应用自己的配置、命名、权限、附件与 UI 服务仍属于应用层；这不构成旧内核兼容层。

### 本次一并修正的行为和性能

- 分支复制引用的附件并重写路径；删除源会话后，分支附件仍可读取。
- 编辑重试采用原生历史 fork，随后重新应用当前模型、思考档位和工具权限，恢复截止点的待办状态。
- 无效重试不会停止现有事件观察器；停止操作可以取消尚在处理附件或读取设置的发送，避免停止后继续提交模型请求。
- 审批支持原生取消信号，取消期间不会迟到地创建审批卡片。
- 官方事件流的 `stop()` 不等待已执行中的监听回调；应用事件桥另外等待初始 snapshot、在途事件和可取消的压缩收据观察结束，避免关闭后读取数据库。
- 列表仅短暂读取会话元数据，不加载历史、不长期持有全部连接。最新分页查询 `limit + 1` 行；单条读取查询目标及前驱。正序分页与增量用量扫描共享按提交更新的历史缓存。
- 查询预算回归：140 条历史中，读取最新 10 条只查询 11 行；单条定位读取 2 行；首次正序建立缓存后，后续分页不再全量读取数据库。

## 4. MCP：由官方包接管协议

[`pi-mcp` 官方文档](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/mcp/README.md) 和正式声明确认：

```ts
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";

const client = new McpClient({ name: "oint", version: "0.1.0" });
await client.connect(new StreamableHttpTransport({ url, headers }));
const tools = await client.listTools({ signal, timeoutMs: 20_000 });
const result = await client.callTool(name, args, { signal, timeoutMs: 120_000 });
const content = toLlmContent(result);
await client.close();
```

### 已替换的本地实现

- 移除自写 JSON-RPC 编解码、请求 ID/pending map、NDJSON/SSE 分帧与网络传输。
- 原生 client 负责握手、协议版本协商、超时、分页、取消、进度与关闭。
- 原生 `StdioTransport` 负责启动、流解析、stderr、stdin 关闭、进程组终止。
- 原生 `StreamableHttpTransport` 负责 POST JSON/SSE、GET 服务端流、session/protocol headers、重连、恢复与会话删除。
- `toLlmContent` 负责文本/图片、嵌入资源、资源链接及 structured-only 结果转换。
- 订阅 `notifications/tools/list_changed`，合并并发刷新，更新应用缓存与工具注册。
- Chord 取消传递到原生请求的 `AbortSignal`；取消不伪装成成功工具文本。

### 保留的应用约束

- 系统预设 → 插件 → 用户配置优先级，用户配置整条覆盖。
- 每台服务仍只占一个 `mcp__<id>__call` 工具，`mcp_tools` 按需读取缓存 schema。
- 现有按 server 授权、插件声明权限、工具 details 和 UI 名称。
- `inheritEnv:false` 配合 `buildChildEnv`。仅传 `env` 不够，因为原生默认会合并父进程环境。
- Windows 启动参数策略保留；隐藏窗口与进程树清理由原生传输完成。
- 应用统一限制结果预算，防止按每个 content block 分别截断而使总量失控。

### 能力边界

默认协议版本为 `2025-11-25`，兼容服务器协商 `2025-06-18`、`2025-03-26`、`2024-11-05`。`listTools` 自动分页并检查 cursor 循环；应用另外按工具名去重。

原生包也提供 `listResources/listResourceTemplates/readResource`。当前产品以外部工具为主，没有因此新增资源浏览器。

**旧式 HTTP+SSE transport 不受支持**。Streamable HTTP 的 SSE 响应和 GET 流不是旧 `/sse` endpoint 协议。当前 Oint 配置只有 stdio/http，不增加伪装的 legacy adapter。

### OAuth 调研结论

`pi-mcp/oauth` 提供 `McpOAuthProvider`、`adaptOAuthProvider`、`OAuthCallbackServer`、`authorizeMcp`、`McpOAuthStateStore`，覆盖发现、PKCE、动态注册、token refresh、并发 401 合并与 insufficient_scope 升权。宿主负责浏览器、凭据保存和 UI。

1.0.0 加强 issuer 校验、scope 合并和 metadata URL 配置。回调中的 `iss` 必须传给 `authorizeMcp`；不可只照抄省略该字段的简短示例。状态需按 server identity 与 URL 隔离。

本次没有新增 OAuth 登录 UI；现有 HTTP headers 认证继续工作。OAuth、codemode 与 CLI 的 `registerMcpServer/tool_search` 不能误称为已集成产品能力。CLI 扩展 API 也不是 `pi-agent-core` 或 durable 的根导出。

## 5. pi-ai 的其他重要变化

参见 [AI 官方变更记录](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/ai/CHANGELOG.md)。

- 0.99.0 将图像和分类模型纳入统一 Models/Provider；旧 plural ImagesModels API 移除。
- `AnyModel`、`getModelType/isModelType`、`getModel(s)OfType`、`getAllModels/getAllAvailable`、`Models.generateImages/classify` 是新的多模型类型入口。
- 旧 `getModel/getModels` 仍只处理 chat 模型；不能把图像或分类模型直接送入聊天链路。
- 模型目录 schema 6 与 `*.all.json` 支持同 ID 不同模型类型；传统 keyed JSON 仍是 chat-only。
- 0.99.2 提供轻量 `/models` 入口。模型目录继续按需加载，避免主进程启动时加载全部 provider SDK。
- 新 `onProviderStreamEvent`、`AssistantMessage.thinkingLevel`、OpenAI 登录扩展与新的模型目录。
- 1.0 修复 OpenAI Responses 跨 provider grammar tool-call ID 回放，并更新 Anthropic 登录。

实测当前内置目录为 **42 个 provider / 1532 个 chat 模型**。数量来自原生枚举，不写死在业务逻辑中。

## 6. 验证与复现

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run probe:kernel
npm run pack
npm run probe:packaged
```

安装中遇到 npm 缓存的精简元数据未包含刚发布版本；官方完整元数据能确认包存在。使用 `npm install --full-metadata --prefer-online` 刷新后安装成功，没有改用旧版本。Windows 一次 lockfile 写入失败已通过正常重新生成 lockfile 修复。

`probe:kernel` 不依赖模型密钥；验证原生模型目录、文件读写/truncate/flush、SQLite commit/fork/reopen、MCP client/testing transport 的真实往返。

`probe:packaged` 必须存在真实 ASAR 和 Electron；核对四个直接核心依赖的 1.0.0 版本，并要求非内置模块从 `app.asar/node_modules` 解析。它不会回退到开发目录后宣称打包成功。

### 最终验证结果

| 检查 | 结果 |
| --- | --- |
| 依赖树 | `pi-ai/pi-durable/pi-mcp/chord` 精确 1.0.0；无旧 core / SQLite 后端 |
| `npm run typecheck` | 通过（也由最终 `npm run pack` 的 build 阶段执行） |
| `npm run lint` | 通过，560 个文件，无错误或警告 |
| `npm test -- --maxWorkers=4 --reporter=dot` | **2702 通过，18 跳过**；185 个测试文件通过，1 个跳过 |
| `npm run check:i18n` | 729 个中英文词条键一致 |
| `npm run check:unwired` | 无新增未接线组件、无失效白名单 |
| `npm run probe:kernel` | 4/4 通过 |
| `npm run pack` | 通过；`release/win-unpacked/Oint.exe` |
| `npm run probe:packaged` | 最终构建 4/4 通过；真实 Electron + ASAR，无开发目录回退 |
| 独立复核 | 分支附件、重试配置/待办、停止受理竞争、事件关闭、历史查询预算均完成修复与回归 |

原生行为测试使用真实 Harness/SQLite、可控模型流、真实子进程及本地 HTTP 服务，没有通过模拟旧 AgentHarness 来绕过新 API。未进行真实模型付费调用或 OAuth 交互登录；外部 MCP 预设联网测试默认跳过。
