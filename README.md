<div align="center">
  <img src="public/logo.png" alt="PolarAgent Logo" width="128" height="128" />

# PolarAgent

**本地优先的桌面 AI Agent 工作台**

把对话、知识库、工具调用、Browser Use、Computer Use 和多 Agent 协作放进一个安静、可控、面向真实工作的桌面应用。

  <p>
    <img alt="Electron" src="https://img.shields.io/badge/Electron-42-47848F?style=flat-square&logo=electron&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" />
    <img alt="Local First" src="https://img.shields.io/badge/Local--First-Yes-16A34A?style=flat-square" />
  </p>
</div>

---

## 产品定位

PolarAgent 是一个面向本地工作流的 AI Agent 桌面应用。它不是只用于聊天的窗口，而是一个可以连接模型、读取资料、调用工具、操作浏览器、理解桌面界面并组织多个助手协作的工作台。

它适合用来做：

| 场景 | PolarAgent 能做什么 |
| --- | --- |
| 研发辅助 | 代码理解、方案设计、问题排查、命令执行、文件操作 |
| 资料研究 | 网页搜索、网页读取、文档整理、知识库问答 |
| 桌面自动化 | 观察窗口、点击控件、输入文本、滚动页面、执行批量动作 |
| 浏览器自动化 | 使用真实 Chrome 会话，保留登录态，操作网页和标签页 |
| 多角色协作 | 让不同专业助手参与讨论、投票、拆解和推进任务 |
| 私有工作台 | 本地保存配置、会话、知识库和工具设置 |

---

## 核心能力

### Agent 对话工作台

- 支持多模型供应商配置，可为不同助手设置不同模型与系统提示词。
- 支持普通会话、团队会话、会话搜索、标题生成和历史管理。
- 支持 Markdown、代码高亮、表格、数学公式和 Mermaid 图表渲染。
- 支持语音输入、语音识别、语音合成和图片生成相关配置。

### 团队 Agent 协作

- 可以创建由多个助手组成的团队，让不同角色围绕同一任务协作。
- 支持团队成员轨迹、协作过程监控、投票、流程控制和待办更新。
- 适合用于方案评审、复杂任务拆解、多角度分析和长流程推进。

### 知识库与本地资料

- 支持导入 TXT、Markdown、PDF、Word 等常见文档。
- 支持按知识库管理文件、重建索引、兼容性检查和语义检索。
- 对话时可选择启用指定知识库，让回答更贴近项目上下文。

---

## Computer Use

Computer Use 让 AI 不只停留在文本里，而是可以通过 Windows UI Automation 观察和操作真实桌面应用。

### 能力概览

| 能力 | 说明 |
| --- | --- |
| 窗口观察 | 读取当前窗口或桌面的 UI 树、控件名称、控件类型和位置 |
| 截图辅助 | 可在观察时附带截图，为模型提供视觉上下文 |
| 控件定位 | 按文本、控件类型、窗口标题等信息查找界面元素 |
| 鼠标动作 | 支持点击、双击、移动、拖拽和滚动 |
| 键盘输入 | 支持文本输入、快捷键、按键序列和剪贴板恢复 |
| 窗口控制 | 支持列出窗口、激活窗口、聚焦控件和等待界面变化 |
| 批量执行 | 支持把多个桌面动作组合成连续步骤执行 |

### 适合做什么

- 操作传统桌面软件、设置面板、文件窗口和业务系统。
- 帮助模型读取窗口结构，判断下一步该点击哪里。
- 执行重复性桌面流程，例如填写表单、切换窗口、复制信息。
- 在需要本地 GUI 环境参与的任务中作为“手和眼睛”。

> 当前 Computer Use 主要面向 Windows 桌面环境，默认使用轻量截图路径和常驻 Worker，以减少每次动作的启动成本。

---

## Browser Use

Browser Use 通过 PolarAgent 的 Chrome 扩展连接真实浏览器会话。它和普通无头浏览器不同：可以使用你自己的浏览器 Profile、登录态和 Cookie。

### 能力概览

| 能力 | 说明 |
| --- | --- |
| 真实浏览器会话 | 使用本机 Chrome 标签页，不需要额外登录一次 |
| 扩展连接 | 通过本地 WebSocket 端口连接 PolarAgent 与浏览器 |
| 标签页感知 | 可读取当前可操作标签页、页面标题和 URL |
| 页面操作 | 支持点击、输入、滚动、等待、读取页面状态等动作 |
| 登录态保留 | 适合处理需要账号登录的网站和内部系统 |
| 扩展导出 | 设置页可一键导出扩展文件夹，再在 Chrome 中加载 |

### 适合做什么

- 浏览网页、收集资料、读取动态页面内容。
- 操作后台系统、控制台、表单页面和已登录网站。
- 结合网页搜索、网页读取和 Agent 推理完成研究任务。
- 在复杂网页流程中保留人工可见、可接管的浏览器状态。

