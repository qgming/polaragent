<div align="center">
  <img src="public/logo.png" alt="Oint Logo" width="128" height="128" />

# Oint

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

Oint 是面向本地工作流的桌面 Agent 客户端：把 pisdk 的能力原样呈现，只在其上补少量只读工具。

- **对话**：assistant-ui Thread ↔ 主进程的 AgentHarness（每会话一个），事件经 IPC 批量转发。
- **工具**：内核原生四件套 `bash`/`read`/`write`/`edit` + 自建 `grep`/`glob`/`todo` + **内置浏览器操作**
  `browser_*`（打开网址、读页面、点击、输入、截图、看控制台）；
  刻意不做持久终端、任意代码执行这类会引入新权限面的工具。
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
│  ├─ pisdk 装配：AgentHarness / Provider / 工具层 / 权限门     │
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
| 工具 | 内核原生 `bash`/`read`/`write`/`edit`（description 已覆盖，补「何时用/何时不要用」）+ 自建 `grep`/`glob`/`todo` + 浏览器九件套 `browser_open`/`browser_history`/`browser_snapshot`/`browser_act`/`browser_wait`/`browser_screenshot`/`browser_logs`/`browser_dialog`/`browser_evaluate` |
| 内置浏览器 | 右侧面板的 `<webview>` 可供模型操作：导航、读页面（可见文本 + 带 ref 的可交互元素）、真实鼠标点击 / 悬停、按键与组合键、输入（**回读校验**，不再假报成功）、下拉选择、等待渲染落定、视口截图（图片进上下文）、控制台与网络记录（`browser_logs` 两种视图）、页面内求值。点击前会复核坐标上确实是目标元素，复核不过就报错而不是静默点空。JS 弹窗（alert / confirm / prompt）默认自动关闭，页面不会因无人应答而卡死。读类工具免审批，改页面 / 执行脚本走审批；**面板没开时模型会自己把它叫出来**（展开右侧栏并切到浏览器视图，然后等页面就绪） |
| 待办 | `todo` 工具维护会话级清单（整表替换语义）；对话区上方另有**独立可折叠面板**，重启后由会话记录恢复 |
| 会话 | 新建/切换/重命名/归档/删除、**侧栏「置顶 / 项目 / 最近」分组**（绑定文件夹即为项目，会话按其工作目录自动归组）、标题索引、分页加载历史、**从任意消息分支**、SQLite 持久化 |
| 权限 | 三模式（默认权限 / 帮我审批 / 完全访问）、审批卡（允许一次 / 始终允许 / 拒绝并说明理由）、「始终允许」规则库 |
| 智能体模式 | **两个模式，输入框左侧（权限按钮左边）切换**：**智能体**（自己判断任务类型，该做的直接做）与**编排者**（先派子智能体做，自己负责计划与验收）。两个名字都是**名词** —— 它们回答「你在跟谁说话」，而不是「强度多大」（那是权限按钮的维度）。**两个模式的工具能力完全相同**，区别只在系统提示怎么写：编排者模式多一段「什么时候该派 / 不该派 / 派完怎么收敛」的路由规则，并且身份句改成「默认不自己动手」。模式是**会话级**的（写进会话索引、重启后仍生效、切换在**下一次发送**即生效），设置里的「默认模式」只决定新会话用哪个；运行中不可切换。系统提示是每轮现算的函数，所以切换不必重建 harness |
| 技能 | SKILL.md 扫描，**三个固定来源、顺序即优先级**：数据目录 `skills/` → 项目目录 `.oint/skills` → **随包分发的内置技能 `<应用目录>/resources/skills`**（同名时用户/项目胜出，所以内置行为永远可被覆盖）。功能永久开启（可逐条禁用）、把「名称 + 描述 + 路径」索引注入系统提示（正文按需读取）；设置里按「系统 / 用户」两个页签分组（系统 = 内置，用户 = 自己添加的），用户页签可用 **zip 技能包导入**、点行查看 SKILL.md 原文或删除。**内置技能不可删除**（住在应用目录里、随升级更新，删了下次升级又回来）—— 不需要时用禁用。内置技能**不拷贝到数据目录**，所以升级应用 = 整包替换即完成更新，不需要 manifest / 暂存那套对账。当前内置八个：**deep-research**（并行子智能体做多来源调研，产出带引用的报告）、**domain-modeling**（建立并打磨项目的领域模型：术语表 CONTEXT.md 与 ADR）、**grilling**（就一个方案对用户不留情面地追问，直到达成共识）、**learn-everything**（把文档或主题变成分章节的互动课程，带练习与批改）、**simplify**（不改行为地简化代码）、**skill-creator**（创建 / 评审 / 改进技能本身，带可跑的校验脚本）、**super-research**（八种自主研究模式：实验循环 / 主题调研 / 量化分析 / 对比评测 / 根因排查 / 消融实验 / 论文复现 / 论文写作与引用校验）、**verification-planning**（动手前先设计「用什么证据能证明它成了」）。技能目录里可以有附属文件与**可执行脚本**（`super-research` 带 9 份参考 + 3 个 Node 脚本，`skill-creator` 带 3 份参考 + 校验脚本，`deep-research` 与 `learn-everything` 各带 2–3 份参考）。SKILL.md 用相对链接引用它们，**有测试保证这些链接指向的文件真实存在，并且真的会执行脚本一次**（防止「文档写着跑这个脚本，脚本却不在/跑不起来」） |
| 魔法提示 | 可复用的提示词片段（`.md`，数据目录 `prompts/` + 项目 `.oint/prompts`），输入框敲 `/` 调用；设置里同样是「系统 / 用户」页签，用户页签可在统一的表单弹窗里新建 / 编辑 / 删除 |
| 子智能体 | 主 AI 可把独立工作派给子智能体（`Task` / `TaskWait` / `TaskList` / `TaskStop`），一次委派 = 一个隐藏子会话：**内置预设七个** —— explorer / code-reviewer / fixer / test-runner / oracle / designer / verifier，外加 `${数据目录}/subagents/*.md` 与项目目录 `.oint/subagents/*.md` 里的自定义定义（定义住在自己那个文件夹里，和技能、MCP 一样，没有额外的目录配置）；主 AI 还能在 `Task` 里内联定义**临时子智能体**（不落盘）。**可用清单走系统提示里的 `<available_subagents>` 索引**（与技能的 `<available_skills>` 同构，两个模式都注入，超过 12 个截断并说明），`Task` 的描述只指向它、不再抄一份名录。可用工具按定义过滤（默认只读三件套，写类工具需显式勾选），模型与思考档位可固定也可跟随主会话，并发上限（**同一条消息里并发派发也不会绕过**：名额是同步预约的）、可中途停止；审批回到父会话弹出。**没有轮次上限** —— 异常检测靠**重复调用守卫**（同名同参数的连续调用第 3 次注入纠正消息、第 5 次终止运行），因为轮次是资源消耗、不是行为特征。**报告靠投递机制交回**：子智能体一跑完，报告就自动作为一条消息送到主代理（正在跑就插进当前轮次，空闲就起一轮；连续自动唤醒有上限，避免「派发 → 报告 → 又派发」自激），所以不必靠模型记得调 `TaskWait`。**进度与终态逐轮落盘**：重启后历史委派仍然显示真实的轮次与结论，进程在运行期间退出则标为**意外终止**（结果未知、显示最后见到的时间），要不要重派由主 AI 决定（`Task {resumeOf}` 直接续跑原来的 agent / 任务）。主会话里的子智能体呼叫**不是普通工具折叠行**，而是 `elements/agent-status` 的胶囊行（状态 / 轮次 / 耗时，绿勾只留给真的跑完的），点它展开右侧栏「子智能体」视图：按会话列出全部委派，单条执行详情含任务、报告与子会话转录 ——**转录复用主会话的消息渲染器**，Markdown / 代码高亮 / 工具卡与主线程一致。设置里有独立「子智能体」分栏（系统 / 用户页签、逐条启用、编辑器、诊断；功能永久开启，没有总开关）。原「侧边聊天」入口已并入这里 |
| 设置 | 通用（主题/语言/密度/字体）、模型服务（两种 OpenAI 格式 + 拉取模型）、技能、**子智能体**、提示模板、个性化（AGENTS.md）、数据（数据目录位置）、关于（名称 / 版本 / pi 内核） |
| 搜索 | Ctrl+K 全局搜索（会话/消息/设置/命令）、会话内查找（Ctrl+F） |

