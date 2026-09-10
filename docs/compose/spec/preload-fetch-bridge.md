---
feature: preload-fetch-bridge
status: delivered
updated: 2026-09-10
branch: main
commits: 6985669..working-tree
---

# preload 出网桥接修复（Connection error）

## Report

**What was built** — 把出网桥接从「传递 Response」改为「传递事件与字节」。preload 的 `network.fetchStream` 现在只做转发：接收 `request` 与一个主世界回调，逐条投递 `meta` / `chunk` / `done` / `error` 事件，并返回 `{ abort }` 句柄；`ReadableStream` 与 `Response` 一律在渲染层主世界由 `ipcFetch` 组装。中转层不再出现任何跨桥不兼容对象，SDK 拿到的因此是一个真实可用的 `Response`。

出网失败时不再直接 reject，而是合成一个 502 响应、把真实原因写进 `{"error":{"message":"…"}}`。这样 OpenAI SDK 会据其构造带 status/body 的 `APIError`，pi-ai 的 `normalizeProviderError` 能把该 body 拼进 `errorMessage`，界面从此显示可定位的原因而不是写死的 `Connection error.`。中止仍走 reject/`AbortError`，与传输失败严格区分。

**Verification** — `npm run typecheck` PASS（renderer + electron）；`npm test` PASS（4 文件 28 用例，新增 6 条桥接回归）；`npm run build` PASS（renderer / main / preload 三进程）；用户在真实应用中实测对话可用。

**Journey log**

- 定位手段是逐个假设做探针，而不是读代码猜：先证明主进程 `net.fetch` 出网完全正常（200 + SSE 可增量读取），再排除 preload 未加载（沙箱下 `window.polaragent` 存在），最后用 contextBridge 类型测试一击命中 —— `Response` 过桥退化为 `{}`，`ReadableStream` 方法丢失，而 `ArrayBuffer`、入参回调、返回的函数句柄都正常。**跨桥可行性要实测，不能凭直觉。**
- 该缺陷不是本次重构引入：v0.6.0 的 `main.tsx` 没有 `installIpcFetch`、preload 也没有 `fetchStream`，那条路径走的是 `llm:*` 主进程 IPC。这套桥接是更早一批未提交改动加的。
- 真凶之所以只显示 `Connection error.`，是因为 OpenAI SDK 把任何非 `APIError` 异常统一包装成 message 硬编码的 `APIConnectionError`（原始错误只落在 `cause`），而 pi-ai 只读 `error.message`、从不遍历 `cause`。**两层都在吞原因**，所以修复必须让错误走 SDK 既有的错误模型（合成带 body 的 502），而不是试图把原因塞进 message。
- 独立审查抓到一个我漏掉的 critical：`meta` 已在途后再中止，body 流既不 `error` 也不 `close`，调用方的 `response.text()` 会永久挂起 —— 表现为点「停止」后整轮对话卡死。原因链是 openai SDK 的流迭代器不与 signal 竞速。**「先回响应头、再把 body 交给 SDK」这类桥接，中止时必须显式 `error(AbortError)` 该流。**
- 两个新回归用例在旧实现下确实以「超时」失败（已实测确认），不是恰好通过。

## [S1] Problem

对话发送后界面显示「这次响应没有完成：Connection error.」，但模型 API 的后台记录显示请求成功（200 + SSE）。

根因（已实测确认）：`Response` 与 `ReadableStream` **无法通过 Electron `contextBridge` 传递**。preload 的 `network.fetchStream` 返回 `Promise<Response>`，渲染层实际拿到的是空对象 `{}`（`constructor.name === "Object"`、`Object.getOwnPropertyNames` 为空、`status`/`body`/`text` 全为 `undefined`）。

于是 OpenAI SDK 拿到 `{}` 后在请求流程内部抛错（读取 `response.headers`/`response.body` 失败），SDK 的 catch 把任何非 `APIError` 异常统一包装为 `APIConnectionError`，而该错误的 message 是写死的默认值 `"Connection error."`（`node_modules/openai/core/error.js:80`）。pi-ai 捕获后只取 `error.message` 生成 `output.errorMessage`（`pi-ai/dist/api/openai-completions.js:518` + `pi-ai/dist/utils/error-body.js:16` 的 `normalizeProviderError` 只读 `message`，从不遍历 `cause`），因此真实原因被永久丢失，界面只能看到笼统的 `Connection error.`。

请求本身确实成功：出网留在主进程 `net.fetch`，实测 200 + `text/event-stream` 可正常增量读取。失败发生在「响应回传渲染层」这一步。

影响面不止对话：`src/ai/llm-call.ts:225` 也走同一个 `ipcFetch`，因此标题生成、工具权限审查、结构化输出同样静默失败。

顺带排除的路径：目标网关的 CORS 预检返回 **403**，所以「退回渲染层原生 fetch、依赖 CORS」不可行，出网必须留在主进程。

## [S2] Design

### S2.1 桥接契约（新）

`preload/index.ts` 的 `network.fetchStream` 改为**事件回调式**，preload 内不再构造任何 `Response` / `ReadableStream`：

```ts
network: {
  fetchStream(
    request: { url: string; method?: string; headers?: Record<string, string>; body?: string },
    onEvent: (event: FetchStreamEvent) => void,
  ): { abort: () => void };
}

type FetchStreamEvent =
  | { type: "meta"; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: "chunk"; data: ArrayBuffer }
  | { type: "done" }
  | { type: "error"; message: string };
```

