# 归档：未接线的 assistant-ui Elements

## 这个目录是什么

`src/renderer/components/assistant-ui/elements/` 下曾有一批从 shadcn 注册表 `@assistant-ui` 装进来、
却从未接线的组件（registry 地址见根目录 `components.json` 的 `registries` 配置）。这里保存其中
「不删除、但也不再留在 `src/` 里」的 6 个文件的参考副本。

移出而不是删除的原因：它们属于**上游镜像保留**政策的产物（本地没有真实消费者，留着只是为了对照上游
实现），或含有本地改动（`edit-message.tsx` 有 4 行本地 i18n props）。移出 `src/` 后：

- 不再被 `tsconfig.json` 类型检查（`include` 只收 `src/renderer` 与 `src/shared`）；
- 不再被 Biome 扫描（`files.includes` 只收 `src/**` 与根目录文件）；
- 不再出现在 `npm run check:unwired` 的扫描范围内。

注意：这些文件是**参考副本**，文件内的 import（`./surfaces`、`@/...`）在当前位置并不可解析，
不要直接从 `docs/` 引用它们；需要使用时按下文重装回 `src/`。

## 归档清单

| 文件名 | registry item 名 | 归档原因 |
| --- | --- | --- |
| `conversation-search.tsx` | `@assistant-ui/elements-conversation-search` | 上游镜像保留；本地没有接线计划（搜索入口走 command palette） |
| `edit-message.tsx` | `@assistant-ui/elements-edit-message` | 含 4 行本地 i18n props（`cancelLabel` / `sendLabel` / `sendDisabled` / `inputLabel`）；本地实际用 `features/chat/EditMessageDialog.tsx` |
| `settings-panel.tsx` | `@assistant-ui/elements-settings-panel` | 上游镜像保留；本地设置面板为 `features/settings/SettingsModal.tsx` |
| `thread.aui.tsx` | `@assistant-ui/thread` | 上游镜像保留；本地 `features/chat/Thread.tsx` 的布局参考（其引用的 tool-group / follow-up-suggestions 同批归档） |
| `tool-group.aui.tsx` | `@assistant-ui/tool-group` | 上游镜像保留；仅被 `thread.aui.tsx` 引用，同批归档 |
| `follow-up-suggestions.aui.tsx` | `@assistant-ui/follow-up-suggestions` | 上游镜像保留；runtime 未提供 suggestions 数据源，接上也是恒空 |

## 如何重装

在项目根目录按 item 名重装：

```bash
npx shadcn@latest add "@assistant-ui/elements-conversation-search"
npx shadcn@latest add "@assistant-ui/elements-edit-message"
npx shadcn@latest add "@assistant-ui/elements-settings-panel"
npx shadcn@latest add "@assistant-ui/thread"
npx shadcn@latest add "@assistant-ui/tool-group"
npx shadcn@latest add "@assistant-ui/follow-up-suggestions"
```

命名规律：普通 `.tsx` 文件的 item 名是 `elements-<文件名>`（去掉扩展名）；带 `.aui.tsx` 后缀的
文件 item 名**没有** `elements-` 前缀，例如 `thread`、`tool-group`、`follow-up-suggestions`。

> **重装会覆盖本地改动。** 重装前先对比本目录的归档副本，`edit-message.tsx` 的 4 行 i18n props
> 尤其需要手动合回。
