# 持久终端 / 后台作业 / 向用户提问 · 四方对照与 Oint 取舍

> 调研对象（源码均取自 2026-09 时点的远端默认分支）：
>
> | 项目 | 仓库 | 版本锚点 |
> | --- | --- | --- |
> | **Oint**（本仓库） | 本地 | `e1d2ce9`，内核 `@earendil-works/pi-agent-core@0.85.1` |
> | **dsh**（DeepSeek Harness） | `deepseek-ai/deepseek-harness` | `master` `c291e79` |
> | **opencode** | `sst/opencode` | `dev` `95daf90` |
> | **codex** | `openai/codex` | `main` `53c542d` |
>
> 与 `agent-tools-and-upgrade-guide.md` 的分工：那篇管**工具面总体**（grep/todo/MCP/子代理/技能）；
> 本文只回答三件事——**持久终端、后台作业、向用户提问**该不该做、怎么做。
> 那篇 §7.4 的「持久终端明确不做」在本文第六部分复核。
>
> 方法：三仓浅克隆到 scratch 后逐文件读源码；引用一律给 `文件:行号`；无法从源码确认的写「推断」。

---

## 0. 摘要：三条不同结论

| 能力 | 建议 | 理由（一句话） | 工作量 |
| --- | --- | --- | --- |
| **向用户提问** | **做**（P1） | 主进程已有整套交互管道（未决表 + 挂起 Promise + 事件 + 会话取消），缺的只是一个工具、一张卡、一套降级策略 | 中偏小 |
| **后台作业** | **做**（P2） | 现状是「长命令把回合挂死」：内核 `bash` **没有默认超时**，`npm run dev` 会一直等；作业是补齐这条链路的最小形态 | 中 |
| **持久终端**（PTY 暴露给模型） | **暂不做**；若要，先做「给人用的终端面板」 | 三家里两家把它留给人（opencode 的 PTY 只服务终端面板、工具层零引用；dsh 出厂 preset 不装 terminal 工具），第三家（codex）把它合并进「统一 exec + 轮询」而不是单独做工具族 | 大 |

一句话总览：**三家真正达成共识的不是「持久终端」，而是「会话句柄 + 轮询 + drain 语义」**——
持久性体现在「进程还活着」这件事上，而不是「shell 变量被记住了」。这恰好说明：
Oint 缺的不是 PTY，而是**把长任务从回合里摘出去**这件事（作业），以及**回合中途和用户对话**这件事（提问）。

---

## 1. 持久终端

### 1.1 dsh：PTY 后端 + 每次调用随机哨兵

- 工具名就叫 `bash`，是一次性 bash 的**替换品**（同名互斥），`inject = ['tools','terminals']`
  （`dsh packages/shell/tool-bash-persistent/src/index.ts:405,432`）。
- 进程通过 PTY 后端起：`ctx.terminals.spawn(owner, { type, cwd })`（同上 `:256-259`），
  后端 `dsh-terminal-bash` 用 node-pty 起 `bash --noprofile --norc -i`
  （`packages/terminal/terminal-bash/src/index.ts:197-205`，argv 见 `terminal-bash/src/config.ts:54-56`）；
  启动后立刻 `stty -echo` 压回显、但保留后端 prompt（`tool-bash-persistent/src/index.ts:270-278`）。
- **一条命令怎么算结束**：每次调用生成新哨兵（`randomUUID`），把命令包成**单物理行**

  ```ts
  // tool-bash-persistent/src/index.ts:64-85
  start = `__DSH_PERSISTENT_BASH_START_${nonce}__`
  end   = `__DSH_PERSISTENT_BASH_END_${nonce}:`
  // printf '%s\n' $start; eval -- $command; __status=$?; printf '%s%s\n' $end "$__status"
  ```

  注释 `:81-83` 讲清为什么必须单行：交互 bash 遇到含换行的缓冲会先打 PS2，把 prompt 和哨兵源码
  泄进模型可见输出。解析在 `:96-105`（先 `lastIndexOf(end)`，再取尾部退出码），
  尾部追加 `[Command finished with exit code N]`（`:168-171`）。
- **就绪检测类型化**：等待循环 25ms 轮询（`:25`），除哨兵外还识别两类提前返回——
  `sessionStatus.kind === 'exited'`（shell 死了 → 返回 `[shell exited: code N]` + 重置提示，`:179-220`）、
  `waitReason === 'stdin_read'`（shell 或前台子进程在等输入 → 返回已捕获输出，不空转到超时，`:368-378`）。
  `terminal/terminal/src/types.ts:29,39-41` 把「超时」与「进程退出」正交建模，
  `inferred_idle` 明说不证明命令结束。
- **超时 = 放弃这个 shell**：默认 `timeoutMs = 300_000`、`maxOutputChars = 16_000`（`:447-452`）；
  超时/abort/任何 send 抛错都走 `reset` = `terminals.kill(owner, id)`（`:242-247,332-358`）。
