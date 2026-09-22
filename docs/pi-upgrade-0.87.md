# pi 内核升级 0.85.1 → 0.87.0

> 升级日期：本次提交 · 影响范围：`@earendil-works/pi-agent-core` / `pi-ai` /
> `pi-session-backend-sqlite-node`，外加 `typebox` 对齐。
> 原则：**全面改用新 API，不保留旧 API 兼容代码**。

---

## 一、结论

| 包 | 旧 | 新 | 说明 |
| --- | --- | --- | --- |
| `@earendil-works/pi-agent-core` | 0.85.1 | **0.87.0** | 0.86.0 是真正的大改版 |
| `@earendil-works/pi-ai` | 0.85.1 | **0.87.0** | `TranscriptContext` 等 |
| `@earendil-works/pi-session-backend-sqlite-node` | 0.85.1 | **0.87.0** | **纯版本号**：dist 逐字节相同 |
| `typebox` | 1.3.7 | **1.3.27** | 内核 pin 的就是 1.3.27 |

> **版本断代的真相**：破坏性变更几乎全在 **0.86.0**（2026-09-19），不是 0.87.0。
> 0.87.0 真正新增的只有 `finishTurn` / `prepareRequest` / `peekQueuedMessages`。
> `@earendil-works/chord` 与 `pi-telemetry` 都**不是**新依赖（0.85.0 / 0.84.0 就有）。

---

## 二、本次实际改动

### 2.1 代码（2 处，都是「不跟上就静默出错」的那类）

#### （1）`exec-env.ts` —— 补 `openTextLineReader`

0.86.0 给 `FileSystem` 接口加了**必需**方法 `openTextLineReader`（拉取式逐行读取，
`TextLine` 带 `terminated` 字段以区分「尾行没有换行符」）。Oint 的 `createExecEnv`
是包在 `NodeExecutionEnv` 外面的一层路径守卫，接口方法必须逐个转发，否则 tsc 直接红：

```ts
async openTextLineReader(requested, context) {
  const check = guard(requested);
  if (!check.ok) return err<never, FileError>(check.error);
  return inner.openTextLineReader(check.path, context);
},
```

这是**本次升级唯一一处硬编译错误**。守卫语义与其它方法一致：越界路径在碰盘之前就被拒。

#### （2）`known-models.ts` —— provider 清单改为上游枚举

原来手写 39 个 provider 的子路径 import。0.86.0 新增了 `meta` 与 `radius` 两个 provider
（总数 39 → 41），手写清单**静默漏掉**它们：用户填 `radius/claude-opus-4-5` 时匹配不到
档位信息，界面只是少几档可选，不会报错。

改为 pi-ai 官方的 `providers/all`：

```ts
const all = await loadBuiltinCatalog();          // 动态 import，见下
all.getBuiltinProviders().map((provider) => ({
  provider,
  models: [...all.getBuiltinModels(provider)],
}));
```

**关键约束：必须保持动态 import。** `providers/all` 会把 41 个 provider 工厂连同各自的
SDK 适配层一起拉进来，实测 **~190 ms**。而这份目录只在「用户填模型 ID」这一刻才需要，
没有理由进主进程启动路径 —— 原来的懒加载设计是刻意的，改造后依然只在首次匹配时加载。

对应地，`PROVIDER_CATALOG_COUNT` 这个同步常量改成了异步 `providerCatalogCount()`
（同步常量会迫使模块顶层 await 上游 import，正好破坏懒加载）。

### 2.2 依赖对齐：`typebox`

Oint 自己用 typebox 造工具 schema，内核再把同一批 schema 送进**它自己的** typebox 类型系统。
旧仓 pin `1.3.7`、而 pi 0.87 pin `1.3.27` → 装出**两份 typebox**。已对齐到 `1.3.27`，
npm 现在 dedupe 成单实例（`npm ls typebox` 三处都是 `1.3.27 deduped`）。

### 2.3 新增两个探针（见下节）

---

## 三、验证

### 3.1 门禁

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（渲染 + 主进程 + preload） |
| `npm run lint` | 通过（414 文件） |
| `npm test` | **1786 通过** / 1 skipped（128 文件） |
| `npm run build` | 通过 |
| `npm run pack` | 通过（`release/win-unpacked`，含 42 份 provider 目录 JSON） |

