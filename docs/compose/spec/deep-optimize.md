---
feature: deep-optimize
status: delivered
updated: 2026-02-12
branch: main
commits: 9012148..working-tree
---

# PolarAgent 深度优化（安全 · 类型 · 测试 · 构建）

## Report

**What was built** — 在 main 工作树完成一轮可验证的深度优化：将 7 个落后依赖升到最新（另为严格类型补充 `@types/ws`）；新增 `session-security` 模块并接入主进程——应用 UI 的 CSP 注入、权限白名单（media / clipboard-sanitized-write / fullscreen）、`will-navigate` 与 webview 阻断、`openExternal`/`preview:open` 仅允许 http(s)；Office 隐形窗口使用 `partition: "polaragent-office"` 与应用会话隔离。`tsconfig.electron.json` 打开 `strict` 与 `useUnknownInCatchVariables`，修复主进程/preload 全部约 895 处严格类型错误且不改运行时语义。补齐 session-security / http-utils / security 扩展共 23 条单测。Vite `manualChunks` 将 mermaid / pdf / katex / hljs / react 拆出独立 chunk。

**Verification** — `npm run typecheck` PASS；`npm test` PASS（3 files / 23 tests）；`npm run build` PASS，产物含 `chunk-mermaid`（~4.0MB）、`chunk-katex`（~548KB）、`chunk-pdf`（~430KB）、`chunk-react`（~200KB）、`chunk-hljs`（~154KB）。独立 Review 子代理确认五条验收均满足，无 critical 正确性/安全回归。

**Journey log** —
1. 依赖几乎已贴最新，真正的缺口在安全/类型/测试/构建，而非版本号。
2. 打开 electron `strict` 一次性暴露约 900 处隐式 any，适合用并行子代理按文件批处理；策略是补显式类型而非放宽 tsconfig。
3. 主应用 CSP 与 Office 用户 HTML 渲染冲突——用 session partition 隔离，而不是给 CSP 开外挂洞。
4. Review 指出的 `ipc-types` 死代码、preview 未走统一校验、will-navigate 过宽兜底已当场收掉。
5. 重型 chunk（尤其 mermaid ~4MB）仍在主入口可达图上；后续可再做动态 import 才能真正延迟加载。
6. 过严 CSP 会在 dev 白屏：`@vitejs/plugin-react` 注入 inline preamble，`script-src 'self'` 会拦掉。dev 需 `'unsafe-inline'`，prod 仍保持 `'self'`。

## [S1] Problem

当前仓库依赖几乎已贴最新线（仅 7 个包落后 patch/minor），但工程整体仍有可验证的安全与质量缺口：

1. 主/预览窗口无 Content-Security-Policy；`app:open-external` 未做协议校验；无 `setPermissionRequestHandler`；无 `will-navigate` 导航约束。
2. `tsconfig.electron.json` 关闭了 `strictNullChecks` / `noImplicitAny` / `useUnknownInCatchVariables`，主进程类型安全弱于渲染进程。
3. 单测仅 4 条，集中在 security 模式与关键路径前缀；shell 危险命令、URL 校验、http-utils 无覆盖。
4. Vite 未对 mermaid / pdfjs / katex / highlight.js 等重型依赖做分包，首包体积偏大。

## [S2] Design

### S2.1 依赖升级

将 `npm outdated` 中 Current ≠ Latest 的包升到 Latest，并更新 `package-lock.json`：

| 包 | 从 | 到 |
| --- | --- | --- |
| @earendil-works/pi-agent-core | 0.85.0 | 0.85.1 |
| @earendil-works/pi-ai | 0.85.0 | 0.85.1 |
| electron | 44.2.0 | 44.3.0 |
| @types/node | 26.4.1 | 26.5.0 |
| jszip | 3.10.1 | 3.10.2 |
| katex | 0.18.5 | 0.18.7 |
| lucide-react | 1.41.0 | 1.43.0 |

另新增 devDependency `@types/ws`（严格类型所需）。安装使用现有 `.npmrc` 的 electron 镜像；不升级 major。

