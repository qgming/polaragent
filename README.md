<div align="center">
  <img src="public/logo.png" alt="PolarAgent Logo" width="128" height="128" />

# PolarAgent

**基于 pisdk 的桌面 Agent 工作台**

  把 pisdk（pi-agent-core / pi-ai）的对话、会话持久化与原生工具装进一个克制的桌面外壳：
  主进程独占 Agent 运行时，渲染进程零特权，UI 以 assistant-ui 为核心。

  <p>
    <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" />
    <img alt="Tailwind" src="https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/Local--First-Yes-16A34A?style=flat-square" />
  </p>
</div>

---

## 产品定位

PolarAgent 是面向本地工作流的桌面 Agent 客户端：不自研工具与中间层，把 pisdk 的能力原样呈现。

- **对话**：assistant-ui Thread ↔ 主进程的 AgentHarness（每会话一个），事件经 IPC 批量转发。
- **工具**：Agent 可见工具固定为 pisdk 原生四件套 —— `bash`、`read`、`write`、`edit`。
- **能力归属**：模型路由、流式请求、会话持久化、上下文压缩、分支 fork 全部由 pisdk 承担。
- **本地优先**：会话、设置、AGENTS.md 与技能都在本机；模型请求只发往你配置的 OpenAI 兼容服务。

---

## 架构

```
┌─ 渲染进程（sandbox，零特权）───────────────────────────────┐
│  React 19 + shadcn/ui + assistant-ui（ExternalStoreRuntime）│
│  zustand 状态层 · react-i18next（中英双语）· lucide 图标     │
└───────────────────────┬────────────────────────────────────┘
                        │ preload（contextBridge，白名单 API）
┌───────────────────────┴────────────────────────────────────┐
│  主进程（唯一特权进程）                                      │
│  ├─ pisdk 装配：AgentHarness / Provider / 四工具 / 权限门     │
│  ├─ SQLite 会话仓储（分页游标 + 标题索引）                     │
│  ├─ 三模式权限：默认权限 / 帮我审批（AI）/ 完全访问            │
│  ├─ 安全层：路径守卫、命令黑名单、safeStorage 加密            │
│  └─ 设置与 AGENTS.md 持久化                                  │
└────────────────────────────────────────────────────────────┘
```

关键设计：**主进程独占 pisdk**（其资源文件依赖 `import.meta.url`，因此主进程构建必须外置依赖，不能内联打包）；渲染进程通过类型化 IPC 通道消费，事件按批下发。

目录：

```
src/
├── main/                  # Electron 主进程
│   ├── app/               # 路径与窗口
│   ├── ipc/               # 按域拆分的 IPC 处理器
│   ├── pisdk/             # AgentHarness 装配、会话仓储、工具、权限、审批
│   ├── security/          # 路径守卫 / 命令黑名单
│   └── settings/          # 设置存储（safeStorage 加密）
├── preload/               # contextBridge 白名单 API
├── renderer/
│   ├── app/               # 外壳：标题栏 / 侧边栏 / 主区 / 全局快捷键
│   ├── features/          # chat / settings / search
│   ├── components/        # shadcn 基础组件 + assistant-ui 元素
│   ├── runtime/           # ExternalStoreRuntime 桥与事件桥
│   └── stores/            # zustand 状态层
└── shared/                # 双端契约（IPC / 类型 / i18n 词条）
```

---

## 功能

| 分区 | 内容 |
| --- | --- |
| 对话 | 流式回复、思考链折叠、工具调用分组、Markdown、停止/重试、图片附件、运行中排队与插话 |
| 会话 | 新建/切换/重命名/归档/删除、标题索引、分页加载历史、**从任意消息分支**、SQLite 持久化 |
| 权限 | 三模式（默认权限 / 帮我审批 / 完全访问）、审批卡（允许一次 / 始终允许 / 拒绝并说明理由）、「始终允许」规则库 |
| 技能 | SKILL.md 扫描（全局 + 项目目录）、启用/禁用、提示模板 |
| 设置 | 通用（主题/语言/密度/字体/数据目录）、模型服务（两种 OpenAI 格式 + 拉取模型）、权限、技能、个性化（AGENTS.md）、关于 |
| 搜索 | Ctrl+K 全局搜索（会话/消息/设置/命令）、会话内查找（Ctrl+F） |

### 模型服务

仅支持 OpenAI 兼容接口的两种格式：

| 格式 | 端点 |
| --- | --- |
| `openai-completions` | `/chat/completions`（含 reasoning 内容兼容） |
| `openai-responses` | `/responses` |

Base URL 需自带 `/v1`。API Key 使用 Electron `safeStorage` 加密落盘（不可用时回退明文并告警）。

---

## 快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl/Cmd + K` | 全局搜索 |
| `Ctrl/Cmd + F` | 会话内查找 |
| `Ctrl/Cmd + N` | 新建对话 |
| `Ctrl/Cmd + B` | 折叠/展开侧栏 |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Enter` / `Shift + Enter` | 发送 / 换行 |
| 运行中 `Enter` / `Ctrl + Enter` | 排队 / 插话 |

---

## 开发

### 环境要求

- Node.js 20+（`node:sqlite` 需 Node 22+，应用内由 Electron 44 提供）
- npm 10+
- Windows / macOS / Linux

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发环境（Vite + Electron HMR） |
| `npm run start` | 启动已构建的应用 |
| `npm run typecheck` | 检查渲染进程、主进程与 preload 类型 |
| `npm run lint` | Biome 检查（`lint:fix` / `format` 可自动修复） |
| `npm run test` | 运行单元测试（vitest） |
| `npm run build` | 类型检查并构建 renderer、主进程与 preload |
| `npm run pack` | 生成 `release/` 下的可运行应用目录 |
| `npm run dist` | 生成当前平台安装包 |

### 冒烟脚本

| 脚本 | 用途 |
| --- | --- |
| `node scripts/probe-pisdk.mjs` | pisdk 装配探针（真实端点，验证 harness/工具/会话链路） |
| `node scripts/e2e-smoke.mjs` | 端到端冒烟（CDP 驱动真实 Electron，覆盖流式对话、工具调用、审批、完全访问、重启恢复） |

两者都从环境变量读取凭据：

```bash
POLAR_PROBE_API_KEY=... node scripts/e2e-smoke.mjs
# 可选：POLAR_PROBE_BASE_URL / POLAR_PROBE_MODEL
```

### 首次配置

1. 打开应用，进入「设置 → 模型服务」。
2. 添加服务：填写 Base URL（自带 `/v1`）与 API Key，选择接口格式。
3. 添加模型（或用「拉取模型」自动获取），并在「默认路由模型」里选中它。
4. （可选）在「个性化」编辑 AGENTS.md，写下希望 Agent 长期遵守的规则。

---

## 设计

UI 遵循 assistant-ui 的 design.md 规范：印刷文档隐喻、单色 chrome、唯一强调色（品牌紫 `#b99af1`）、克制的线条与动效。
完整设计稿（含逐屏 ASCII 线框图、组件映射与主题变量）见 [`docs/design/ui-v2-ascii.md`](docs/design/ui-v2-ascii.md)。

---

## 开源协议

MIT License
