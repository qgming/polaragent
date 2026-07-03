# Widget 安全契约（Security Contract）

PolarAgent 内置 `render_widget` 工具允许 AI 在对话中渲染交互式 HTML。宿主侧已经构建了多层防御纵深：iframe sandbox 隔离 + 工具入口 HTML 净化 + AI 审查 + CSP。本契约写明你必须主动遵守的禁用清单、允许清单与边界。

> 一句话：Widget 在不信任的 iframe 里运行。不要试图越权；任何正当数据交互都通过事件桥 `__WIDGET_EVENT__` 上报宿主。

## 1. 防御纵深总图

```text
        AI 生成 widget_code 或引用自有 custom widget_path
                      │
                      ▼
   ┌──────────────────────────────────────────┐
   │ Layer 1  render_widget 工具入口净化        │ src/ai/tools/widget-render.ts
   │   删除禁用标签 + 删除 on* 属性            │
   ├──────────────────────────────────────────┤
   │ Layer 2  AI 权限审查（HIGH_RISK）         │ src/ai/tool-permissions.ts
   ├──────────────────────────────────────────┤
   │ Layer 3  iframe sandbox 隔离              │ src/components/widget/WidgetSandbox.tsx
   │   sandbox="allow-scripts"                │
   ├──────────────────────────────────────────┤
   │ Layer 4  CSP 策略                         │ buildSandboxDocument 注入
   │   default-src 'none'; connect-src 'none' │
   └──────────────────────────────────────────┘
```

## 2. 禁用标签清单

工具入口净化会直接删除以下标签：

- `<iframe>` `<object>` `<embed>` `<base>` `<link>` `<meta>`

`<form>` 已放宽可用，但提交动作仍受 sandbox + CSP 约束，通常仍推荐 `<button type="button">` + `__WIDGET_EVENT__('submit', ...)`。

## 3. 行内事件与外链

- 禁止 `on*=` 行内事件属性。
- 禁止 `javascript:` 协议的 `href` / `src`。
- 禁止 CDN、外链图片、Web Font、`<script src>`。

所有交互都应改用 `addEventListener`。

## 4. 运行时物理边界

当前真实安全边界来自两层：

1. iframe `sandbox="allow-scripts"`（不带 `allow-same-origin`）-> opaque origin，无法读写父窗资源。
2. CSP `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'` -> 出站连接全部阻断，外链脚本 / 图片 / Web Font 都不可用。

因此：

- `window.parent`、`document.cookie`、`fetch`、`WebSocket` 等路径都不可作为正常交互方案。
- 即便某些脚本 API 在语法上可写，也不应当依赖它们做外部通信。
- 正常交互只走 `__WIDGET_EVENT__`。

## 5. HTML 来源策略

`render_widget` 仍支持两种来源：

| 参数 | 来源 | 适用场景 |
| --- | --- | --- |
| `widget_code` | AI 现场内联 HTML | 默认推荐路径 |
| `widget_path` | 用户自己维护的 `custom/...` 模板 | 仅在项目明确自带模板体系时使用 |

注意：`widget-craft` 自身不再提供 `builtin/.../templates/*.html` 示例模板。这个 skill 的定位已经切换为**规范型技能**。

## 6. 数据注入契约

`render_widget` 的 `data` 参数会被宿主序列化后注入到 `window.__WIDGET_DATA__`：

```js
var data = window.__WIDGET_DATA__ || {};
var items = data.items || [];
```

规则：

- `data` 必须是 JSON 可序列化对象。
- 所有字段都应有合理默认值，方便脱离宿主预览。
- 不要把富文本 HTML 直接塞进 `innerHTML`。

## 7. 输出引导原则

- 失败优先：命中禁用清单就拒绝调用，而不是偷偷绕过。
- 不要用字符串拼接、注释分隔等技巧试图绕过净化。
- 正当数据交换需求统一走 `window.__WIDGET_EVENT__`。

## 8. 自检清单

- [ ] 没有 `<iframe>` `<object>` `<embed>` `<base>` `<link>` `<meta>`。
- [ ] 没有 `on*=` 行内事件属性。
- [ ] 没有外链脚本、外链图片、Web Font。
- [ ] 所有交互都通过 `addEventListener` + `__WIDGET_EVENT__`。
- [ ] `data` 字段都有占位默认。
- [ ] 没有把技能理解成依赖内置 HTML 模板的系统。
