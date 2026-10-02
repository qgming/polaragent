---
name: plugin-authoring
description: 创建或修改 Oint 插件，包括 Chord agent facet、工具、原生工具钩子、技能、提示、MCP 和桌面面板。产出可加载的 package.json 插件目录或预构建 ZIP 包。
---

# Oint 插件

插件使用 `package.json` 和 Chord 1.0.0 的 facet bundle。先阅读宿主的 `src/main/plugins/agent-service.ts` 与 `src/main/plugins/manifest.ts`；现成例子在 `resources/plugins/toolkit/agent.ts`、`resources/plugins/git-status`、`resources/plugins/scratchpad`。

在当前项目的 `.oint/plugins/<name>/` 创建源码。项目插件、全局安装包和开发挂载默认停用，由用户在插件管理中启用。加载开发目录和手动重载会调用官方 `bundleFacetPackage`，不执行 npm lifecycle scripts。

## 包结构

```text
package.json
agent.ts                    # 可选的 Chord facet 源码
dist/chord-facets.json       # 可执行 ZIP 包必须预构建
dist/<content-hash>.cjs      # 官方 bundler 生成，不能手写 hash
skills/<name>/SKILL.md
prompts/<name>.md
subagents/<name>.md
mcp.json
ui/index.html
```

```json
{
  "name": "@example/helper",
  "version": "1.0.0",
  "description": "Describe the feature",
  "peerDependencies": { "@earendil-works/chord": "1.0.0" },
  "chord": { "facets": { "agent": "./agent.ts" } },
  "oint": {
    "displayName": "Helper",
    "permissions": ["agent.tool.register", "skills.contribute"]
  }
}
```

只贡献界面或文件时省略 `chord` 和 `agent.ts`。包名是身份，宿主据此分配私有数据、面板分区与工具名称。打包 ZIP 时保留 package.json、已构建 dist 和资源文件；宿主安装时校验 Chord SHA-256 与包身份。

## Agent service

Facet 使用官方 `defineFacet`、`defineService`、`env.provide`、`env.replicatedState`、`env.own` 与激活/释放方法。导出默认 facet 或 facet 数组。提供 `oint.plugin.agent` service，方法最后一个参数必须是 Chord `Context`，返回 Promise。

服务契约：

- `description`: replicated state，含 `tools`、`commands`、`sections`。
- `execute(name, args, invocation, context)`: 返回原生 Durable `ToolExecutionResult`，含 content、details、diagnostics、usage 等 JSON 数据。invocation 含 callId、taskId、conversationId、cwd。
- `command(name, args, cwd, context)`: 返回显示给用户的文本。
- `beforeTool(call, invocation, context)`: 返回 `{arguments?, block?}`。需要 `oint.hooks: ["beforeTool"]` 和 `hostHooks.register`。
- `afterTool(call, result, invocation, context)`: 返回原生工具结果。需要 `oint.hooks` 中的 `afterTool`。

未使用的方法仍提供空实现：beforeTool 返回 `{}`；afterTool 返回收到的 result；command 对不存在的命令抛错。description 至多包含 64 个工具、64 个命令、32 个 section。工具参数是 JSON object schema，工具名最长 40 字符，字母开头，后续可用字母数字下划线连字符。

宿主为每个插件生成独立 Durable Extension，直接公开每个工具的 schema；不要实现工具网关或目录调用协议。description 变更通过 Chord state 发布后，下一次 native registry 解析看到新定义。工具可配置 `replay`、`executionMode`、`outputLimits`；默认 replay 为 unsafe。随机数、时钟、外部写操作保持 unsafe，只有能安全重做的操作才声明 safe。

所有异步操作传递 `context.abortSignal`。取消和超时通过官方 Client/Server 协议送到服务端；忽略信号会让插件执行在取消后继续运行。工具调用默认 120 秒、工具钩子 5 秒。停止或更新会等待已经开始的服务调用结束后释放旧 worker，失败候选保留此前可工作的版本。无法加载的 beforeTool 策略保持拒绝，用户可停用插件恢复工具调用。

钩子可以改写参数，宿主自己的权限审批在插件钩子之后检查最终参数。不要尝试代替宿主批准工具。原生 task 函数、commit 回调和 ToolExecutionApi 方法不能穿过进程 JSON 边界；第三方 facet 运行在 utilityProcess 中，使用上述服务子集。

## 界面和资源

`oint.surfaces` 声明 `{id, kind, title, entry}`，kind 为 panel/modal/window，分别需要 ui.panel/ui.modal/ui.window。entry 是包内 `./` 相对路径。window 可用 width/height、shape:widget、alwaysOnTop、resizable、skipTaskbar；modal 只接受尺寸。

`window.oint` 提供 info、ready()、close()、workspace()、storage.get/set、notify、writeText、fetch、exec、on("theme", listener)。每项能力按真实权限检查：storage、notify、clipboard.write、net.fetch（配 oint.net.domains）、shell.exec（配 oint.shell.exec 裸命令白名单）。页面遵循宿主 CSP，不启用 Node。

skills、prompts、subagents 分别需要 skills.contribute、prompts.contribute、subagents.contribute。mcp.json 使用 `{mcpServers:{name:{command,args}|{url}}}`；本地需要 mcp.server.local，远端需要 mcp.server.remote。

utilityProcess 提供崩溃隔离，Node facet 能访问完整 Node API；权限表约束的是宿主提供的能力。使用 `env.own` 清理定时器、连接等资源。私有持久文件可写到 `process.env.OINT_PLUGIN_DATA_DIR`。第三方依赖在作者构建时打进 bundle；host peer dependency 只使用公开的官方 1.0.0 API，不引入 pi-coding-agent、pi-tui 或无关 CLI/TUI。

交付前验证：界面资源路径、包元数据、官方 bundle 完整性、实际工具调用、取消、启停/更新和私有数据保留。验证完成后给出插件目录、功能和使用入口。
