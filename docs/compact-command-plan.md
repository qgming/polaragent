# `/compact` 指令 + 压缩过程提示：实施计划

> 目标：把 `/compact` 做成**与魔法提示分开的内置指令**，直连 pi 的 `lane.compact()`；并在会话里压缩期间给出明确的过程提示。
> 本文件是实施计划（含现状核实、设计、分阶段步骤、文件清单、测试与验收）。相关背景报告见 `docs/slash-commands-and-prompts-report.md`。

---

## 0.5 实施状态（2026-xx 更新）

**Phase 1 / 2 / 3 已完成，Phase 4 的 4.1（B2 修复）与 4.2 的推荐方案（压缩中禁用发送 + 提示）已完成**；4.2 的「排队并在压缩结束后自动发出」、4.3 的「取消压缩」、以及 P2 两项（转录里的压缩分隔线、侧栏「压缩中」标记）**未做**，按下面的「待你拍板」决定。

已落地的东西（可直接对照上面的设计）：

| 设计 | 落地位置 |
| --- | --- |
| 内置指令注册表 | `src/shared/contracts/commands.ts`（`BUILTIN_COMMANDS` / `CommandSpec` / `findCommandSpec`） |
| 指令可用性 + 执行 | `src/renderer/features/chat/commands.ts`（`unavailableReason` / `runCommand` / `compactFailureNotice`） |
| 三栏菜单 + 置灰 | `slash-commands.ts`（`kind: "command"`、`SLASH_GROUPS`）、`SlashCommandMenu.tsx`、`elements/composer.tsx`（`ComposerCommand.blocked`） |
| 发送收口（指令不产生消息） | `OintRuntimeProvider.tsx` 的 `resolveSlashMessage` + `onNew`；菜单与收口共用 `loadSlashCommands` |
| 草稿保护 | `Composer.tsx` 的 `handleInputKeyDown`（不可用/压缩中拦截）+ 发送键禁用（`disabled={!canSend || commandBlocked || compacting}`） |
| 一行提示 | `ui-store.ts` 的 `composerNotice` / `notifyComposer` / `dismissComposerNotice`，由 Composer 渲染 |
| 结果对象（busy / nothing / failed） | `shared/contracts/chat.ts` 的 `CompactOutcome`、`api.ts`、`ipc/chat.ts`、`runtime.ts` 的 `compact()` |
| 压缩事件扩展 | `shared/contracts/chat.ts` 的 `CompactionReason` / `CompactionStatus` / `SessionCompaction`；`runtime.ts` 的 `compactionDetails` + 事件订阅 |
| 压缩状态机 | `chat-store.ts` 的 `compactions`（五态）+ `compact()` 乐观态 + `clearCompaction()` |
| 压缩条四态 | `ThreadToolbar.tsx`（进行中含原因与秒表 / 完成含 tokens 与保留条数 / 失败 / 取消） |
| B2 修复 | `runtime.ts` 的 `abortStaleOperation` 只收敛 `kind === "run"` 的遗留操作 |

测试：`commands.test.ts`（13）、`slash-commands.test.ts`（+7）、`Composer.slash.test.tsx`（+2 组）、`ThreadToolbar.test.tsx`（8）、`chat-store.test.ts`（压缩状态机 9）、`runtime.send.test.ts`（压缩后端 7）、`runtime.test.ts`（abortStaleOperation 收窄 3）。

---

## 0. 先回答你的三个问题