- **状态活在哪**：纯内存，键是 `Agent` 对象本身（`WeakMap<Agent, Promise<id>>` +
  `Map<Agent, id>`，`:222-227`）；cwd/env/函数/job control 全在 PTY 进程内，不序列化、不落盘。
  文档明确边界：跨进程重启全丢（`docs/subsystems/terminal.md:91`）。
- **出厂状态：默认不装**。`tool-terminal` / `tool-bash-persistent` 都不在 base/standard preset 里，
  只有 `minimal`、`sdk-minimal`、测试快照、e2b fixture 会挂
  （`packages/presets/minimal/agent.cordis.yml`；`packages/bundle/sdk-minimal/cordis.patch.yml:50-64,123-124`）。
  设计 note 原话：PTY 是 opt-in 组合，不进出厂示例。

### 1.2 opencode：工具侧每次新进程；PTY 只服务终端面板

- `bash` 工具（id 仍是 `bash`，为兼容旧插件保留）schema 只有
  `{ command, timeout?, workdir? }`（`oc packages/opencode/src/tool/shell/prompt.ts:15-23`）：
  **没有 cd 语义，用 `workdir` 参数替代**。
- 每次调用 `ChildProcess.make(...)` 起新进程，作用域结束即回收
  （`tool/shell.ts:293-310,481-559`）；env 每次由 `process.env` + 插件 `shell.env` 钩子重建（`:416-426`）。
  默认 2 分钟超时（`:347`），超时/abort 都 `kill({ forceKillAfter: "3 seconds" })`（`:540-557`）。
- 输出：内存只留尾部窗口，超 `maxBytes` 立刻全文落盘并改为 append
  （`:438-523`；落盘目录 `tool/truncation-dir.ts:4`，保留 7 天 `tool/truncate.ts:12-17,143-148`）；
  最终结果取尾部并在截断处写 `...output truncated... Full output saved to: <file>`（`:568-580`）。
- **PTY 子系统是给人用的**：`Pty` 服务 + 2MB 环形缓冲 + 绝对游标回放 + 单次 ticket 的 WebSocket
  （`packages/core/src/pty.ts:14-17,80-88,259-310`；路由 `protocol/src/groups/pty.ts:21-142`；
  客户端 `packages/app/src/context/terminal.tsx`）。
  抽查确认：`packages/opencode/src/tool/` 里 **零** pty 引用（早先一次正则命中是 `empty` 的假阳性）。
  也就是说：同一份 PTY 能力，opencode 选择只给终端面板，**不暴露给模型**。
- 陷阱提醒：`tool/shell/prompt.ts:259` 仍写着 "persistent shell session"，是上游遗留文案，与实现不符。

### 1.3 codex：把「持久」做成统一 exec 会话

- `exec_command` + `write_stdin` 两个工具覆盖全部交互需求，管理器按 session 存于
  `SessionServices.unified_exec_manager`（`codex codex-rs/core/src/session/session.rs:1536`）。
- **不是预建池**：每次 `exec_command` 新起进程，只有**初始 yield 窗口结束时仍存活**才登记进 store
  （`core/src/unified_exec/process_manager.rs:570-593`，注释解释了为什么要在 yield 前就持久化句柄）。
  进程 id 是 4~6 位整数（生产用随机、测试用确定性）且在**执行前**预留，早退分支统一释放
  （`process_manager.rs:447-472`；`handlers/unified_exec/exec_command.rs:289,328-404`）。
- **输出是 drain 语义**：每次调用把该进程共享缓冲区**整个取走**
  （`process_manager.rs:1506-1513` 的 `std::mem::take(&mut *guard)`），所以天然「只拿到上次之后的新增」，
  不需要游标。缓冲区是 head+tail 各 50%，中间插 `... N bytes omitted ...`
  （`unified_exec/head_tail_buffer.rs:11-124`）。
- 关键常量集中一处（`unified_exec/mod.rs:73-82`）：`MIN_YIELD_TIME_MS=250`、`MAX_YIELD_TIME_MS=30_000`、
  `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS=300_000`、`DEFAULT_MAX_OUTPUT_TOKENS=10_000`、
  `MAX_UNIFIED_EXEC_PROCESSES=64`。`exec_command` 默认 yield 10s、`write_stdin` 默认 250ms；
  **空输入轮询**放宽到 `5s..300s`（`process_manager.rs:952-961`）——这就是「等后台任务」的形态。
- `tty` 参数默认 false，受 feature 门控；非 tty 下只有 `\u{3}`（Ctrl-C）被翻译成中断，其余 stdin 写入直接报
  `StdinClosed`（`process_manager.rs:922-949`）。
- 权限随进程冻结：进程记录里带 `permissions: TerminalPermissions`，`write_stdin` 只做「重新审」，
  **没有对已运行进程动态提权的路径**（`unified_exec/mod.rs:183-197`）。
- Plan 模式下不靠删工具实现裁剪，而是模板指令约束；`request_user_input` 是唯一按模式开关的工具（见 §3.3）。

