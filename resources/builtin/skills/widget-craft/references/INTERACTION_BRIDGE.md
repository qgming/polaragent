# Widget 交互桥（Interaction Bridge）

widget 在不信任的 iframe（opaque origin）里运行，无法直接读写父窗口。所有 widget 内 -> 宿主的数据交互必须通过宿主注入的事件桥 `window.__WIDGET_EVENT__` 完成；反向宿主 -> widget 的更新通过 `WIDGET_UPDATE` postMessage 完成。本文档定义全部桥接协议。

## 1. 宿主在 widget 内预置的全局对象

widget 沙箱文档（`buildSandboxDocument`）在 `<head>` 注入了运行时脚本，挂载以下全局：

| 全局 | 类型 | 用途 |
| --- | --- | --- |
| `window.__WIDGET_ID__` | `string` | 当前 widget 的 ID（等同 `render_widget` 的 `title`） |
| `window.__WIDGET_DATA__` | `object` | 初始注入的数据（等同 `render_widget` 的 `data` 参数） |
| `window.__WIDGET_EVENT__` | `function(type, payload)` | 事件上报函数，单向 widget -> 宿主 |
| `window.__WIDGET_ON_UPDATE__` | `function(message)` | 宿主更新回调（一般不要重写） |

这些名字是保留字，不要覆盖。

## 2. 上报事件（widget -> 宿主）

唯一推荐方式：调用 `window.__WIDGET_EVENT__(type, payload)`。

```js
window.__WIDGET_EVENT__('click', { label: '本周访问', value: 1284 });
window.__WIDGET_EVENT__('input', { name: 'taskName', value: '设计稿' });
window.__WIDGET_EVENT__('submit', { name: 'taskName', type: 'feature', desc: '...' });
window.__WIDGET_EVENT__('change', { name: 'type', value: 'bug' });
window.__WIDGET_EVENT__('custom', { action: 'move', cardId: 'c1', from: 0, to: 1 });
```

推荐 `type`：

| type | 何时用 |
| --- | --- |
| `click` | 卡片、节点、图表分段被点击 |
| `input` | 文本框、文本域实时输入（防抖） |
| `change` | select / checkbox / radio 切换 |
| `submit` | 表单整体提交 |
| `custom` | 上述以外的语义动作 |

## 3. payload 规范

- 必须是 JSON 可序列化对象。
- 包含能定位交互语义的字段，如 `name`、`value`、`cardId`、`action`、`index`。
- 不放富文本 HTML 字符串。

## 4. 不允许的越权写法

- 不要用 `window.parent.postMessage(...)`。
- 不要直接 `window.parent.xxx()`。
- 不要依赖 `document.cookie` 或任何父窗资源。
- 只用 `window.__WIDGET_EVENT__`。

## 5. 宿主 -> widget 更新（WIDGET_UPDATE）

宿主可以发 `WIDGET_UPDATE` 消息给 widget，更新内容或数据。机制：

- 宿主再次调用 `render_widget`（`update_mode: "patch"` 或 `"replace"`）时，前端把新 HTML / data 通过 `postMessage` 推给 iframe。
- iframe 内默认已挂载 `window.__WIDGET_ON_UPDATE__(message)` 处理：
  - 若 `message.html` 是字符串，则把 `#widget-root` 的 `innerHTML` 替换为该 html 的 `<body>` 内容。
  - 更新 `window.__WIDGET_DATA__` 为 `message.data`。
  - 触发尺寸重测量。

通常不需要重写 `__WIDGET_ON_UPDATE__`。

## 6. 更新模式选择

`render_widget` 的 `update_mode`：

| 模式 | 行为 | 何时用 |
| --- | --- | --- |
| `replace` | 丢弃旧 widget 内容与状态，全量替换 | 第一次渲染、改变布局、展示全新数据 |
| `patch` | 保留 form 状态，只替换结构 | 流式更新、表单分步填写、局部迁移 |

## 7. 表单状态保留机制

宿主在 widget 内持续上报 `WIDGET_STATE`，保存 `input, textarea, select` 的 `{key, tag, inputType, value, checked}`。在 `patch` 更新时逐一恢复。

实践建议：

- 表单元素加 `name` + `id` 双标识。
- 不要在每次输入都触发 `replace` 更新。
- 控件顺序尽量稳定。

## 8. 高度自适应

宿主通过多重信号自适应 widget 高度，无需手动写高度：

- iframe 内触发 `WIDGET_RESIZE`
- ResizeObserver / MutationObserver / fonts.ready 分别触发回测
- 父端有 retry 兜底

你只需要：

- 不要给 `body` / 外层容器写死 `height` 或 `overflow: hidden`
- 让内容自然撑开

## 9. 自检清单

- [ ] 所有用户交互都走 `window.__WIDGET_EVENT__`。
- [ ] 输入事件带防抖，避免刷屏宿主。
- [ ] 表单元素都带 `name` 和 `id`，支持 `patch` 模式状态恢复。
- [ ] 没有给 body 写死高度 / overflow:hidden。
- [ ] 没有重写 `__WIDGET_ON_UPDATE__`，除非确实需要。