| 问题 | 答案 | 关键证据 |
| --- | --- | --- |
| 当前有自动触发的上下文压缩吗？ | **有，而且有两条自动路径**：①「阈值压缩」每次请求前按 `contextTokens > contextWindow − reserveTokens` 判定；②「溢出恢复」在供应商报上下文溢出后兜底。当前参数 `enabled: true, reserveTokens: 20_000, keepRecentTokens: 40_000` 是**写死**的 | `runtime.ts:2193`、内核 `structural.js:863`、`compaction.js:144-148`、`structural.js:872-887` |
| `/compact` 与魔法提示分开、内置、直连 pi？ | 正确，且**必须分开**：魔法提示是「正文即消息、交给模型」；`/compact` 是「应用动作、消息根本不发出去」。它应当是一等**内置指令**（编译期注册表），不是 `prompts/*.md` | `slash-commands.ts:8-10`、`runtime.ts:2958-2966` |
| 压缩中要有提示？ | 现状**有一个但有三处毛病**：文案写的是「运行中」不是「压缩中」；**压缩失败后会永久卡在"运行中"**；看不出是自动还是手动、也不知道压缩了多少 | `ThreadToolbar.tsx:34-49`、`chat-store.ts:1055-1062`、`runtime.ts:1843-1850` |

另外核实出**两个真 bug**，本计划一并修（否则 `/compact` 一上线就会被踩到）：

- **B1 失败卡死**：`compaction_end` 的 `failed / declined / aborted` 也会把渲染层状态写成 `""`，而 `""` 在 UI 里等于「进行中」→ 顶部永久显示「运行中 + 微光」。
- **B2 发消息会误杀压缩**：手动压缩期间 `running === false`（压缩不算一轮 run），用户回车 → `lane.prompt` → 内核 `LaneBusy` → Oint 的 `abortStaleOperation()` **把正在跑的压缩 abort 掉**再重发（`runtime.ts:2624-2634` + `:529-531`）。

---

## 1. 现状核实

### 1.1 三条压缩路径（内核实现，Oint 直接受益）

| 路径 | 触发 | reason | 说明 |
| --- | --- | --- | --- |
| 阈值（自动） | 每次响应前的结构检查点 `prepareCompactionThreshold`：`shouldCompact(tokensBefore, model.contextWindow, settings)` → `tokens > 窗口 − 20k` | `threshold` | `structural.js:836-870`、`compaction.js:144-148` |
| 溢出恢复（自动） | 供应商报上下文溢出后，`prepareOverflowCompaction` 兜底，每代限一次（`overflowRecoveryUsed`） | `overflow` | `structural.js:872-887` |
| 手动 | `lane.compact({ customInstructions? })` | `manual` | `lane.js:481-546`；Oint 侧 `runtime.ts:2958-2966`。**注意**：参数已支持自定义压缩说明 |

压缩结果落成会话里的 `compaction` 条目：`{ summary, tokensBefore, retainedTail }`（`session/types.d.ts:27-31`）。压缩后保留约 40k tokens 的近期上下文。

### 1.2 事件已经存在，但 Oint 把信息丢掉了

内核事件（`agent-harness.d.ts:373-394`）：

```ts
{ type: "compaction_start"; runId; reason: "manual" | "threshold" | "overflow"; startedAt }
{ type: "compaction_end";   runId; reason; endedAt } & (
  | { status: "completed"; entryId: string }
  | { status: "declined" | "aborted" }
  | { status: "failed"; error: OperationError } )
```

Oint 的适配（`runtime.ts:1843-1850`）只发 `{type:"compaction-started"}` 与 `{type:"compaction-ended", summaryPreview}`：**reason、status、error、tokensBefore 全丢**。`compactionPreview` 只取摘要前 200 字（`runtime.ts:1712-1725`）。

### 1.3 渲染层现状

- store：`compactionNotices: Record<string, string>`，`""` = 进行中、非空 = 摘要预览（`chat-store.ts:420, 1055-1062`）。
- UI：`ThreadToolbar`（挂在 `ChatView` 顶部，`ChatView.tsx:43`）——有 note 就渲染一条：非空显示摘要 + 折叠展开；空串显示 `ShimmerLabel{t("chat.running")}`＝**「运行中」**（`ThreadToolbar.tsx:19-61`）。
- `store.compact()` 至今**零调用**、无 try/catch（`chat-store.ts:875-879`）。
- `compactionSummaries`（会话加载时返回的摘要列表，`shared/contracts/session.ts:238`）在渲染层**无人消费** → 转录里看不到「这里压缩过」。