### 扩展安装流程

1. 在「设置 -> Browser Use」中点击「导出扩展到文件夹」。
2. 打开 Chrome，进入 `chrome://extensions`。
3. 开启「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择导出的 `PolarAgent-BrowserUse` 文件夹。

---

## 工具与生态

### 内置工具

- 文件读取、写入、追加、目录列表和文件状态检查。
- Shell 命令执行，用于本地开发、脚本运行和系统信息读取。
- 网页搜索，支持 Tavily、Exa、Serper、SearXNG、Brave 等服务。
- 网页读取，支持正文提取、结构化解析和远程资源下载。
- 图片生成、音频转写、语音合成等多模态能力。
- 询问用户、更新待办、团队控制、团队投票等交互工具。

### MCP 支持

PolarAgent 集成 Model Context Protocol，可以接入外部 MCP Server，把数据库、浏览器、云服务、开发工具、内部系统等能力作为工具提供给 Agent 使用。

- 支持 MCP 服务配置与工具发现。
- 支持工具总开关和子工具粒度控制。
- 支持内置市场与本地配置并存。

### 技能系统

技能可以为 Agent 提供专门的工作方法、操作规程和上下文模板。PolarAgent 内置多种技能，并支持安装自定义技能，让不同助手具备更稳定的专业行为。

---

## 本地优先与隐私

PolarAgent 的默认设计是本地优先：

- 会话、配置、助手、团队、技能和知识库信息保存在本机。
- 模型请求只发送到你在设置中配置的模型供应商。
- Browser Use 和 Computer Use 通过本地能力工作，不需要把桌面状态交给额外平台托管。
- 你可以自行管理 API Key、模型、数据目录和自动化开关。

---

## 安装与运行

### 环境要求

- Node.js 20+
- npm 10+
- Windows / macOS / Linux

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev

# 类型检查与前端构建
npm run build

# 打包桌面应用
npm run dist
```

### 首次配置

1. 打开应用，进入「设置 -> 模型设置」。
2. 添加模型供应商，填写 Base URL 和 API Key。
3. 添加可用模型并设置默认模型。
4. 根据需要配置 Browser Use、Computer Use、知识库、MCP 和技能。
5. 回到对话页，开始使用你的本地 AI Agent 工作台。

---

## 发布与更新

PolarAgent 使用 Electron Builder 打包桌面端应用，并通过 GitHub Releases 分发版本。

- Windows：支持 NSIS 安装包，并提供 Squirrel 产物用于 Electron 官方自动更新服务。
- macOS：支持 DMG 和 ZIP。
- Linux：支持 AppImage、deb、rpm 和 tar.gz。
- 应用内「关于软件」页面可查看当前版本、检查更新并打开发布页。
- 每个版本的更新日志存放在 `changelogs/vX.Y.Z.md`，发布 workflow 会自动写入 GitHub Release 正文。

---

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 桌面框架 | Electron |
| 前端框架 | React、TypeScript、Vite |
| 样式与交互 | Tailwind CSS、Radix UI、lucide-react、motion |
| Agent 能力 | `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` |
| 工具协议 | Model Context Protocol SDK |
| 内容渲染 | react-markdown、highlight.js、mermaid、KaTeX |
| 状态管理 | Zustand |

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发环境 |
| `npm run build` | 类型检查并构建前端产物 |
| `npm run start` | 启动已构建应用 |
| `npm run pack` | 生成未压缩的应用目录 |
| `npm run dist` | 生成安装包 |
| `npm run test` | 运行测试 |
| `npm run preview` | 预览构建产物 |

---

## 项目结构

```text
polaragent/
├── changelogs/        # 每个版本的 GitHub Release 更新日志
├── electron/          # Electron 主进程、IPC、自动化桥接
├── resources/         # 内置技能、内置助手、市场资源、浏览器扩展
├── src/
│   ├── ai/            # Agent 运行时、工具定义、团队协作
│   ├── components/    # UI 组件
│   ├── lib/           # Electron API、知识库、会话、MCP 等逻辑
│   ├── pages/         # 对话、团队、工具、知识库、设置等页面
│   └── stores/        # 本地状态管理
├── build/             # 应用图标和打包资源
└── public/            # 静态资源
```

---

## 贡献

欢迎提交 Issue、建议和 Pull Request。适合贡献的方向包括：

- 新的内置技能或助手模板。
- MCP 服务集成案例。
- Browser Use / Computer Use 的动作增强。
- 知识库、搜索、文档解析和多模态能力优化。
- UI 体验、跨平台打包和自动更新改进。

---

## 开源协议

MIT License

---

<div align="center">

**如果 PolarAgent 对你有帮助，欢迎 Star。**

</div>
