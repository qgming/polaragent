<div align="center">
  <img src="public/logo.png" alt="PolarAgent Logo" width="128" height="128" />

# PolarAgent

**基于 pi-agent-core 的桌面 Agent 工作台**

一个尽量薄的桌面外壳：把 pisdk（pi-agent-core / pi-ai）的对话、会话持久化与原生工具直接暴露成桌面应用，不再自研工具与中间层。

  <p>
    <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/Local--First-Yes-16A34A?style=flat-square" />
  </p>
</div>

---

## 产品定位

PolarAgent 是一个面向本地工作流的桌面 Agent 客户端。它不自带工具箱，而是把 pisdk 的能力原样呈现：

- **对话**：assistant-ui Thread ↔ 每会话一个 AgentHarness（绑定该会话的 pi Session）。
- **工具**：Agent 可见的工具面固定为 pisdk 原生四件套 —— `bash`、`read`、`write`、`edit`。没有注册表、没有开关、没有动态加载。
- **能力归属**：模型路由、流式请求、会话持久化（JSONL）、上下文压缩（compaction）、分支与 fork 全部由 pisdk 承担。
- **本地优先**：会话、配置、AGENTS.md 都存在本机；模型请求只发往你在设置里配置的供应商。

---

## Agent 可见的工具

| 工具 | 能力 | 来源 |
| --- | --- | --- |
| `bash` | 在工作目录执行 shell 命令，返回合并后的 stdout/stderr | `createBashTool` |
| `read` | 读取文本文件（含分页与图片附件） | `createReadTool` |
| `write` | 写入/覆盖文件，自动创建父目录 | `createWriteTool` |
| `edit` | 按 `oldText → newText` 精确替换（支持多处） | `createEditTool` |

这四个工具的执行环境是 `ElectronExecutionEnv`（`src/lib/electron/electron-fs.ts`），它实现 pisdk 的 `ExecutionEnv` 接口，把文件与命令都经 IPC 落到主进程，再由主进程的安全层做校验与拦截。

---

## 安全边界

工具调用在执行前统一过一道审查（`src/ai/tool-permissions.ts`），四种权限模式：

| 模式 | 行为 |
| --- | --- |
| `readonly` | 只放行 `read`，其余一律拒绝 |
| `safe` | 放行读写与常规命令，本地拦截高危命令模式 |
| `ai_review`（默认） | `read` 直接放行，其余交给模型逐次审批并给出依据 |
| `full` | 全部放行 |

主进程另有一道独立防线（`src/main/lib/security.ts`）：命令黑名单、工作目录范围检查、输出截断。

---

## 设置

| 分区 | 内容 |
| --- | --- |
| 通用 | 主题、对话字体、对话字号、数据目录 |
| 模型 | 模型服务（Base URL / API Key / 模型列表）与默认路由模型 |
| 个性化 | AGENTS.md 自定义指令，每轮对话作为系统提示词注入 |
| 关于 | 版本信息 |

---

## 安装与运行

### 环境要求

- Node.js 20+
- npm 10+
- Windows / macOS / Linux

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发环境 |
| `npm run start` | 启动已构建的 Electron 应用 |
| `npm run typecheck` | 检查 renderer、主进程与 preload 类型 |
| `npm run build` | 类型检查并构建 renderer、主进程与 preload |
| `npm run test` | 运行自动化测试 |
| `npm run pack` | 生成 `release/` 下的可运行应用目录 |
| `npm run dist` | 生成当前平台安装包 |

### 首次配置

1. 打开应用，进入「设置 → 模型」。
2. 添加模型服务，填写 Base URL 与 API Key，再添加可用模型。
3. 在「默认路由模型」里选中要用的模型。
4. （可选）在「个性化」里编辑 AGENTS.md，写下希望 Agent 长期遵守的规则。

---

## 项目结构

```text
polaragent/
├── src/
│   ├── ai/              # AgentHarness 装配、工具层、权限审查、标题生成
│   ├── components/      # UI 组件（assistant-ui 元素、设置面板、侧边栏）
│   ├── lib/
│   │   ├── chat/        # 对话消息模型与 parts 提取
│   │   ├── electron/    # preload API 封装、ExecutionEnv 适配
│   │   └── session/     # pi Session 的打开/列表/偏好读写
│   ├── main/            # Electron 主进程、IPC 与安全层
│   ├── pages/           # 对话页
│   ├── preload/         # contextBridge 安全桥接
│   └── stores/          # 对话与配置状态
├── build/               # 应用图标与打包资源
├── electron-builder.yml # 安装包与平台目标
└── public/              # 静态资源
```

---

## 开源协议

MIT License