---

## 2. 设计

### 2.1 三条不变式（后面所有取舍都从它们推）

- **I1 命令不产生模型消息**：命中指令 → 执行副作用 → 不发消息、不写用户消息到会话。
- **I2 内核事件是唯一权威**：渲染层只允许「事件到达之前的乐观态」，事件一到就被覆盖；乐观态必须在调用失败时被清掉（不许出现幽灵进行中）。
- **I3 压缩与运行互不误伤**：压缩中不许有 prompt 抢 lane（修 B2）；运行中不许手动压缩（内核本来就会拒）。

### 2.2 指令与魔法提示的分层

| | 指令 Command | 技能 Skill | 魔法提示 Template |
| --- | --- | --- | --- |
| 数据模型 | `kind: "command"` | `kind: "skill"` | `kind: "template"` |
| 来源 | **编译期内置**（本仓库代码） | 磁盘（三层目录） | 磁盘（两层目录，未来三层） |
| 谁执行 | **应用** | 模型 | 模型 |
| 是否发给模型 | **否** | 只有 `/name` 元数据 | 正文即消息 |
| 参数 | 命令自己解析 `/compact <说明>` | 无 | 现在刻意无 |
| 菜单栏位 | 第一栏「指令」 | 第二栏「技能」 | 第三栏「魔法提示」 |

数据模型改动很小（`slash-commands.ts:24-43` 已经按 `kind` 泛化）：

```ts
export type SlashCommandKind = "command" | "skill" | "template";
export interface SlashCommand {
  kind: SlashCommandKind;
  name: string;
  description: string;   // 指令：来自 i18n 词条；技能/模板：来自清单
  template?: string;     // 仅模板
  commandId?: CommandId; // 仅指令
}
export const SLASH_GROUPS = ["command", "skill", "template"] as const;
```

内置指令注册表（新文件 `src/shared/contracts/commands.ts`）：

```ts
/** 首批只有 compact；后续 new / stop / help 按同一形状追加 */
export type CommandId = "compact";

export interface CommandSpec {
  id: CommandId;
  /** 菜单里的名字（不带斜杠） */
  name: string;
  /** 摘要 i18n 键（斜杠菜单的一行） */
  descriptionKey: string;
  /** 参数提示 i18n 键；没有就是无参命令 */
  hintKey?: string;
  /** 可用条件：always = 任何时刻；idle = 没有运行、也没有正在压缩 */
  availability: "always" | "idle";
  /** 命令名之后的多余文字：拒绝（none）还是作为参数（rest） */
  argMode: "none" | "rest";
}
```

`/compact` 的定义：`{ name: "compact", availability: "idle", argMode: "rest" }` —— **带参数**（`/compact 保留数据库相关的讨论` → `customInstructions`），这一点与 DSH 的 `/compact`（拒绝参数）不同，理由是 pi 的 `lane.compact({customInstructions})` 本来就支持，且压缩说明对「保留什么」很有用。

### 2.3 命中与拦截（两条发送路径都要）

```
用户输入以 / 开头
  ├─ 菜单：第三栏「指令」→ 选中插入 `/compact `（带参数提示），或直接回车执行
  └─ 发送：Composer.handleInputKeyDown（Enter）
        └─ 命中指令？→ 可用？→ 执行 → 不发消息（草稿由库自己清掉）
                    └─ 不可用 → preventDefault + 一行提示 + **保留草稿**
     OintRuntimeProvider.onNew（库的发送键 / Send primitive 也会走到这里）
        └─ 同一条判定（作为 backstop：按钮点击绕过 keydown）
```

要点：
- 库在调用 `onNew` **之前**就把 composer 文本清空了（`@assistant-ui/core/dist/store/clients/external-thread.js:668-680`），所以「不可用」的拦截必须发生在 Composer 的按键路径上，否则草稿会被清掉。`onNew` 里只做兜底（弹提示，草稿已清——命令文本本身没有内容损失，可接受）。
- 现有函数 `expandSlashInput` 只做「模板→正文」；新增一个纯函数（同文件、同测试风格）：