主进程侧（`src/main/ipc/network.ts` 的 `network:fetch-stream` 通道）**不变**，它已经按上述事件形状 postMessage，问题只在 preload 的出口。

跨桥类型约束（本契约的依据，均已实测）：

| 类型 | 能否跨 `contextBridge` | 证据 |
| --- | --- | --- |
| 普通对象 / 数组 / 字符串 / 数字 | 可以 | `meta` 事件的 `status`/`headers` 完整到达 |
| `ArrayBuffer`（chunk 载荷） | 可以 | 到达后 `instanceof ArrayBuffer` 为真，`byteLength` 与内容解码正确 |
| 函数（主世界传入的回调） | 可以，且可在 preload 内被调用 | 回调收到 meta/chunk/done 三个事件 |
| 函数（preload 返回的句柄） | 可以，且可在主世界调用 | `abort()` 调用后状态变为已中止 |
| `Response` | **不可以**，退化为空对象 | `constructor.name === "Object"`、零自有属性 |
| `ReadableStream` | **不可以**，方法丢失 | `typeof stream.getReader !== "function"` |
| `AbortSignal` | 不可依赖 | `init.signal` 到 preload 后不是真正的 AbortSignal，`aborted` 只能读到快照 |

### S2.2 渲染层重建 Response

`src/lib/electron/electron-api.ts` 的 `ipcFetch` 在主世界完成 `ReadableStream` + `Response` 的构造：

- 立即创建 `ReadableStream<Uint8Array>`，`cancel()` → 调用 preload 返回的 `abort()`。
- `meta` 事件 → `resolve(new Response(stream, { status, statusText, headers }))`；headers 由 `Array<[string, string]>` 逐条 `append`，非法头名忽略。
- `chunk` 事件 → `controller.enqueue(new Uint8Array(event.data))`。
- `done` 事件 → `controller.close()`。
- `error` 事件（首字节之前）→ 见 S2.3；首字节之后 → `controller.error(new Error(message))`。
- 中止：`init.signal` 在主世界监听；`aborted` 时先调用 `abort()` 句柄停止主进程出网，然后分两种情况 —— 尚未 resolve 时以 `AbortError`（`new DOMException(..., "AbortError")`）reject；已 resolve（响应头已交给调用方）时以同一个 `AbortError` **`controller.error(...)` 终结 body 流**。两条路径都不可省：只 reject 不 error 会让调用方的 `response.text()` 永久挂起（openai SDK 的流迭代器不与 signal 竞速），而合成 502 又会把中断误判成连接失败。

`installIpcFetch()` 与「非 Electron 回退原生 fetch」的行为保持不变。

### S2.3 让真实原因活下来

约束：无法修改 pi-ai / OpenAI SDK；pi-ai 只读 `error.message`，`cause` 必然丢失。

因此改为让真实原因**走 SDK 既有的错误模型**：主进程侧出网失败（首字节之前）时，`ipcFetch` 不 reject，而是**合成一个 502 响应**，body 为 `{"error":{"message":"<真实原因>"}}`、`content-type: application/json`。OpenAI SDK 会据其构造 `InternalServerError`（带 `status` 与 `error`），pi-ai 的 `normalizeProviderError` 会从 `error.error` 提取 body 并组装成 `"502: {...}"`，真实原因随即可见。

中止仍走 reject + `AbortError`（不能合成响应，否则中断会被误判为错误）。

`src/ai/llm-call.ts` 的 `postJsonLike` 对非 2xx 已有 `throw new Error(\`${status} ${statusText}: ${rawText}\`)`，因此同一改动让它也拿到可读原因。

## [S3] Out of Scope

- 不修改 pi-ai / openai SDK 内部（`node_modules` 不动）。
- 不新增请求超时、日志或重试策略（`llm-call` 已有自己的重试）。
- 不改网关 CORS 行为，不引入渲染层直连出网。
- 不改 `chat-store` 的错误文案模板（`这次响应没有完成：…`）。
- 不改主进程 `network:fetch-stream` 的事件形状与 `net.fetch` 出网实现。

## Tasks

- [x] T1: preload 契约改为回调式 — acceptance: `preload/index.ts` 不再出现 `new Response`/`new ReadableStream`；`fetchStream(request, onEvent)` 返回 `{ abort }` (covers: S2.1)
- [x] T2: 渲染层重建 Response、接中止、合成 502 — acceptance: `ipcFetch` 在主世界构造 `ReadableStream`/`Response`；中止 reject `AbortError`；首字节前失败返回 502 且 body 携带真实原因 (covers: S2.2, S2.3)
- [x] T3: 同步 `vite-env.d.ts` 的 `network.fetchStream` 类型 — acceptance: 类型检查通过且签名与新契约一致 (covers: S2.1, S2.2; depends: T1)
- [x] T4: 补回归测试 — acceptance: vitest 用例覆盖「正常流式读取」「中止」「出网失败暴露原因」三条路径且通过 (covers: S2.2, S2.3; depends: T2)
- [x] T5: 全量验证 — acceptance: `npm run typecheck` / `npm test` / `npm run build` 全绿 (covers: S2; depends: T1-T4)
- [x] T6: 修 meta 后中止挂起 — acceptance: 收到响应头后中止，body 读取以 `AbortError` 结束而非永久挂起；中止不被误判为出网失败；两条用例在旧实现下以超时失败 (covers: S2.2)