### S2.2 Electron 安全加固

在主进程 `src/main/lib/session-security.ts`，并在 `app.whenReady` 后统一安装：

1. **CSP**（`session.defaultSession.webRequest.onHeadersReceived`）  
   - 仅对应用 UI（`file:` 的 `dist/**`，或 dev 下 `VITE_DEV_SERVER_URL`）注入响应头 CSP。  
   - **不**拦截 office 窗口（独立 `partition: "polaragent-office"`）加载的用户 HTML。  
   - 生产策略：`default-src 'self'`; `script-src 'self'`; `style-src 'self' 'unsafe-inline' https:`; `img-src 'self' data: blob: https:`; `font-src 'self' data: https:`; `connect-src 'self'`（dev 追加 `ws:`/`http://127.0.0.1:1420`）; `object-src 'none'`; `base-uri 'self'`; `form-action 'none'`; `frame-ancestors 'none'`。
2. **权限** — 默认拒绝；白名单 `media`、`clipboard-sanitized-write`、`fullscreen`（request + check）。
3. **导航与窗口** — `will-navigate` 仅允许 dev/prod 应用 UI；`will-attach-webview` 阻止；外开窗口 http(s) → `shell.openExternal`。
4. **openExternal** — `app:open-external` 与 `preview:open` 统一走 `isSafeExternalUrl`（仅 http/https）。

### S2.3 主进程严格类型

`tsconfig.electron.json`：`strict: true` + `useUnknownInCatchVariables: true`；保持 `skipLibCheck`。修复 `src/main/**`、`src/preload/**` 全部类型错误；`npm run typecheck` 通过。

### S2.4 关键路径测试

| 文件 | 覆盖 |
| --- | --- |
| `src/main/lib/security.test.ts` | readonly/safe 拦截 shell 与写路径；`validateExternalAccess` 协议白名单 |
| `src/main/lib/http-utils.test.ts` | `normalizeBaseUrl`、`normalizeWebUrl`、`errorMessage` |
| `src/main/lib/session-security.test.ts` | CSP 组装、权限白名单、URL/导航决策（纯函数） |

### S2.5 构建体积优化

`vite.renderer.config.ts` `manualChunks`：`chunk-mermaid` / `chunk-pdf` / `chunk-katex` / `chunk-hljs` / `chunk-react`。`npm run build` 成功并产出上述 chunk。

## [S3] Out of Scope

- 不拆分 `agent.ts` / `office.ts` / `browseruse.ts` 等大文件重构。
- 不扩大 Electron e2e / UI 自动化。
- 不升级任何 major 版本；不更换打包器或引入新运行时框架。
- 不改产品功能语义（安全模式四级策略、IPC 协议保持兼容）。
- 不在本轮做渲染层 React 性能调优（memo/profiling）。

## Tasks

- [x] T1: 升级 7 个落后依赖并刷新 lockfile — acceptance: `npm outdated` 无 Current≠Latest；typecheck 仍通过 (covers: S2.1)
- [x] T2: 实现 session-security 并接入窗口/IPC — acceptance: 生产 CSP 头存在；openExternal 拒绝非 http(s)；权限默认拒绝且 media 白名单可用 (covers: S2.2; depends: T1)
- [x] T3: 打开 electron 严格类型并修复 — acceptance: `tsc -p tsconfig.electron.json --noEmit` 在 strict 子项开启后通过 (covers: S2.3; depends: T1)
- [x] T4: 补齐 session-security / http-utils / security 扩展测试 — acceptance: `npm test` 全部通过且新增用例覆盖 S2.4 表 (covers: S2.4; depends: T2)
- [x] T5: Vite manualChunks 分包 — acceptance: build 产物含 chunk-mermaid/pdf/katex/hljs/react；`npm run build` 成功 (covers: S2.5)
- [x] T6: 全量验证与自检 — acceptance: typecheck + test + build 均 PASS，并记录命令结果 (covers: S2.1-S2.5; depends: T2, T3, T4, T5)