### 1.4 三家的共性（这才是可复用结论）

1. **「持久」= 进程存活 + 会话句柄**，不是「shell 状态记忆」。三家给模型的接口都是
   「start（带 yield 窗口）→ 后续用同一句柄读/写」。
2. **输出语义是 drain（取走增量）**：codex 用 `mem::take`，dsh 用「本次 send 后的全部输出 + 哨兵定位」。
   比游标/offset 简单，且不会重复投喂上下文。
3. **短命令零管理开销**：只有初始窗口结束后仍存活的进程才进注册表（codex），
   或只在同一 owner 复用时才存在（dsh 的 `Map<Agent,id>`）。
4. **上限是软约束**：codex 64 个进程、软 LRU（保护最近 8 个、优先淘汰已退出），不硬杀。
5. **超时语义显式**：dsh「超时即放弃该 shell 并重置」，codex「yield 有上界但不是强制 kill 超时」。
   两家都不假装「命令还在后台跑但我还能拿到退出码」。
6. **ANSI 在 PTY 层清洗**，绝不把「渲染后的屏幕」当事实来源（dsh 设计 note 明确否决 headless emulator 路线）。
7. **进程树清理要身份围栏**：dsh 明确拒绝按 SID 发信号（node-pty 可能给出 launcher 所属 session 的 helper PID，
   SID 级信号会误杀宿主/桌面进程）。

---

## 2. 后台作业

### 2.1 dsh：注册表拥有契约，producer 拥有资源

这是三家里**唯一做完整作业系统**的一家。`ctx.jobs` 是统一注册表，被管对象是**一切长时任务**：
后台命令（`tool-bash` 的 `run_in_background`）、PTY 交互（`tool-terminal` 的发送）、子代理
（非 continuable 模式）。web-app bundle 的注释把这层故意讲得很白：

> The background-job REGISTRY stays on the host plane; only the model-facing `job_*` controls move.
> Its producers — `tool-bash` here, `tool-terminal` and a non-continuable `tool-subagent` elsewhere —
> are preset rows that resolve it with `ctx.get`… The registry is keyed by owning agent, so one host
> instance serves every session exactly as before presets.
> （`dsh packages/bundle/web-app/cordis.patch.yml:374-382`）

- 模型面三个工具：`job_output` / `job_list` / `job_kill`（`packages/jobs/tool-jobs`，base bundle 默认装
  `packages/bundle/base/cordis.patch.yml:254`）。
- **完成通知按 owner 忙闲分流**：`completionDelivery: 'quiet' | 'wakeup'`，
  busy owner 直接 inject 到下一步、idle owner 开一个新回合；`maxConsecutiveWakes`（默认 3）防止
  「作业完成 → 唤醒 → 又起作业」的自激（`packages/jobs/tool-jobs/src/index.ts:5,21-44,278-299`）。
- **权限用授权而非保密**：作业 id 可预测（`<kind>-N`），访问靠 session id fence
  （`packages/jobs/jobs-local/src/index.ts:351-360`；设计 note 明确否决随机 id / 提权 / 生命周期事件）。
- **teardown 先标 `reported`**，避免为一个垂死的 owner 烧模型请求（`jobs-local/src/index.ts:507-517`）。
- **`readOutput` 可选** = 区分「流式作业」与「终态作业」：PTY/bash 给增量，子代理只给终态。
  代价被明确承认：只有一个消费游标，UI 要另立 API。

### 2.2 opencode：模型面没有后台作业；只有子代理的进程内注册表

- 全仓 `run_in_background` **0 命中**（`packages/**` 实测）；`tool/shell.ts` 无后台参数。
  core 的 V2 重写里把这件事写成未完成项：

  > `// TODO: Persist background job status and define restart recovery before exposing remote observation.`
  > （`oc packages/core/src/tool/bash.ts:72-74`）

- 长命令的处理方式 = 阻塞到超时 → 被杀 → 返回元信息提示「重试给更大 timeout」（`tool/shell.ts:562-584`）。
- 存在一个**进程内、非持久**的后台作业注册表，但只服务 `task` 子代理：结果以**合成消息注入父会话**
  （`packages/core/src/background-job.ts:9-19,202-358`；`tool/task.ts:227-297`）。
  作者把边界写在注释里：要跨重启/多窗口观察作业，必须另建持久层，别假装 registry 有这些语义。
  防递归靠「子代理里默认 deny `task`」（`tool/task.ts:144-149`）。

### 2.3 codex：没有独立 job 概念，存活进程就是后台终端

- 没有 `job_list` 之类的工具；「后台作业」= 还活着的 exec 会话，用 `session_id` 轮询
  （空输入 `write_stdin`，见 §1.3）。
- 客户端侧有独立事件流：`ExecCommandBegin/End/OutputDelta`、`TerminalInteraction`
  （`codex-rs/protocol/src/protocol.rs:3527-3618` 附近），delta 单包上限 8192 字节、每次调用有配额
  （`unified_exec/async_watcher.rs:34-42,309-336`）。