### 模型服务

仅支持 OpenAI 兼容接口的两种格式：

| 格式 | 端点 |
| --- | --- |
| `openai-completions` | `/chat/completions`（含 reasoning 内容兼容） |
| `openai-responses` | `/responses` |

Base URL 需自带 `/v1`。API Key 使用 Electron `safeStorage` 加密落盘（不可用时回退明文并告警）。

---

## 数据目录

应用数据固定放在家目录的点目录，**与 Electron 的 Chromium 缓存分开**：

```
~/.oint/                    # 应用数据（可用 OINT_HOME 覆盖）
├── settings.json           # 设置（API Key 经 safeStorage 加密）
├── sessions-index.json     # 会话索引：标题 / 归档 / 置顶 / 消息计数 / 工作目录
├── projects.json           # 已绑定的项目文件夹（侧栏「项目」分组）
├── permission-rules.json   # 「始终允许」规则
├── AGENTS.md               # 个性化长期偏好（可手写，适合纳入版本管理）
├── sessions/               # 会话库：每会话一个 SQLite
├── skills/                 # 技能（SKILL.md，递归扫描）
├── prompts/                # 魔法提示（*.md，只读直接子级，供显式调用）
├── subagents/              # 子智能体定义（*.md）
└── cache/                  # 可再生成的缓存（models.dev 模型元数据）
```

