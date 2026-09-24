---
name: plugin-authoring
description: 为用户写一个 Oint 插件（plugin.json + 技能/提示/子智能体/MCP/界面），或修改、排查一个已有的插件。当用户说「帮我做个插件」「写个插件实现 X」「给 Oint 加个 Y 面板」「把这个做成插件」「我的插件加载不了」时使用。**产出的是一份目录**（不是一段代码片段），用户可以装它、也可以分享成 zip。
---

# 写一个 Oint 插件

插件是**一个目录**，根上有一份 `plugin.json`，旁边按约定放各种"贡献物"。
你写的是文件，不是代码片段 —— 最后要落在磁盘上，用户才能装它。

## 目录放在哪

**写进用户的数据目录**：`~/.oint/plugins/installed/<插件名>/`。

Windows 上是 `C:\Users\<用户名>\.oint\plugins\installed\<插件名>\`。
拿不准家目录就先跑一下 `bash`：`echo $HOME`（Windows 用 `echo %USERPROFILE%`）。

为什么是这里 —— 它和用户自己写的技能、提示词**在同一个地方**：

- **它是"用户装的插件"**，所以插件管理里有**卸载**。写在项目里的插件没有：
  那被当作"你自己的源码"，宿主连删除按钮都不给（删掉可能就是你项目的一部分）。
- **换一个项目它还在**。写在 `<cwd>/.oint/plugins/` 的插件只在那一个项目里生效。
- **用户只在一个地方管他的扩展**，而不是"这个项目一份、那个项目一份、还有一份全局的"。

写完告诉用户**去插件管理里启用它**（用户装的插件默认停用），不用重启。

一个插件目录长这样：

```
~/.oint/plugins/installed/git-lens/
├── plugin.json                 ← 必须有
├── skills/<名字>/SKILL.md       ← 可选：给模型加技能
├── mcp.json                    ← 可选：声明 MCP server
├── dev.oint/                   ← 可选：Oint 私有贡献面
│   ├── prompts/*.md            ←   魔法提示模板
│   └── subagents/*.md          ←   子智能体定义
├── ui/                         ← 可选：界面资源
│   └── index.html
└── main.cjs                    ← 可选：插件进程入口（能不加就不加）
```

**`dev.oint/` 这个名字不能改**：Agent Plugins 规范要求客户端私有文件放在
"以扩展命名空间命名的一级目录"下，而我们的命名空间就是 `dev.oint`。
`skills/` 与 `mcp.json` 是规范定的标准位置，也**不能换地方**。

> `<cwd>/.oint/plugins/` 这个位置**也能被发现**（项目级插件），但只在那个项目里生效、
> 且不能从界面卸载。除非用户明确说"只在这个项目里用"，否则都写进用户数据目录。

## 先决定：这个插件要不要跑代码

**大多数插件不该有 `main.cjs`。** 只贡献技能 / 提示 / 子智能体 / MCP / 界面的插件
一个进程都不起 —— 不跑代码就没有代码的风险，而且用户看到权限列表时更容易点"启用"。

只有**要给模型加工具**、**要注册命令**，或者**要用钩子介入工具调用**时才需要 `main.cjs`。

## plugin.json

```jsonc
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "git-lens",
  "version": "1.0.0",
  "description": "在右侧面板里查看 Git 状态",
  "extensions": {
    "dev.oint": {
      "id": "com.yourname.git-lens",
      "apiVersion": "1",
      "permissions": ["ui.panel"]
    }
  }
}
```

### 校验器是严格的 —— 下面每一条都会让插件**装不上**

- `$schema` 必须**逐字**等于上面那一串。缺了、或指向别的版本，一律拒绝
  （不认识的版本按旧版解释是最坏的宽容）。
- `name`：1–64 位，小写字母 / 数字 / 点 / 连字符，**首尾必须是字母或数字**，
  **不能有连续两个连字符 `--`，也不能有连续两个点 `..`**。
  `git-lens` ✅、`Git-Lens` ❌、`git--lens` ❌。
- `version`：非空字符串。不要求 semver（写 `2026.03-preview` 也合法）。
- `extensions["dev.oint"]` **必须存在**，缺了直接失败。
- `id`：反向域名，全小写，`^[a-z0-9]+(\.[a-z0-9_-]+)+$`。
  建议 `com.<你的名字>.<插件名>`。它同时是数据目录名与内部标识。
- `apiVersion` 必须是字符串 `"1"`。
- **`extensions["dev.oint"]` 里不能有校验器不认识的字段** —— 打错一个键名
  （`permisions`）就是失败，不是忽略。根上多写字段则只是警告。

## 权限：清单授予，代码决定不了

22 项，按需取。**申请了却用不出效果**和**没申请却想用**都是问题，所以只写你真要的。

| 能力 | 权限 | 档位 |
| --- | --- | --- |
| 右侧面板 | `ui.panel` | 低 |
| 独立窗口 | `ui.window` | 低 |
| 跟随主题 / 通知 / 私有 KV | `ui.theme` / `notify` / `storage` | 低 |
| 贡献技能 / 提示 | `skills.contribute` / `prompts.contribute` | 低 |
| 贡献子智能体 | `subagents.contribute` | 中 |
| 给模型加工具 | `agent.tool.register` | 高 |
| 注册命令 | `commands.register` | 高 |
| **介入工具调用（钩子）** | `hostHooks.register` | 高 |
| 跑命令 | `shell.exec` | 高 |
| 出站请求 | `net.fetch` | 高 |
| 起本地 / 连远端 MCP | `mcp.server.local` / `mcp.server.remote` | 高 / 中 |
| ⚠️ 读 / 写 / 删文件 | `fs.read` / `fs.write` / `fs.delete` | 中 / 高 / 高 |

> ⚠️ **`fs.*` 三项目前没有执行点**：插件侧既没有文件 API（`window.oint` 里没有 fs，
> RPC 里也没有文件操作），声明的 `fs` 范围也没有任何校验点 —— 也就是说
> **声明了它今天不起作用**。设置面板会在这些权限上打「未生效」。
> 要读写文件，现在的办法是：`main.cjs` 里直接 `require("node:fs")`（进程有完整 Node 权限，
> 见下面那条信任边界），或者用 `shell.exec` 跑命令。等宿主补上 `oint.fs.*` 再声明它。

**几条硬规则**（违反了就是清单不合法）：
- 声明了 `fs.<模式>` 的范围，就必须有对应的 `fs.<模式>` 权限；
- **写与删不能声明整树通配**（`**`、`**/*`、`./*`）—— 读可以；
- `shell.exec` 与 `shell.exec` 白名单**必须同时出现**：申请了权限就必须列命令，
  列了命令就必须申请权限；
- `net.domains` 不能是裸 `*`，也不能带协议 / 端口 / 路径（只写主机名）；
- 声明了界面的 `kind`，就必须有对应的 `ui.panel` / `ui.window`；
- 声明了 `hooks`，就必须同时有 `hostHooks.register` 与 `main`。

## 贡献面

> **技能 / 提示 / 子智能体这三类贡献的权限是强制执行的：没申请就整块不贡献。**
>
> 不是"申请了才拦"，而是**目录会被直接忽略** —— 你放了 `skills/` 却没写
> `skills.contribute`，技能会**静默消失**，而目录明明在那里。这是最难查的一类，
> 所以只写你真要的那几项，并且在插件管理里核对一下贡献物计数对不对。

### 技能：`skills/<名字>/SKILL.md`

与内置技能格式完全一样（YAML frontmatter 的 `name` + `description`，然后正文）。
需要 `skills.contribute` 权限。

### 魔法提示：`dev.oint/prompts/<名字>.md`

**只读直接子级**，不递归。需要 `prompts.contribute`。

### 子智能体：`dev.oint/subagents/<名字>.md`

与用户自己写的子智能体定义同格式。需要 `subagents.contribute`。

> 它们**不会出现在设置面板的技能 / 提示 / 子智能体列表里** —— 它们归插件管，
> 用户在设置里既改不了也删不掉，显示出来只会制造"这里能管它"的错觉。
> 但**模型照样读得到**：你在插件卡片上看到的贡献物计数就是实际生效的数量。

### MCP server：`mcp.json`

```jsonc
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "remote": { "url": "https://mcp.example.com/mcp" }
  }
}
```

- 有 `command` 是本地（要 `mcp.server.local`），有 `url` 是远端（要 `mcp.server.remote`）；
- **两者都给或都不给都不合法**；
- 成员名随便取，宿主会自己生成合法的 server id。

### 界面：`ui/` + `surfaces`

```jsonc
"permissions": ["ui.panel"],
"surfaces": [
  {
    "id": "git",
    "kind": "panel",            // panel = 停靠右侧；window = 独立窗口
    "title": { "en": "Git", "zh-CN": "版本控制" },
    "entry": "./ui/index.html"
  }
]
```

`entry` 必须是 `./` 开头的包内相对路径（不能有 `..`）。

窗口类还能写 `"shape": "widget"`（透明、无边框、置顶、不进任务栏 —— 桌面宠物那类）、
`width` / `height` / `alwaysOnTop` / `resizable` / `skipTaskbar`。

**界面里能用的 API**（注入在 `window.oint`）：

```js
window.oint.info                     // { pluginId, surfaceId, kind, pluginName, theme }
await window.oint.ready()            // 告诉宿主"我画好了"（撤掉骨架屏）
await window.oint.close()
await window.oint.storage.get(key)   // 插件私有 KV，别的插件读不到
await window.oint.storage.set(key, value)   // 值必须是能 JSON 往返的
await window.oint.notify(title, body)       // 需要 notify 权限
await window.oint.writeText(text)           // 需要 clipboard.write 权限
await window.oint.fetch(url, init)          // 需要 net.fetch 权限 + net.domains 白名单
await window.oint.workspace()               // 当前会话的工作目录（没有会话时是空串）
await window.oint.exec("git", ["status"])   // 需要 shell.exec 权限 + 清单里的命令白名单
const off = window.oint.on("theme", (t) => {})   // 返回取消订阅函数
```

> **事件只有 `theme` 会真的推过来。** 契约里还有 `active` / `reload` / `config`
> 三个名字，它们是**保留位** —— 宿主今天不推（详见 `shared/contracts/surface.ts`）。
> 别为它们写逻辑：那种代码永远不会触发，却会让读的人以为面板已经有了刷新钩子。
> 要刷新就自己定节奏（内置示例 `git-status` 是 5 秒轮询 + 一个手动刷新按钮）。

**`exec` 是界面唯一能读本地状态的通道**（`connect-src 'none'` 让页面自己的 `fetch`
出不了本机，而 `storage` 只有你自己写的东西）。所以"显示 Git 状态""列出依赖"这类面板
只能靠它。三条要记住的：

- **命令必须在清单的 `shell.exec` 白名单里**（只写命令名，如 `["git"]`）；
- **参数逐项传，不经过 shell** —— 所以路径里有空格也不用加引号，
  而 `"; rm -rf /"` 只是一个普通参数（这也意味着**你拿不到 shell 的功能**：
  管道、通配符、`&&` 都得自己在代码里做）；
- **`cwd` 默认就是工作目录**，且不能跑出它之外；
- **非 0 退出码不是异常**：`{ code, stdout, stderr, truncated }` 里 `code` 是 3
  也正常返回（`git diff --quiet` 就用它表达"有改动"）。只有"这条命令根本不该跑"
  （没权限 / 不在白名单 / cwd 越界）才抛。

`workspace()` 在**会话切换时会变** —— 按需读，不要在启动时读一次就缓存。

**界面里的约束**（这些不是建议，是宿主强制的）：
- **没有 Node、没有 `require`、没有 `process`** —— guest 是沙箱化的；
- **CSP 是 `script-src 'self'`** —— 不能内联 `<script>`、不能用 CDN。JS 必须是
  自己的 `.js` 文件；
- **`connect-src 'none'`** —— 页面自己 `fetch` 发不出去，要联网走 `window.oint.fetch`；
- 所有插件的界面**共用同一个 origin**，所以别把敏感数据放进 `localStorage` ——
  用 `window.oint.storage`（那是按插件隔离的）。

### 插件进程：`main.cjs`（能不加就不加）

```js
// 收 init → 回 ready（声明你提供什么）；之后收 call / run → 回 result
process.parentPort.on("message", (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    process.parentPort.postMessage({
      type: "ready", v: 1,
      tools: [{ name: "status", description: "看仓库状态", parameters: { type: "object" } }],
      commands: [{ name: "sync", description: "拉取并变基" }],
    });
  }
  if (msg.type === "call") {
    // msg.tool / msg.args / msg.workspaceDir（这次调用所在的工作目录）
    process.parentPort.postMessage({ type: "result", id: msg.id, text: "结果" });
  }
  if (msg.type === "run") {
    // msg.command / msg.args（用户敲的那串）
    process.parentPort.postMessage({ type: "result", id: msg.id, text: "做完了" });
  }
});
```

> ⚠️ **文件扩展名决定模块格式，这里踩过一个大坑。**
>
> Node 判断"一个 `.js` 是 CommonJS 还是 ESM"靠的是**向上找最近的 `package.json` 的 `type`**。
> 插件目录里通常没有 `package.json`，于是它会一路找到**宿主应用**那份 ——
> 而 Oint 是 `"type": "module"`。结果是：你用 `require()` 写的 `main.js`
> **被当成 ESM 执行**，抛 `require is not defined in ES module scope`，进程**退出码 1**。
>
> **用 `.cjs`（永远 CommonJS）或 `.mjs`（永远 ESM）**，或者自己放一份
> `package.json` 指明 `type`。清单里的 `main` 要跟着改（`"./main.cjs"`）。

要点：
- **`v: 1` 必须对**，版本不匹配宿主直接拒绝启动；
- 工具必须有 `description` 与顶层 `type: "object"` 的 `parameters`；
- 失败时回 `{ type: "result", id, error: "给人看的原因" }`，不要抛异常；
- 插件进程**没有宿主的环境变量**（白名单过滤），拿不到 API Key；
- 一个进程服务**所有会话**，所以工作目录从**每次请求**的 `workspaceDir` 读，
  不要缓存第一次的。

### 钩子：介入工具调用（清单里声明，代码里实现）

**这是唯一能拦住工具调用的扩展点**，也是唯一**在清单里声明、而不是在 `ready` 里注册**的东西。
两个理由：用户要在装之前就看见"这个插件会介入工具调用"；宿主也需要在进程没起来时
就知道有哪些钩子 —— 否则"进程崩了"会静默变成"没有钩子"。

清单（`hooks` 必须与 `hostHooks.register` 权限、`main` 同时出现，缺一样就装不上）：

```jsonc
"permissions": ["hostHooks.register"],
"main": "./main.cjs",
"hooks": [
  { "id": "no-rm", "event": "PreToolUse", "matcher": "^bash$" },          // 唯一能拦的
  { "id": "note", "event": "PostToolUseFailure", "failure": "open" }      // failure 只在 PreToolUse 上合法
]
```

进程侧：`ready` 里要报**你实现了哪些钩子 id**（与清单逐条对得上，对不上宿主拒绝启动），
之后按 `hook` 消息分派：

```js
const HOOKS = {
  // 拦下危险的 bash 调用。block 的文案会给模型与用户看，写清怎么办才有用
  "no-rm": (payload) => {
    const command = String(payload.args?.command ?? "");
    return command.includes("rm -rf") ? { block: "本插件禁止 rm -rf：请逐条确认要删的路径" } : {};
  },
  // 观察型：工具失败时把原因写进补充说明（下一次请求注入模型上下文）
  note: (payload) => ({ additionalContext: `上一个工具失败：${payload.toolName}` }),
};

process.parentPort.on("message", (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    process.parentPort.postMessage({
      type: "ready", v: 1, tools: [], commands: [],
      hooks: Object.keys(HOOKS),   // 清单里声明的那几个，一个都不能少、也不能多
    });
    return;
  }
  if (msg.type === "hook") {
    // msg.hook = 你声明的 id；msg.event = PreToolUse / PostToolUse / PostToolUseFailure
    // msg.payload = { toolName, args, workspaceDir[, isError, text] }
    try {
      const outcome = HOOKS[msg.hook]?.(msg.payload) ?? {};
      process.parentPort.postMessage({ type: "hookResult", id: msg.id, ...outcome });
    } catch (error) {
      // **别抛**：未捕获的异常会打死整个进程，而宿主会把所有挂起的调用按失败结算。
      // 回 error 字段即可 —— 宿主按 failure 策略处置（PreToolUse 默认拒绝）
      process.parentPort.postMessage({ type: "hookResult", id: msg.id, error: String(error) });
    }
  }
});
```

四条必须知道的规则：

1. **钩子只能加限制。** `PreToolUse` 可以拦下调用，但**永远不能放行** —— 返回值里
   根本没有 `allow` 这种东西，宿主的权限门与审批永远是最后一道。它跑在权限门
   **之前**，所以你拦下的调用不会弹审批卡；
2. **它改不了 `args`。** 参数在钩子看到它之前就已经定好了（审批也是按那一份做的）。
   想"改写命令"的钩子在这套设计里做不到，那是刻意的；
3. **出错/超时的默认处置不同**：`PreToolUse` 默认 **fail-closed**（钩子坏掉 = 拒绝，
   理由里会写清是哪个插件的哪个钩子，并提示用户停用它）；两个 post 事件默认
   **fail-open**（钩子坏掉只记一笔，不影响工具结果）。只想记日志的 PreToolUse 钩子
   请显式写 `"failure": "open"`；
4. **`additionalContext` 会进模型上下文**（下一次请求时注入，2000 字以内），
   所以别把调试信息塞进去。`matcher` 是**大小写敏感的正则**，省略 = 匹配全部工具。

**还没支持的事件**：`SessionStart` / `UserPromptSubmit` / `Stop` / `PermissionRequest`。
清单里写它们会被**拒绝并说明"还没有支持"**（不是静默忽略）—— 那是有意的：写一个
永远不触发的钩子，比装不上更难查。

### 你声明的工具**不会逐个进工具表** —— 一个插件只占一个网关

这是最容易误解的一点：你声明 `hash` / `encode` / `uuid` / `time` 四个工具，
模型看到的**不是**四个工具，而是**一个**：

```
plugin__<你的插件 key>__call        // 调用时传 { tool: "hash", args: { text: "abc" } }
plugin_tools                        // 宿主内置的目录工具，用来查参数 schema
```

这么做有两个理由，都会影响你怎么写：

1. **工具表长度可预测**。插件能声明多少工具由你的代码决定，宿主管不住；
   而每个工具的描述都进模型上下文。
2. **名字集合必须稳定**。内核按工具名记着"这个会话能用哪些工具"，
   少一个名字会让**此后每条消息都发不出去**。网关把这种失败面从 N 个缩到 1 个。

对你的实际影响：

- **`description` 要写得让模型知道"什么时候该用我"** —— 它会出现在网关的描述里
  （作为一行清单）和 `plugin_tools` 的输出里（完整那份）。写"求和"不如写
  "两个数相加；不接受字符串，字符串请先自己 parse"。
- **`parameters` 要写完整**：模型**看不到**网关描述里的参数，它得先调
  `plugin_tools({ plugin, tool })` 才知道要传什么。schema 写错或漏写字段，
  模型就只能猜。
- **工作目录别自己拼**：`msg.workspaceDir` 是宿主给的这次调用的目录。

## 写完之后

因为你写进的是 `<dataDir>/plugins/installed/`，它**已经在插件列表里了** —— 不需要安装。
让用户做两件事：

1. **启用它**：设置 → 插件 → 用户 → 找到它、打开开关（用户装的插件默认停用）；
2. **看一眼权限列表**：确认上面写的权限与它实际做的事对得上。

改完文件在插件管理里点「重载」重新扫，**不用重启应用**。

**用户想分享给别人**：那张卡片的「更多」→「分享」会导出一个 zip，
对方用「安装插件包」装进去。

**用户想继续改代码**：卡片上的「更多」→「打开数据目录」直接跳到那个文件夹。
（如果你当初写在了 `<cwd>/.oint/plugins/`，那就得走「加载开发目录」把它挂上 ——
但那类插件不能从界面卸载，所以不是默认选择。）

## 排查"装不上"

宿主会逐条报出问题，按它说的改。最常见的四种：

| 现象 | 原因 |
| --- | --- |
| `$schema 必须是 "…1.0.0…"` | 少了 `$schema`，或多打了字符 |
| `未知字段 "xxx"` | `dev.oint` 里键名打错了（那里不容忍未知字段） |
| `声明了 panel 界面就必须申请 "ui.panel" 权限` | 有 `surfaces` 却没写对应权限 |
| `unknown permission "…"` | 权限名拼错，或不在那 22 项里 |
| `插件进程在完成握手前退出（退出码 1）` | 见上面那个模块格式的警告 —— `.js` 用了 `require` 最常见。宿主会把子进程的 stderr 附在后面，照着改 |
| `插件在 5000ms 内没有完成握手` | `main` 里没有在收到 `init` 后回 `ready`，或回得太慢 |
| 技能 / 提示 / 子智能体**没生效** | 目录放了但没申请对应的 `*.contribute`（会静默忽略） |
| 工具没出现在工具表里 | 打开插件管理，看面板底部的**诊断** —— 进程起不来的原因写在那里 |

**排查顺序**：先看插件卡片上的状态与权限计数 → 再看面板底部的诊断 → 最后才去读代码。
诊断里会同时列出清单问题与**进程启动失败**（握手超时、退出码、非法声明）。

改完在插件管理里点「重载」重新扫，不用重启应用。