```ts
/** 发送前的总入口：展开模板 / 认领指令 / 原样放行 */
export type SlashDispatch =
  | { kind: "message"; text: string }
  | { kind: "command"; command: SlashCommand; rest: string };
export function dispatchSlashInput(value: string, commands: readonly SlashCommand[]): SlashDispatch;
```

### 2.4 压缩状态：扩展事件契约（shared/contracts/chat.ts）

```ts
export type CompactionReason = "manual" | "threshold" | "overflow";
export type CompactionStatus = "completed" | "declined" | "aborted" | "failed";

| { type: "compaction-started"; reason: CompactionReason; startedAt: number }
| { type: "compaction-ended"; reason: CompactionReason; status: CompactionStatus;
    /** 完成时的摘要前 200 字；其他状态为空串 */
    summaryPreview: string;
    /** 完成时：压缩前估算 tokens 与保留的近期消息条数 */
    tokensBefore?: number;
    retainedCount?: number;
    /** 失败时的可读原因（主进程已把内核 tag 转成人话） */
    error?: string }
```

主进程适配（`runtime.ts` 的 `compaction_start/end` 订阅）：
- 透传 `reason`；
- `completed` → 读 `compaction` 条目拿到 `summary` / `tokensBefore` / `retainedTail.length`；
- `failed` → `errorText(error)`；
- `declined / aborted` → 无 error（UI 显示「已取消」）。

### 2.5 渲染层状态机（chat-store）

用结构替换现在的裸字符串：

```ts
export interface SessionCompaction {
  phase: "running" | "completed" | "failed" | "cancelled";
  reason: CompactionReason;
  startedAt: number;
  endedAt?: number;
  preview?: string;       // completed
  tokensBefore?: number;  // completed
  retainedCount?: number; // completed
  error?: string;         // failed
}
compactions: Record<string, SessionCompaction>;  // 取代 compactionNotices
```

规则：
- `compaction-started` → 覆盖成 `{phase:"running", reason, startedAt}`；
- `compaction-ended` → 按 status 落 `completed / failed / cancelled`（**不再把失败写成空串** → 修 B1）；
- 会话被移除/关闭时随 `omitSession` 一起清（`chat-store.ts:797`）；
- 乐观态：`compact()` 被调用后立即写 `{phase:"running", reason:"manual", startedAt: now}`（IPC 往返之间就有提示）；调用以失败结果返回且期间没有任何事件到达 → 落 `failed`（I2）。

### 2.6 失败面：结构化 code + i18n

`chat.compact` 现在是 `Promise<void>`，失败靠抛异常，而 `handle()` 会把错误包成 `${action}失败：${detail}`（`ipc/handler.ts:4-7`）——渲染层拿不到稳定的失败类型，en-US 界面还会看到中文。

改成**结果对象**（与 `services.fetchModels` / `mcp.probe` 同风格，`api.ts:195-199`）：

```ts
compact(sessionId: string, instructions?: string):
  Promise<{ ok: true } | { ok: false; code: CompactFailureCode; message: string }>;

export type CompactFailureCode = "busy" | "nothing" | "unknown" | "failed";
```

主进程映射内核 tag（`result.d.ts`）：`LaneBusy → busy`、`NothingToCompact → nothing`、`Closed/UnknownTarget 等 → unknown`、其余 → `failed` + `errorText`。渲染层把 code 映射到 i18n，未知 code 回落到 `message`。

### 2.7 UI

**A. 顶部压缩条（`ThreadToolbar`，主提示位）** —— 三态：

| 状态 | 外观 |
| --- | --- |
| `running` | 档案图标 + `压缩中…`（ShimmerLabel）+ 原因后缀（`自动` / `手动` / `溢出恢复`）+ 已用秒数；`role="status"` |
| `completed` | `已压缩上下文 · 约 {{tokens}} tokens · 保留 {{count}} 条`，可展开看摘要（沿用现有 Collapsible） |
| `failed` | 红色一行：`压缩失败：{{error}}`；可关闭（点掉即清 `compactions[sessionId]`） |
| `cancelled` | 灰色一行 `压缩已取消`，几秒后自动消失（或同样点掉） |

