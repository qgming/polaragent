<div align="center">
  <img src="public/logo.png" alt="PolarAgent Logo" width="128" height="128" />

# PolarAgent

**本地优先的桌面 AI Agent 工作台**

多模型对话、Agent 编排、团队协作、工具系统与知识库管理

  <p>
    <img alt="Electron" src="https://img.shields.io/badge/Electron-39-47848F?style=flat-square&logo=electron&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white" />
  </p>
</div>

---

## ✨ 核心特性

### 🤖 多模型与多助手

- **多供应商支持**：配置多个模型供应商（OpenAI、Anthropic、国内大模型等）
- **灵活切换**：每个助手可独立配置模型、系统提示词和技能
- **角色管理**：创建多个专业助手（代码、写作、分析等）
- **会话隔离**：不同助手的对话独立存储，互不干扰

### 👥 团队 Agent 协作

- **多 Agent 编排**：创建团队，多个助手协同完成复杂任务
- **协作机制**：支持投票、流程控制、任务标记
- **团队会话**：可视化团队对话历史和成员轨迹
- **灵活管理**：团队成员、技能配置动态调整

### 📚 知识库管理

- **文档导入**：支持 TXT、Markdown、PDF、Word 等格式
- **向量检索**：基于语义相似度的智能搜索
- **灵活管理**：添加、删除、重建知识库
- **会话绑定**：每个对话可选择启用的知识库

### 🛠️ 丰富的工具系统

**内置工具**：
- 文件操作（读取、写入、编辑、删除）
- 目录管理（列表、创建）
- 网络搜索（多服务商：Tavily、Serper、SearXNG、Brave）
- 网页读取（正文提取、结构化解析）
- 询问用户（交互式确认）
- Bash 执行（命令行操作）

**MCP 支持**：
- 完整集成 Model Context Protocol
- 支持安装和配置外部 MCP 服务
- 工具总开关和子工具粒度控制

### 🎨 优雅的桌面体验

- **原生桌面**：Electron 跨平台应用
- **Markdown 渲染**：代码高亮、表格、Mermaid 图表
- **主题切换**：亮色、深色、跟随系统
- **流式输出**：打字机效果的实时回复
- **本地存储**：会话、配置全部保存在本地

### ⚙️ 灵活的配置

- **偏好设置**：主题、字体、字号自定义
- **模型配置**：供应商、API Key、默认模型
- **图片生成**：支持多种图片生成服务
- **音频设置**：语音识别和语音合成配置
- **数据管理**：导出、备份、清理

---

## 📦 快速开始

### 环境要求

- Node.js 20+
- npm 10+
- Windows / macOS / Linux

### 安装与运行

```bash
# 1. 安装依赖
npm install

# 2. 开发模式
npm run dev

# 3. 构建应用
npm run build

# 4. 打包桌面应用
npm run dist
```

### 首次配置

1. 打开应用，进入「设置 → 模型设置」
2. 添加模型供应商（填写 Base URL 和 API Key）
3. 添加可用模型并设置默认模型
4. 返回对话页，开始使用

---

## 🏗️ 项目结构

```text
polaragent/
├── src/
│   ├── ai/                      # AI 核心
│   │   ├── agent.ts             # Agent 运行时
│   │   ├── agent-manager.ts     # Agent 管理器
│   │   ├── team.ts              # 团队协作
│   │   └── tools/               # 工具系统
│   ├── components/              # UI 组件
│   │   ├── chat/                # 对话组件
│   │   ├── settings/            # 设置面板
│   │   ├── sidebar/             # 侧边栏
│   │   └── team/                # 团队组件
│   ├── pages/                   # 页面
│   │   ├── ChatPage.tsx         # 对话页
│   │   ├── TeamPage.tsx         # 团队页
│   │   ├── AgentsPage.tsx       # 助手页
│   │   ├── SkillsPage.tsx       # 技能页
│   │   ├── ToolsPage.tsx        # 工具页
│   │   ├── KnowledgePage.tsx    # 知识库页
│   │   └── SettingsPage.tsx     # 设置页
│   ├── stores/                  # 状态管理
│   ├── lib/                     # 工具库
│   └── types/                   # 类型定义
├── electron/                    # Electron 主进程
├── resources/                   # 内置资源
└── public/                      # 静态资源
```

---

## 🛠️ 技术栈

### 核心框架
- **Electron 39** - 桌面应用框架
- **React 19** - UI 框架
- **TypeScript 5.8** - 类型安全
- **Vite 7** - 构建工具

### AI & Agent
- **@earendil-works/pi-agent-core** 0.79.1 - Agent 运行时
- **@earendil-works/pi-ai** 0.79.1 - 统一模型接口
- **@modelcontextprotocol/sdk** - MCP 工具协议

### UI & 样式
- **Tailwind CSS 4** - 原子化 CSS
- **Radix UI** - 无障碍组件库
- **lucide-react** - 图标库
- **motion** - 动画库

### 内容渲染
- **react-markdown** - Markdown 渲染
- **remark-gfm** - GitHub Flavored Markdown
- **highlight.js** - 代码高亮
- **mermaid** - 图表渲染
- **katex** - 数学公式

### 状态管理
- **Zustand** - 轻量级状态管理
- **Persist 中间件** - 本地持久化

---

## 📋 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发环境 |
| `npm run build` | 构建前端产物 |
| `npm run start` | 启动已构建应用 |
| `npm run pack` | 生成未压缩的应用目录 |
| `npm run dist` | 生成安装包 |
| `npm run preview` | 预览构建产物 |

---

## 🎯 适用场景

- **日常工作**：代码审查、文档撰写、资料整理
- **研发辅助**：技术调研、方案设计、问题排查
- **团队协作**：多角色讨论、方案评审、决策投票
- **知识管理**：文档问答、项目文档检索
- **自动化探索**：工具调用、脚本执行、流程编排

---

## 📝 数据与隐私

PolarAgent 采用本地优先的设计：

- ✅ 所有配置和会话数据保存在本地
- ✅ 模型请求仅发送到你配置的供应商
- ✅ 不上传任何数据到第三方服务器
- ✅ 支持数据导出和备份

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 开源协议

MIT License

---

## 💬 联系方式

- **作者**: qgming
- **项目**: PolarAgent

---

<div align="center">

**如果觉得这个项目有帮助，欢迎 Star ⭐**

</div>