- **模型不会被动收到「后台终端已完成」**：退出 watcher 只发客户端事件（推断：未找到任何把子进程退出
  注入模型上下文的路径，属子代理检索结论）。
- app-server 侧有 `thread/backgroundTerminals/*`，且 `ThreadBackgroundTerminal` 预留了
  `os_pid/cpu_percent/rss_kb` 但恒为 `None`（`app-server/src/request_processors/thread_processor.rs:2373-2381`）——
  像是给进程监控 UI 留的接口。

### 2.4 共性与真正的难点

后台作业的**实现**不难（spawn + 环形缓冲 + kill）；难的是另外两件事：

1. **完成通知怎么回到模型上下文**。三家三种答案：
   dsh 用**唤醒预算 + 忙闲分流**（最完整）；opencode 只对子代理用**合成消息注入**；
   codex **完全不通知**，靠模型自己轮询。
2. **防自激与垂死唤醒**：dsh 的两个补丁（`maxConsecutiveWakes`、teardown 先标 `reported`）值得照抄。

---

## 3. 向用户提问

### 3.1 dsh：`ctx.userQuestions` + `ask_user_question`

- 工具 `ask_user_question`，服务 `ctx.userQuestions`，provider 由 UI 端组合（standard preset 默认装
  `packages/presets/standard/agent.cordis.yml:238`）。
- **与审批共用传输、不共用 seam**：审批是 fail-closed 且有 `never` 策略给 CI 用；
  提问**没有超时**，靠 signal 取消；**只有 runtime root 能提问**，子代理要把问题写进最终结果
  （`packages/interaction/user-questions/src/index.ts:73-106`）。
- 被否决的替代方案写在设计 note 里：不给子代理开提问通道是**有意**的（宁可让子代理把问题带回来）。

### 3.2 opencode：`question` 工具 + pending/Deferred + 三事件

- 工具 id `question`；实现 = 未决表 + `Deferred` + 发布 `question.asked` / `question.replied` /
  `question.rejected` 事件 + HTTP `reply`/`reject`（`packages/opencode/src/question/index.ts:87-153`；
  schema `packages/schema/src/v1/question.ts:15-65`）。支持多问题、多选、自定义输入；**无超时**。
- 非交互场景靠**提前摘工具**规避：`client ∈ {app,cli,desktop}` 或 `OPENCODE_ENABLE_QUESTION_TOOL`
  才注册（实测 `tool/registry.ts:207,233`），另外 `question: deny` 权限规则也能摘掉它
  （默认规则集 `agent/agent.ts:119-136` 里 `question` 是 deny）。
- 与权限审批是**两套平行实现**（`permission/index.ts` 与 `question/index.ts` 各写一遍
  「pending Map + Deferred + publish + HTTP 回执 + 销毁时统一 fail」），各约 150 行。

### 3.3 codex：`request_user_input`，模式与暴露都受控

- 注册条件：`experimental_request_user_input_enabled`「配置缺省即 true」
  （`core/src/config/mod.rs:2634-2640`），但可用模式被限制在 **Plan**；
  暴露级别 `ToolExposure::DirectModelOnly`（进模型工具表、不进 `tool_search` 索引）
  （`core/src/tools/spec_plan.rs:1158-1165`）。
- 待答项**按 turn 索引**（一次 turn 只有一个待答），未答复的回合结束会被收尾成 item
  （`core/src/session/tests.rs:11192`）。与 `request_permissions` 用 **call id** 关联（可并发多个）
  形成对照——**两者的 id 语义刻意不共用**。
- 「自由输入」选项由**客户端**补（handler 强制 `is_other = true`），不把这个 UI 约定丢给模型。
- `request_permissions`（沙箱提权）是 UnderDevelopment、默认关（`features/src/lib.rs:1178-1183`）。

### 3.4 共性与结论

1. **提问 = 审批的孪生体**，但 id 语义不同：审批一次工具调用一个（可并发），
   提问一次回合一个（codex 的 turn 关联最干净）。
2. **必须显式设计降级**：dsh 由 UI 端 answerer 决定（没 UI 就没 provider）；
   opencode 干脆「不装这个工具」；codex 用 Plan 模式限定 + 配置开关。
   **三家都没有可靠的超时兜底**——这是它们共同的缺口，Oint 应该补上。
3. **只允许 root 提问**（dsh 的做法），子代理把问题写进结果返回——避免「子代理卡在等人的状态」。

---

## 4. Oint 现状：管道比想象中完整，缺的是出口

### 4.1 已经存在、可直接复用的资产