**B. 输入框**：压缩中（且没有在跑）时——发送按钮禁用 + 一行提示「正在压缩上下文，完成后可继续发送」；回车不发送、**草稿保留**（避免 B2）。发送按钮已经按 `canSend` 控制禁用（`Composer.tsx:894-907`），这一处只是把条件扩成 `!canSend || (compacting && !running)`。

**C. 侧栏会话行**（P2，可选）：压缩中在会话标题旁显示「压缩中」，与现有「运行中」并列（`thread-list.aui.tsx:570` 已有 running 的读法）。

**D. 转录里的压缩分隔线**（P2，可选）：把已经被丢弃的 `compactionSummaries` 用起来，在消息流里插一条「上下文已压缩」的分隔行。

### 2.8 并发与边界（I3 的具体落法）

1. **`/compact` 的可用条件** = `!running && !compacting`；不满足时菜单里**置灰并给出原因**，回车拦截并提示（不发送、草稿保留）。
2. **压缩中禁止发送**：Composer 判 `compacting && !running` → 禁用发送 + 提示；`running === true` 时（自动压缩就发生在这种情况）不受影响，本来就走在排队/插话路径上。
3. **修 B2（主进程）**：`abortStaleOperation()` 只收敛 **残留的 run** —— 用 `lane.inspectExecution()` 看当前操作的 `kind`，仅在 `kind === "run"` 时 abort 并重试；当前是 `compaction` / `navigation` 时**不 abort**，直接把「会话正忙」如实报给渲染层。
   - 影响面：`runtime.ts:2624-2634`（send 的 LaneBusy 重试）。行为差异只在「lane 被压缩/导航占着」这一种情形，正是我们要保护的情形。
4. **取消压缩**（P2，可选）：压缩条上加「取消」→ 新增 `chat.cancelCompaction`，内部只调 `lane.abort()`，**不**走现有的 `stop()`（`stop()` 会伪造一条 `run-ended`，`runtime.ts:2858-2866`）。

---

## 3. 分阶段实施

每个阶段都能独立验收、独立回滚；Phase 1 不新增任何命令面，先让现有自动压缩的提示变对。

### Phase 1：压缩事件与提示（不新增命令）

| # | 改动 | 文件 |
| --- | --- | --- |
| 1.1 | 事件契约：`CompactionReason` / `CompactionStatus` / 扩展 `compaction-started`、`compaction-ended` | `src/shared/contracts/chat.ts:114-115` |
| 1.2 | 主进程适配：透传 reason/status，读 `compaction` 条目取 `tokensBefore`、`retainedTail.length`，失败带 `errorText`；`compactionPreview` 改名/扩展为 `compactionOutcome` | `src/main/pisdk/runtime.ts:1711-1725, 1843-1850` |
| 1.3 | store：`compactionNotices` → `compactions: Record<string, SessionCompaction>`（含移除清理） | `src/renderer/stores/chat-store.ts:420-421,797,1055-1062` |
| 1.4 | `ThreadToolbar` 三态渲染 + 失败可关闭 | `src/renderer/features/chat/ThreadToolbar.tsx` |
| 1.5 | i18n：`chat.compacting` / `compactingAuto` / `compactingManual` / `compactingOverflow` / `compactedSummary` / `compactionFailed` / `compactionCancelled` | 两个语言包 |
| 1.6 | 测试：事件→状态机（含 **failed 不再卡在 running**）、ThreadToolbar 三态 | `chat-store.test.ts`、新增 `ThreadToolbar.test.tsx` |

**验收**：触发一次自动压缩（长会话或临时调低阈值跑一次）→ 顶部出现「压缩中…（自动）」→ 结束显示「已压缩上下文 · 约 N tokens」；人为让压缩失败（例如断网/让摘要调用失败）→ 顶部变红并说明原因，**不再永久显示运行中**。

