<div align="center">
  <img src="public/logo.png" alt="PolarAgent Logo" width="96" height="96" />

# PolarAgent

**一个面向真实工作的桌面 AI Agent 工作台**

把多模型对话、Agent 编排、团队协作、MCP 工具、技能系统和本地会话管理放进同一个优雅的桌面应用里。

  <p>
    <img alt="Electron" src="https://img.shields.io/badge/Electron-39-47848F?style=flat-square&logo=electron&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white" />
  </p>
</div>

---

## 项目简介

PolarAgent 是一个基于 Electron 的跨平台桌面 AI Agent 应用。它不是单纯的聊天窗口，而是一个可以承载复杂任务的工作台：你可以配置多个模型供应商，创建不同角色的助手，让团队 Agent 协作推进任务，并通过内置工具与 MCP 连接文件系统、网页搜索、外部服务和自定义能力。

应用默认采用本地优先的设计。会话、配置、助手、团队、技能和 MCP 配置都保存在本机，适合个人工作流、研发辅助、资料处理、自动化探索和多模型实验。

## 主要能力

### 多模型与多助手

- 支持自定义模型供应商，可配置 Base URL、API Key、模型列表和默认模型。
- 兼容 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 等接口形态。
- 每个助手都可以拥有独立名称、头像、描述、系统提示词、模型和技能配置。
- 支持普通单助手对话，也支持后台持续运行的多会话任务。

### 团队 Agent 协作

- 支持创建团队，把多个 Agent 组织成一个协作单元。
- 团队成员可以接力推进任务、控制流程、标记阻塞或结束任务。
- 内置团队投票能力，适合方案选择、方向确认和多人决策式推理。
- 提供团队会话、团队监控与任务轨迹，让复杂协作更容易跟踪。

### 工具与 MCP

- 内置文件读写、目录操作、网页搜索、网页读取、询问用户、更新待办等工具。
- 支持 MCP 服务发现、安装、自定义配置和工具清单刷新。
- 内置 MCP 与已安装 MCP 都支持真实有效的总开关和子工具开关。
- 已打开的会话会在工具配置变化后自动使用最新工具集，无需重新创建会话。

### 技能系统

- 支持本地技能加载与启用。
- 提供技能广场入口，可安装和管理扩展能力。
- 助手可以按需绑定技能，让不同 Agent 形成更明确的专业分工。

### 桌面体验

- Electron 原生桌面外壳，支持开发启动、生产启动和安装包构建。
- Markdown、GFM、代码高亮、Mermaid 图表渲染一应俱全。
- 支持亮色、深色、跟随系统主题，以及对话字体和字号偏好。
- 会话以本地 JSONL 方式持久化，重启后仍能恢复上下文和任务轨迹。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- Windows、macOS 或 Linux 桌面环境

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

该命令会同时启动 Vite 开发服务器和 Electron 桌面窗口。

### 构建前端产物

```bash
npm run build
```

### 启动已构建应用

```bash
npm run start
```

### 打包桌面应用

```bash
npm run dist
```

打包配置位于 `package.json` 的 `build` 字段中，应用名称为 `PolarAgent`，图标资源来自 `build/icon.ico` 与 `build/icon.png`。

## 首次使用

1. 打开应用后进入「设置」。
2. 在模型设置里添加一个模型供应商。
3. 填写 `Base URL`、`API Key`，并添加可用模型。
4. 设置默认供应商和默认模型。
5. 回到对话页，新建会话即可开始使用。

如果需要外部工具能力，可以进入「工具」页面安装 MCP，或启用、关闭内置工具与 MCP 子工具。

## 项目结构

```text
polaragent/
├── electron/                 # Electron 主进程、preload 与启动器
├── public/                   # 静态资源，包含应用 logo
├── resources/                # 内置资源：助手、技能、MCP 等
├── build/                    # electron-builder 图标与打包资源
├── src/
│   ├── ai/                   # Agent 运行时、模型供应商、团队协作、工具系统
│   ├── components/           # 通用组件、对话组件、设置组件、工具编辑器
│   ├── config/               # 默认配置
│   ├── hooks/                # React hooks
│   ├── lib/                  # Electron API、会话持久化、Markdown、技能运行时等
│   ├── pages/                # 页面：对话、团队、助手、技能、工具、设置
│   ├── stores/               # Zustand 状态管理
│   └── types/                # 类型定义
├── package.json              # 脚本、依赖与打包配置
├── vite.config.ts            # Vite 配置
└── tsconfig.json             # TypeScript 配置
```

## 技术栈

| 分类       | 技术                                                          |
| ---------- | ------------------------------------------------------------- |
| 桌面端     | Electron、electron-builder                                    |
| 前端       | React 19、TypeScript、Vite 7                                  |
| 样式与交互 | Tailwind CSS 4、Radix UI、lucide-react、motion                |
| 状态管理   | Zustand                                                       |
| AI Runtime | `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`      |
| 工具协议   | Model Context Protocol SDK                                    |
| 内容渲染   | react-markdown、remark-gfm、rehype-raw、highlight.js、Mermaid |

## 常用命令

| 命令              | 说明                           |
| ----------------- | ------------------------------ |
| `npm run dev`     | 启动开发环境和 Electron 窗口   |
| `npm run build`   | TypeScript 检查并构建前端产物  |
| `npm run start`   | 启动已构建的 Electron 应用     |
| `npm run pack`    | 构建并生成未压缩的桌面应用目录 |
| `npm run dist`    | 构建并生成安装包               |
| `npm run preview` | 预览 Vite 构建产物             |

## 数据与隐私

PolarAgent 采用本地优先的存储方式。应用配置、会话历史、助手配置、团队配置、技能状态和 MCP 配置保存在本机数据目录中。模型请求会发送到你配置的模型供应商；外部工具或 MCP 的数据访问行为取决于你启用的工具和对应服务配置。

## 适合场景

- 日常研发、代码阅读、资料整理和方案推演。
- 需要多个 Agent 分工协作的复杂任务。
- 希望统一管理不同模型供应商和助手角色。
- 需要通过 MCP 接入外部服务或本地能力的 AI 工作流。
- 想在桌面端保留会话、任务轨迹和技能配置的个人 AI 工作台。