| 资产 | 位置 | 对本文三件事的意义 |
| --- | --- | --- |
| 审批服务（未决表 + 挂起 Promise + 事件 + 回执 + 会话取消 + AI 预审 + 历史） | `src/main/pisdk/approvals.ts:56-227` | **就是「提问」需要的交互原语**：`request()` 返回挂起 Promise、`respond()` 唤醒、`pending()` 供 UI 恢复、`cancelSession()` 收尾 |
| 运行中排队注入（steer / followUp，含 `queue-updated` 事件） | `src/main/pisdk/runtime.ts:1497-1521` | 作业完成通知、提问回执都能走这条路（内核 `lane.steer/followUp/nextRun` 三种投递语义） |
| 会话级持久状态（自定义 entry） | `src/main/pisdk/runtime.ts:1136-1142`（todo 用它）+ 启动恢复 | 作业/提问记录若需跨重启，走同一模式 |
| 工具热替换 | `src/main/pisdk/runtime.ts:1026`（MCP 用它 `harness.setTools`） | 作业工具可以按开关动态装配 |
| 十个 hook 点 | 内核 `before_run / before_tool / after_tool / before_run_end / before_compaction / before_navigation / before_payload / before_request / before_drive / after_response` | `before_tool` 已是权限门；作业/提问都能挂在这里做前置校验 |
| 中断运行 | `src/main/pisdk/runtime.ts:290,1489`（`lane.abort`） | 会话停止时的作业清理挂靠点 |
| bash 的输出契约 | 内核 `dist/harness/tools/bash.js:10-24,45-57,75-79`：**无默认超时**、尾部 2000 行 / 50KB 截断、全文落盘并给 `fullOutputPath` | 作业必须自己管理输出缓冲；截断策略可对齐 |
| 渲染层终端块 + 面板先例 | `src/renderer/features/chat/tool-presentation.ts:222,243`（`kind:"terminal"`）、`TodoPanel.tsx` | 作业列表/终端面板有现成排版先例 |

### 4.2 缺口

| 缺口 | 证据 |
| --- | --- |
| 全仓没有任何 PTY/xterm 依赖 | `node-pty|xterm|pty` 在 `src/**` 仅 3 处无关命中 |
| 没有作业注册表、没有后台参数 | 无 jobs 模块；`tools.ts:86-95` 只有 8 个工具 |
| 没有交互通道契约 | `src/shared/contracts/` 下只有 approval/chat/session 等，无 interaction |
| 自定义 entry 对模型不可见 | 未注册 `entryProjectors`（内核 `harness/session/context.d.ts:5`），todo 只用于状态恢复 |
| 工具执行拿不到 abort signal | 内核 `Shell.exec` 是阻塞契约（`harness/types.d.ts:267-290`），`ExecutionEnv = FileSystem & Shell`，无 handle/stdin/后台 |
| bash 可能把回合挂死 | 内核 bash `timeout` 可选且**无默认值** |

**一句话**：Oint 现在能「停下来问用户」的唯一场景是审批卡；能「跑长任务」的唯一方式是
「把这一轮绑死在一个阻塞进程上」。

---

## 5. 建议路线

### A. `ask_user`（建议做，P1）

**形态**：一个工具 + 一张卡 + 一套降级。**不要**新写一套 pending/事件机制——
把 `approvals.ts` 抽出公共部分，或按同样的骨架新建 `src/main/pisdk/interactions.ts`：

- 服务：`request({ sessionId, toolCallId, questions })` → 挂起 Promise；`respond(id, answers)`；
  `pending(sessionId)`（会话切换时恢复卡片）；`cancelSession(sessionId)`（运行停止 → 按「未回应」收尾）。
- 契约：`src/shared/contracts/interaction.ts`（问题/选项/答案类型）+ 在 `contracts/chat.ts` 的
  `ChatEvent` 上加 `ask-requested` / `ask-resolved`（审批已有同名风格事件可对照）。
- 出口：`src/main/ipc/interactions.ts` + preload 方法；渲染层卡片照 `elements/approval-card.tsx` /
  `features/chat/ApprovalSection.tsx` 结构做，落点选聊天流（与审批卡同区）。
- 工具：`src/main/pisdk/tools/ask.ts`，参数建议 `{ questions: [{ id, header, question, options?, multiSelect? }] }`，
  返回结构化答案文本；`permissions.ts` 里登记为 LOW（不触碰工作区），**但要加一条硬门：仅 root lane 可见**
  （dsh 的做法，子代理不暴露）。
- **必须补三家都缺的降级**：默认超时（建议 5 分钟）后返回「用户未回应，请按最保守假设继续或改为汇报」；
  无 UI / 非交互启动时工具不注册（opencode 的做法）；会话 abort 时立刻收尾。
- 前端配套：`ToolParts.tsx:40-61` 的 `TOOL_ICONS`/`TOOL_LABELS` + `tool-presentation.ts:220-255` 的
  `ToolDetail` 联合各加一支（对齐 P1-1 那套「加工具要改 4 处」的清单）。

**风险**：低。它不引入新权限面，只是把已有的「挂起等待」能力复用到普通工具上。
真正的风险是**提示词**——不写清「什么时候才该问」，模型会用提问代替自己查证。
建议照 codex/opencode 的写法，在工具描述里同时写「什么时候不要用」。

### B. 后台作业（建议做，P2）