### 3.2 `npm run probe:kernel` —— 离线、免凭据（5/5）

用真实 API 逐条验证本次动过的接口，不发任何模型请求：

1. `openTextLineReader` 真能逐行读完，且尾行 `terminated=false`；`readTextLines` 未回归
2. `providers/all` 枚举出 41 provider / 1445 模型，含 `meta`、`radius`；provider 字段自洽
3. `SystemMessage` 承载提示与 `toolsAdded`；`getSystemMessageText` 渲染 content+sections；
   `normalizeContext` 回放一致
4. 两种同名 `estimateContextTokens` 的区别（见「四、易踩点」）
5. `AgentHarness.create` + lane 装配成功，工具 schema 可序列化

### 3.3 `npm run probe:packaged` —— 打包后（7/7）

**这条是本次升级最关键的证据。** 打包后 pi 住在 `app.asar` 里，`providers/all` 要跨 40+
子模块动态 import、还要从归档里读 JSON —— 「node 下能跑」不等于「打包后能跑」。该探针用
**Electron 自己的 node 运行时**、对着 `release/win-unpacked/resources/app.asar` 验证：

pi-ai 根导出 · pi-agent-core 根导出 · `providers/all` 枚举（41/1445）·
provider 目录 JSON 可读 · typebox 与内核 schema 互通 · `openTextLineReader` 存在 ·
sqlite 会话后端可用。

---

## 四、易踩点

### 4.1 两个同名 `estimateContextTokens`

名字一样、签名不同，**且 pi-ai 那个没从根导出**：

| 来源 | 入参 | 备注 |
| --- | --- | --- |
| `@earendil-works/pi-agent-core` | `AgentMessage[]` | 传 `TranscriptContext` 会抛 `messages is not iterable` |
| `@earendil-works/pi-ai/utils/estimate` | `TranscriptContext \| Message[]` | TranscriptContext 形态会把 system 消息的提示与 `toolsAdded/toolsRemoved` 一起算 |

从 `@earendil-works/pi-ai` 根 import `estimateContextTokens` 会得到
**「does not provide an export named」** —— 只能走 `utils/estimate` 子路径。

### 4.2 pi 的包是 ESM-only

`exports` 里只有 `import` 条件，**`require()` 会报
`No "exports" main defined`**。探针脚本里一律用动态 `import()`。
（这也是 `vite.renderer.config.ts` 必须把依赖 external 化的原因，见该文件注释。）

### 4.3 0.87.0 的破坏性变更：`shouldStopAfterTurn` 已删除

→ `finishTurn`（返回 `{ action: "end" }`）。**Oint 未使用该钩子**，故无改动。
若将来要用，注意语义差异：`finishTurn` 对 error/aborted 响应也会触发（其决定被忽略），
且无条件返回 `{ action: "continue" }` 会造成死循环。

同时 0.87.0 **未在 changelog 里记录**地删除了这些导出（已确认本仓均未使用）：
`classifyForkAddress`、`ForkDisposition`、`forkSnapshotWrites`、`NormalizedLegacyV3Records`、
`normalizeLegacyV3Records`、`retryDelay`、`ShouldStopAfterTurnContext`、`splitDeferredTools`。

### 4.4 `executionMode` / `toolExecution: "parallel"` 不是新东西

两者在 0.85.1 就已存在（`parallel` 还是默认值），本次**没有**因此改动任何工具装配。

### 4.5 未采纳：`experimental/pico3`

0.86.0 新增了 `@earendil-works/pi-agent-core/experimental/pico3`（另一套实验内核 +
Chord 集成）。**明确不采纳**：上游自己在导出注释里写着 "intentionally separate …
while the kernel and its Chord integration are being validated"，属于验证中的实验面。
Oint 的 `AgentHarness` + lane 装配在 0.87.0 下完全可用（探针 5/5），没有理由迁移到未定型的
内核上。**待其转正后再评估。**

---

## 五、复现

```bash
npm install                 # 装 0.87.0 + typebox 1.3.27
npm run typecheck && npm run lint && npm test
npm run probe:kernel        # 离线内核探针（免凭据）
npm run pack                # 打包
npm run probe:packaged      # 对着 app.asar 验证
```