### Phase 2：指令骨架（与魔法提示分栏）

| # | 改动 | 文件 |
| --- | --- | --- |
| 2.1 | `commands.ts`：`CommandId` / `CommandSpec` / 内置清单（首批只有 compact） | 新增 `src/shared/contracts/commands.ts` |
| 2.2 | `slash-commands.ts`：`kind: "command"`、`SLASH_GROUPS` 三栏、`buildSlashCommands(skills, templates, commands)`、`insertSlashCommand`（指令 → `/name `）、`dispatchSlashInput` | `src/renderer/features/chat/slash-commands.ts` |
| 2.3 | 菜单第三栏（图标 + 组标题） | `SlashCommandMenu.tsx:13-17,80-110` |
| 2.4 | Composer：`useSlashCommands` 注入内置指令；Enter 路径认领指令（可用性判定 + 不可用时保留草稿） | `Composer.tsx:649-767`、`use-slash-commands.ts` |
| 2.5 | provider：`onNew` 改走 `dispatchSlashInput`，命中指令就执行、不发消息 | `OintRuntimeProvider.tsx:36-47,85-92` |
| 2.6 | 指令执行器（渲染层）：`features/chat/commands.ts`，`runCommand(spec, rest, ctx)` 分发到 store action | 新增 |
| 2.7 | i18n：`chat.slashCommands`（组标题）、`chat.commandCompactDesc`、`chat.commandCompactHint` | 两个语言包 |
| 2.8 | 测试：`slash-commands.test.ts`（三栏顺序、`/compact` 解析与参数、与技能/模板重名互不干扰）、`Composer.slash.test.tsx`（菜单出现「指令」栏、`/compact` **不会**被当消息发出） | 现有测试文件 |

**验收**：敲 `/` 看到三栏；`/compact` 排在技能前；发送 `/compact` 时不产生用户消息（用测试钉住），而是调用指令执行器。

### Phase 3：`/compact` 接入 pi 的 compact

| # | 改动 | 文件 |
| --- | --- | --- |
| 3.1 | 契约改为结果对象：`compact(): Promise<CompactResult>` + `CompactFailureCode` | `src/shared/contracts/api.ts:103`、`src/preload/index.ts:49-50` |
| 3.2 | 主进程：tag → code 映射；`busy / nothing / failed` 文案兜底 | `src/main/ipc/chat.ts:53-59`、`src/main/pisdk/runtime.ts:2958-2966` |
| 3.3 | store action：乐观态 + 结果处理（失败落 `failed`、清乐观态） | `chat-store.ts:875-879` |
| 3.4 | 可用性：运行中/压缩中菜单置灰 + 回车拦截提示 | `Composer.tsx`、`SlashCommandMenu.tsx` |
| 3.5 | i18n：`chat.compactBusy` / `compactNothing` / `compactFailed` / `compactUnavailableRunning` | 两个语言包 |
| 3.6 | 测试：ipc 映射（含 LaneBusy/NothingToCompact）、store 乐观态与失败清理、UI 置灰 | `ipc/chat.test.ts`、`chat-store.test.ts`、`Composer.slash.test.tsx` |

**验收**：手动 `/compact` 成功 → 顶部「压缩中（手动）」→ 「已压缩 · 约 N tokens」；对话很短时 → 「没有可压缩的历史」；运行中执行 → 菜单置灰 + 明确提示，**不会**发出消息、不会打断本轮。

### Phase 4：边界加固（修 B2 与增强）

| # | 改动 | 文件 |
| --- | --- | --- |
| 4.1 | `abortStaleOperation` 收窄到 `kind === "run"` | `runtime.ts:521-534, 2624-2634` |
| 4.2 | 压缩中发送策略：禁用 + 提示（默认）；可选 P2「排队并在压缩结束后自动发出」 | `Composer.tsx`、可能 `runtime.ts` 的 `queue()` |
| 4.3 | 取消压缩（P2，可选）：`chat.cancelCompaction` + 条上按钮 | `api.ts`、`ipc/chat.ts`、`runtime.ts`、`ThreadToolbar.tsx` |
| 4.4 | 测试：`runtime.test.ts` 增「压缩占着 lane 时 prompt 不会 abort 压缩」 | `src/main/pisdk/runtime.test.ts` |