**最小闭环**（比 dsh 的三工具少一半也能用）：

1. `src/main/pisdk/jobs.ts`：注册表（`sessionId` fence 授权、上限 16、head+tail 环形缓冲、
   `kill` 走进程树清理）。**只放主进程内存**——与 dsh/opencode 一致，跨重启不存活，别假装它是持久的。
2. 新工具 `bash_background`（不要试图改内核 `bash` 的参数 schema：`createBashTool` 返回的
   `parameters` 是固定 TypeBox 结构，覆盖它只会让「工具描述」和「实际执行」脱节）。
   执行路径自己 `spawn`——内核 `Shell.exec` 是阻塞契约，拿不到 handle/stdin（§4.2）。
3. 读与杀：`job_output`（drain 语义，返回「上次之后的新增」+ 状态）、`job_list`、`job_kill`。
   命名直接对齐 dsh，省得以后对不上。
4. **完成通知**走已有的 `runtime.ts:1497-1521` 封装：owner 忙 → `steer`，空闲 → 触发一次新回合；
   必须带**唤醒预算**（照抄 dsh 默认 3）与「先标 reported 再通知」，否则「作业完成 → 唤醒 → 又起作业」
   会自激。
5. 顺手补两件事：**给 bash 一个默认超时**（内核没有默认值，这是当前最容易咬人的地方）；
   作业输出超阈值时落盘并把路径给模型（对齐内核 bash 的 `fullOutputPath` 行为）。
6. UI：`JobPanel` 照 `TodoPanel` 做，数据从 `jobs.ts` 经 IPC 推送。

**风险**：中。新增权限面是「**孤儿进程**」——作业没人 kill 就会一直活着。
必须同时给出：上限、会话结束清理、应用退出清理（`app.on("before-quit")`）、以及 Windows 下的进程树处理。

### C. 持久终端（建议暂不做；做也只做人类面板）

不做的理由不是「难」，而是**三个参照物都没有把它交给模型**：

- opencode：PTY 能力齐全但只服务终端面板，工具层零引用；
- dsh：`tool-terminal` 是 opt-in 组合，出厂 preset 不装，只有 minimal / sdk-minimal 挂；
- codex：把「持久」合并进统一 exec（`tty` + 轮询 + drain），没有独立的终端工具族。

真要做的两条路，建议按这个顺序：

1. **给人用的终端面板**（不引入模型权限面）：`xterm.js` + `@lydell/node-pty`（opencode 同款，
   已按平台拆包）或 `node-pty`，PTY 生命周期放主进程，渲染层只做多路复用与回放；
   抄 opencode 的 **2MB 环形缓冲 + 绝对游标回放 + 单次 ticket** 三件套
   （`oc packages/core/src/pty.ts:14-17,259-310`、`protocol/src/groups/pty.ts:100-142`）。
   这条路的收益是「用户能自己看构建/服务日志」，不改变模型能力。
2. 若之后确需模型侧交互式会话：**不要**做 `terminal_open/send/read/signal/close/list` 六件套，
   照 codex 收敛成 **2~4 个工具 + `session_id` + drain + 64 上限 + 权限随进程冻结**，
   并明确「超时 = 放弃会话」。Windows 上必须先解决 conpty 与进程树清理（dsh 拒绝 SID 级信号的
   理由在 Windows 更成立）。

---

## 6. 判据复核：与 `agent-tools-and-upgrade-guide.md` §7.4 的关系

原判据是「**是否引入新的权限面**」，据此把 grep/glob/todo 收进来（只读），把持久终端挡在外面。
本次调研后建议把判据拆成两条，判定不再有歧义：

| 判据 | `ask_user` | 后台作业 | 持久终端（模型侧） |
| --- | --- | --- | --- |
| 新增**权限面** | 否（复用已有审批/交互通道） | **是**：孤儿进程 + kill 策略 | **是**：任意交互式进程 + 信号 |
| 新增**状态面**（跨会话/跨重启） | 否（挂在会话上，随会话收尾） | 否（内存注册表，进程退出即清） | **是**（PTY 状态、scrollback、清理责任） |

结论：`ask_user` 两条都不触，属于「原样呈现」范围内的补齐；后台作业触一条但可控（把上限/清理写死即可）；
持久终端两条都触，维持「暂不做」。

同时建议把这三件事补进那份文档的 P3 表，并互相引用，避免两处结论漂移。

---

## 7. 可复用设计清单（跨项目）

1. **drain 语义**优于游标：每次调用取走缓冲区全部内容（codex `mem::take`）。
2. **存活才登记**：短命令不进注册表，注册表里只有真后台进程。
3. **上限是软约束**：保护最近 N 个 + 优先淘汰已退出，不硬杀。
4. **作业 id 可预测 + session fence 授权**（dsh）：省掉一整套 id 保密设计。
5. **完成通知要分忙闲 + 带预算**（dsh 的 `completionDelivery` / `maxConsecutiveWakes`），
   并在 teardown 前标 `reported`。