> ⚠️ `settings.json`（含 API Key）与 `permission-rules.json` 也在这个目录里，而该目录当前位于模型的
> 可读/可写范围内 —— 审计发现这是一条提权链（模型可改写 `permissionMode` 关闭全部审批）。
> 详见 `docs/audit-report.md` 的 C-1。

技能、魔法提示与子智能体定义除了数据目录里的固定文件夹，还会扫描**会话工作目录下的 `.oint/` 同名子目录**
（项目级，跟随会话的 cwd，同样无需配置）。

**技能还多一层内置来源**：`<应用目录>/resources/skills/**`（随包分发，见上方「功能」表的技能行）。
它在优先级里排**最后**，所以数据目录或项目里的同名技能会遮住它 —— 这也是「内置行为永远可被覆盖」
的实现方式。内置技能与另外两层一样进「系统」页签，可禁用但不可删除。

Chromium 的 `Cache`、`Code Cache`、`GPUCache`、`IndexedDB` 等仍由 Electron 放在平台默认位置
（Windows `%APPDATA%\Oint`、macOS `~/Library/Application Support/Oint`、Linux `~/.config/Oint`）。

之所以分层：这些浏览器缓存实测可达数百 MB，而真正的应用数据只有几十 MB。分开之后，备份、同步、
迁移或彻底卸载只需要处理 `~/.oint` 一个目录。

| 环境变量 | 作用 |
| --- | --- |
| `OINT_HOME` | 覆盖数据根目录，必须是绝对路径（相对路径会告警并回落到 `~/.oint`） |

```powershell
# 用一次性数据目录启动，适合试验或调试，不污染日常数据
$env:OINT_HOME = "$PWD\.tmp-data"; npm run dev
```

> 不要把数据目录放在 OneDrive / Dropbox 等云同步盘内：`sessions/` 是 SQLite + WAL，
> 同步客户端并发改写有损坏风险。

开发阶段不考虑旧版本数据迁移，换目录即视为全新开始。

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
| `npm run test` | 运行单元测试（vitest；`node` project 收 `*.test.ts`，`ui` project 收 `*.test.tsx` + jsdom） |
| `npm run check:unwired` | 检查 `elements/` 下「已建好但未接线」的组件；存在未接线文件时退出码为 1 |
| `npm run build` | 类型检查并构建 renderer、主进程与 preload |
| `npm run pack` | 生成 `release/` 下的可运行应用目录 |
| `npm run dist` | 生成当前平台安装包 |

### 冒烟脚本

| 脚本 | 用途 |
| --- | --- |
| `node scripts/probe-pisdk.mjs` | pisdk 装配探针（真实端点，验证 harness/工具/会话链路） |
| `node scripts/e2e-smoke.mjs` | 端到端冒烟（CDP 驱动真实 Electron，覆盖流式对话、工具调用、审批、完全访问、重启恢复） |
| `node scripts/probe-browser-guest.mjs` | 内置浏览器探针（CDP 驱动真实 Electron，验证 webview 的 guest 真的附着、导航可用且只加载一次） |

前两者从环境变量读取凭据：

```bash
OINT_PROBE_API_KEY=... node scripts/e2e-smoke.mjs
# 可选：OINT_PROBE_BASE_URL / OINT_PROBE_MODEL
```

### 首次配置

1. 打开应用，进入「设置 → 模型服务」。
2. 添加服务：填写 Base URL（自带 `/v1`）与 API Key，选择接口格式。
3. 添加模型（或用「拉取模型」自动获取），并在「默认路由模型」里选中它。
4. （可选）在「个性化」编辑 AGENTS.md，写下希望 Agent 长期遵守的规则。

---

## 设计

UI 遵循 assistant-ui 的 design.md 规范：印刷文档隐喻、单色 chrome、唯一强调色（品牌紫 `#b99af1`）、克制的线条与动效。
字体、半径与颜色都是按含义分配的封闭集合，令牌集中在 `src/index.css`，字号角色在 `src/renderer/components/assistant-ui/type.ts`。

---

## 开源协议

MIT License