### Phase 5：文档与回归

- README「功能」表加一行「指令」；`docs/slash-commands-and-prompts-report.md` 的 §4.2 标注为已实施；
- `npm run typecheck`、`npm test`、`npm run lint`、`npm run check:i18n`、`npm run check:unwired`；
- 手工冒烟清单（见 §6）。

---

## 4. 文件清单

**新增**

| 文件 | 内容 |
| --- | --- |
| `src/shared/contracts/commands.ts` | `CommandId`、`CommandSpec`、`BUILTIN_COMMANDS` |
| `src/renderer/features/chat/commands.ts` | 指令执行器（`compact` → `useChatStore.getState().compact(rest)`） |
| `src/renderer/features/chat/ThreadToolbar.test.tsx` | 压缩条三态 |
| `src/main/ipc/chat.test.ts`（新建；该文件目前不存在） | IPC 结果对象与失败码 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `src/shared/contracts/chat.ts` | 压缩事件扩展 |
| `src/shared/contracts/api.ts` | `chat.compact` 结果对象；可选 `cancelCompaction` |
| `src/preload/index.ts` | 透传结果对象 |
| `src/main/ipc/chat.ts` | 结果对象 + code 映射 |
| `src/main/pisdk/runtime.ts` | 事件适配（reason/status/tokens/error）、`abortStaleOperation` 收窄、可选 cancelCompaction |
| `src/renderer/stores/chat-store.ts` | `compactions` 状态机、`compact()` 乐观态与失败处理 |
| `src/renderer/features/chat/slash-commands.ts` | `kind: "command"`、三栏、`dispatchSlashInput` |
| `src/renderer/features/chat/slash-commands.test.ts` | 三栏与指令解析 |
| `src/renderer/features/chat/use-slash-commands.ts` | 注入内置指令 |
| `src/renderer/features/chat/SlashCommandMenu.tsx` | 第三栏 + 置灰 + 原因 |
| `src/renderer/features/chat/Composer.tsx` | 指令认领、不可用拦截、压缩中禁用发送 |
| `src/renderer/features/chat/Composer.slash.test.tsx` | 指令不产生消息 |
| `src/renderer/runtime/OintRuntimeProvider.tsx` | `onNew` 走 `dispatchSlashInput` |
| `src/renderer/features/chat/ThreadToolbar.tsx` | 三态压缩条 |
| `src/shared/i18n/locales/zh-CN.ts` / `en-US.ts` | 新词条（见 §5） |
| `README.md` | 功能表 |

---

## 5. i18n 词条（zh / en）

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `chat.slashCommands` | 指令 | Commands |
| `chat.commandCompactDesc` | 压缩较早的对话历史 | Compact older conversation history |
| `chat.commandCompactHint` | 可选的压缩说明（保留什么 / 侧重什么） | Optional instructions (what to keep) |
| `chat.compacting` | 压缩中 | Compacting |
| `chat.compactingAuto` | 自动压缩 | automatic |
| `chat.compactingManual` | 手动压缩 | manual |
| `chat.compactingOverflow` | 溢出恢复 | overflow recovery |
| `chat.compacted` | 已压缩上下文 · 约 {{tokens}} tokens · 保留 {{count}} 条 | Context compacted · ~{{tokens}} tokens · {{count}} kept |
| `chat.compactionFailed` | 压缩失败：{{error}} | Compaction failed: {{error}} |
| `chat.compactionCancelled` | 压缩已取消 | Compaction cancelled |
| `chat.compactBusy` | 正在压缩，稍后再试 | Compaction already in progress |
| `chat.compactNothing` | 没有可压缩的历史（对话还很短） | No compactable history yet |
| `chat.compactUnavailableRunning` | 运行中不能压缩，等这一轮结束再试 | Cannot compact while running |
| `chat.compactWhileCompacting` | 正在压缩上下文，完成后可继续发送 | Compacting context; sending resumes when it finishes |