6. **提问与审批共用传输、不共用 id 语义**：审批按 call id（可并发），提问按 turn id（一次一个）。
7. **降级必须显式**：没有 UI 就别注册工具（opencode）；有 UI 就补超时（三家都缺，Oint 补上）。
8. **提问只给 root**（dsh），子代理把问题写进结果。
9. **实验特性隐身手法**：不给参数就不暴露 schema；不在白名单就不注册工具；
   按模式裁剪用权限规则而不是 if 分支（opencode）。
10. **工具面跨模式保持稳定**（dsh 明说为 prompt cache），约束靠模板 + 单点拒绝，不靠删工具。
11. **ANSI 清洗在 PTY 层**，不用 headless emulator 的屏幕当事实。
12. **进程树清理要身份围栏**，不做 SID 级信号。

---

## 8. 待确认与风险

- 三仓结论基于 2026-09 时点的默认分支；dsh/opencode 都在快速迭代，行号会漂，引用时以符号名检索为准。
- codex 侧两处标注为**推断**：后台终端完成不会通知模型；`ThreadBackgroundTerminal` 的
  `os_pid/cpu_percent/rss_kb` 是为监控 UI 预留。均未在源码中找到反例，但也没有正面文档。
- dsh 文档与代码有已知不一致（`docs/subsystems/terminal.md:91` 说会话跨 tool-plugin reload 存活，
  而 `tool-bash-persistent` 自己在 dispose 时关闭自己的 shell；`terminal_close` 的返回结构文档过时）。
  凡与本文冲突处，以代码为准。
- 未实测任何外部项目（本机未安装其依赖）：所有外部结论来自源码与仓库内文档/设计 note 的交叉阅读。
- 本文未改动被调研仓库；三方源码浅克隆留在 scratch，可复现。

---

## 9. 实施状态（落地记录）

> 本节记录按第五部分路线落地后的实际情况，供后续接手者对照。落地时点为本文首版同一次改动。

**A. `ask_user` —— 已落地**

| 层 | 位置 |
| --- | --- |
| 契约 | `src/shared/contracts/interaction.ts`；`ChatEvent` 新增 `ask-requested` / `ask-resolved` |
| 服务 | `src/main/pisdk/interactions.ts`（未决表 + 挂起 Promise + 事件 + 5 分钟超时按 `unanswered` 结算 + 会话取消） |
| 工具 | `src/main/pisdk/tools/ask.ts`（1~4 题、可选项可自由输入、描述里写了「什么时候不要用」）；低风险，不进审批 |
| 出口 | `src/main/ipc/interactions.ts`、`ipc/registry.ts`、`contracts/{ipc,api}.ts`、`preload/index.ts` |
| 界面 | `src/renderer/features/chat/AskSection.tsx`、`elements/ask-card.tsx`、`chat-store.ts`（`pendingAsks` / `respondAsk` / `loadPendingAsks`）、`ToolParts.tsx` 图标与文案、双语 i18n |
| 装配 | 会话创建与 MCP 热替换**两处** `buildTools` 都带 ask 工具（漏一处会让它在 MCP 刷新后消失） |

**B. 后台作业 —— 主进程与 IPC 已落地，面板见下**

| 层 | 位置 |
| --- | --- |
| 契约 | `src/shared/contracts/job.ts`；`ChatEvent` 新增 `job-changed` / `job-removed` |
| 服务 | `src/main/pisdk/jobs.ts`：head+tail 有界缓冲（默认 64 KiB）+ drain 游标 + 会话 fence 授权 + `maxJobs` 上限（默认 16，优先淘汰已结束）+ `killProcessTree`（Windows `taskkill /T /F`，POSIX 进程组） |
| 工具 | `src/main/pisdk/tools/jobs.ts`：`bash_background` / `job_output` / `job_list` / `job_kill`（`job_output` 支持 `waitMs` 等到产出或退出） |
| 通知 | `runtime.ts` 的 `notifyJobExit`：忙 → `steer` 注入（不计唤醒）；空闲 → `send` 起一轮，**每会话连续唤醒上限 3 次**，用户自己发消息时清零（内部 `jobWake` 参数区分两类调用） |
| IPC | `src/main/ipc/jobs.ts` + `ChatRuntime.listJobs/killJob` + 契约与 preload |
| 清理 | 关闭会话杀该会话作业；`dispose` 全部收掉；**停止单轮运行不杀作业**（作业语义就是活过这一轮） |
| 收尾 | 内核 `bash` 默认超时未改（仍无默认值）：长任务请用 `bash_background` |

**测试与验证**：`npx vitest run`（两个 project）全绿；`npx tsc -p tsconfig.electron.json --noEmit` 与 `npm run typecheck` 干净；
`npm run check:unwired` 退出码 0。作业测试在落地中发现并修掉三个真实缺陷：
`DrainBuffer` 读了头部字节数两遍导致 drain 静默吞字节、单块输出超过「头部采样 + 缓冲」时丢弃循环不收敛（同步死锁）、
作业 id 按会话自增却共用一张全局作业表（跨会话撞车）。