> 两个语言包都要加；`npm run check:i18n` 会用真实 locale 解析逐个校验。

---

## 6. 测试与验收

### 自动化

| 层 | 测试 | 断言要点 |
| --- | --- | --- |
| 纯逻辑 | `slash-commands.test.ts` | 三栏顺序 `command → skill → template`；`/compact` 命中指令且 `rest` 为参数原文；与同名技能/模板互不干扰；`insertSlashCommand` 指令 → `/compact ` |
| store | `chat-store.test.ts` | `compaction-started/ended` 各 status → 正确 phase；**failed 不保留 running**；`compact()` 乐观态在失败时被清 |
| UI | `Composer.slash.test.tsx` | 「指令」栏出现；`/compact` 不调用发送、产生零条消息；不可用时草稿保留 |
| UI | `ThreadToolbar.test.tsx` | 三态文案与可关闭失败行 |
| 主进程 | `runtime.test.ts` | 事件适配透传 reason/status/tokens；**lane 被压缩占住时 prompt 不 abort 压缩** |
| 主进程 | `ipc/chat.test.ts` | `LaneBusy → busy`、`NothingToCompact → nothing`、未知 → `failed` |

### 手工冒烟

1. 长会话（> 窗口 − 20k）正常发消息 → 顶部出现「压缩中（自动）」→ 结束显示统计；
2. 短会话 `/compact` → 「没有可压缩的历史」；
3. `/compact 保留数据库相关的讨论` → 压缩成功且摘要体现该侧重；
4. 运行中点 `/compact` → 菜单置灰、回车提示、本轮不受影响；
5. 压缩中按发送 → 不发送、草稿保留、压缩不被中断（B2）；
6. 压缩失败（临时让摘要请求失败）→ 红色失败行、可关闭、输入框恢复可用。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 事件契约改动影响既有测试 | `chat-store.usage-persist.test.tsx` 等引用了 `compactionNotices` | Phase 1 一并更新；字段替换而非叠加，避免两套真相 |
| `abortStaleOperation` 收窄后，残留的 **navigation** 也会挡住重试 | 极少数「上次 stop 没收尾」变成报错而非自愈 | 报错文案指向「停止后重试」；必要时把导航也纳入收敛白名单 |
| 压缩中禁用发送影响手感 | 用户觉得被卡住 | 条上显示已用时间；P2 提供「排队自动发出」与「取消压缩」 |
| 主进程 code ↔ i18n 不一致 | 出现裸 code | 未知 code 回落 `message`；`check:i18n` 保证词条存在 |

回滚：Phase 1 只改事件与 UI，回滚即恢复 `compactionNotices`；Phase 2/3 的指令面是新增分支，去掉 `BUILTIN_COMMANDS` 条目即可让 `/compact` 从菜单消失（发送路径回落为原样发文本）。

---

## 8. 需要你拍板

1. **压缩中的发送策略**：禁用发送 + 提示（推荐，改动最小、不会误伤压缩）／ 允许排队并在压缩结束后自动发出（体验更好，但要动主进程 `queue()` 的「空闲即转发 send」分支与渲染层的队列状态）。
2. **`chat.compact` 改成结果对象**（推荐，能给出稳定错误码与 en-US 文案）／ 保持抛异常只做中文文案（更快，但英文界面会看到中文错误）。
3. **是否顺带做 P2 的两项**：转录里的「上下文已压缩」分隔线（把已在契约里但被丢弃的 `compactionSummaries` 用起来）、侧栏会话行的「压缩中」标记。
4. **压缩参数**：`/compact <说明>` 走 `customInstructions`（推荐）／ 与 DSH 一致地拒绝任何参数。