**已知边界**：
- Windows 上没有可用 `bash` 时，作业的 spawn 走 cmd 兜底，而该链路对带引号的命令（如 `node -e "..."`）
  实际跑不出输出（内核的 `NodeExecutionEnv` 在这种情况下直接报 `shell_unavailable`，不兜底）。
  建议后续统一成「与内核一致的失败语义」，或给 cmd 分支加 `windowsVerbatimArguments` 并实测。
- `DrainBuffer` 的字节账本按 JS 字符下标切片：非 ASCII 输出时省略标记的字节数会漂移（既有设计限制）。
- 作业面板（渲染层）见该次改动的后续提交；IPC 面与事件已就绪，面板只是消费者。
---

## 附录 · 证据索引

**持久终端**

| 主题 | 位置 |
| --- | --- |
| dsh 持久 shell 的哨兵协议 | `dsh packages/shell/tool-bash-persistent/src/index.ts:64-105,168-171` |
| dsh 就绪检测 / 提前返回 | 同上 `:25,179-220,368-378`；`packages/terminal/terminal/src/types.ts:29,39-41` |
| dsh 超时即重置 | 同上 `:242-247,332-358,447-452` |
| dsh 出厂不装 terminal 工具 | `packages/presets/minimal/agent.cordis.yml`；`packages/bundle/sdk-minimal/cordis.patch.yml:50-64,123-124` |
| opencode shell 每次新进程 | `oc packages/opencode/src/tool/shell.ts:293-310,481-559`；schema `tool/shell/prompt.ts:15-23` |
| opencode 输出落盘 | `tool/shell.ts:438-523,568-580`；`tool/truncate.ts:12-17,143-148` |
| opencode PTY（人用） | `packages/core/src/pty.ts:14-17,80-88,259-310`；`protocol/src/groups/pty.ts:21-142` |
| codex 统一 exec | `codex-rs/core/src/unified_exec/mod.rs:73-82,149-197`；`process_manager.rs:447-472,570-593,922-961,1506-1513` |
| codex head+tail 缓冲 | `codex-rs/core/src/unified_exec/head_tail_buffer.rs:11-124` |

**后台作业**

| 主题 | 位置 |
| --- | --- |
| dsh 作业注册表与 producer 分工 | `dsh packages/bundle/web-app/cordis.patch.yml:374-386` |
| dsh 通知策略与唤醒预算 | `packages/jobs/tool-jobs/src/index.ts:5,21-44,278-299` |
| dsh 授权 fence / reported | `packages/jobs/jobs-local/src/index.ts:351-360,507-517` |
| opencode 未实现后台作业 | `oc packages/core/src/tool/bash.ts:72-74` |
| opencode 子代理后台注册表 | `packages/core/src/background-job.ts:9-19,202-358`；`tool/task.ts:227-297` |
| codex 客户端事件与配额 | `codex-rs/protocol/src/protocol.rs:3527-3618`；`unified_exec/async_watcher.rs:34-42,309-336` |

**向用户提问**

| 主题 | 位置 |
| --- | --- |
| dsh 提问服务与 root 限定 | `dsh packages/interaction/user-questions/src/index.ts:73-106`；preset `packages/presets/standard/agent.cordis.yml:238` |
| opencode question 工具 | `oc packages/opencode/src/question/index.ts:87-153`；`packages/schema/src/v1/question.ts:15-65` |
| opencode 工具门控 | `packages/opencode/src/tool/registry.ts:207,233`；默认规则 `agent/agent.ts:119-136` |
| codex request_user_input | `codex-rs/core/src/tools/spec_plan.rs:1158-1165`；`core/src/config/mod.rs:2634-2640`；`features/src/lib.rs:1178-1183` |

**Oint 本地**

| 主题 | 位置 |
| --- | --- |
| 审批服务骨架 | `src/main/pisdk/approvals.ts:56-227` |
| 运行中排队注入 | `src/main/pisdk/runtime.ts:1497-1521` |
| 自定义 entry 持久化 | `src/main/pisdk/runtime.ts:1136-1142` |
| 工具热替换 | `src/main/pisdk/runtime.ts:1026` |
| 工具装配与「刻意不做」注释 | `src/main/pisdk/tools.ts:9-10,86-95` |
| 内核进程契约 | `node_modules/@earendil-works/pi-agent-core/dist/harness/types.d.ts:267-290` |
| 内核 bash 超时与截断 | `.../dist/harness/tools/bash.js:10-24,45-57,75-79` |
| 渲染层工具详情 / 图标表 | `src/renderer/features/chat/tool-presentation.ts:220-255`；`ToolParts.tsx:40-61` |

---

## 变更记录

- 首版：三方（dsh / opencode / codex）源码级对照 + Oint 现状与缺口 + ask_user / 后台作业 /
  持久终端三条独立建议；复核 §7.4 判据并建议拆成「权限面 + 状态面」两条。
