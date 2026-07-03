# Widget 设计令牌（Design Tokens）

这份文档定义 PolarAgent Widget 的视觉基线。所有 `widget-craft` 产出的 HTML，尤其是通过 `widget_code` 现场生成的 widget，都必须遵守这里的令牌约定，确保 widget 在浅色/深色、不同分辨率下都与宿主界面一致。

> 当前默认审美方向为 **Matte Cupertino / Apple Utility Pro**：不透明表面、克制边框、系统紫作为少量强调色，整体更像系统工具与专业工作台，而不是营销卡片或玻璃态组件。

## 1. 宿主注入的 CSS 变量

PolarAgent 在 widget 沙箱中固定注入以下变量（来自 `src/components/widget/WidgetSandbox.tsx` 的 `WIDGET_BASE_CSS`）。这些变量会自动跟随系统 `prefers-color-scheme` 切换浅色/深色取值：

| 变量 | 浅色取值 | 深色取值 | 用途 |
| --- | --- | --- | --- |
| `--widget-fg` | `#202421` | `#ededed` | 主要文字 |
| `--widget-muted` | `#858b86` | `#9e9e9e` | 次要/辅助文字 |
| `--widget-border` | `#e5e7eb` | `#2e2e2e` | 边框、分割线 |
| `--widget-card` | `#ffffff` | `#1a1a1a` | 外层卡片主表面 |
| `--widget-surface` | `#f5f5f7` | `#232326` | 次级表面、表头底、嵌套区 |
| `--widget-tint` | `#f1eafb` | `#2e2342` | hover / selected 的淡紫底 |
| `--widget-accent` | `#9b6fe0` | `#b898f0` | 系统紫强调 |
| `--widget-accent-strong` | `#5b3a9e` | `#c9aef5` | 更强一级的强调紫 |
| `--widget-button` | `#5b3a9e` | `#b898f0` | 主按钮、主要操作态 |
| `--widget-button-hover` | `#4f3289` | `#c9aef5` | 主按钮 hover |
| `--widget-button-fg` | `#ffffff` | `#140f1d` | 主按钮文字 |
| `color-scheme` | `light` | `dark` | 告诉浏览器原生控件走哪个配色 |

所有颜色优先引用上述变量，不要裸写业务色。

```css
color: var(--widget-fg);
border: 1px solid var(--widget-border);
background: var(--widget-button);
```

## 2. 硬编码兜底方案

为防止 HTML 脱离宿主预览（变量未注入），所有引用宿主变量的地方都必须带兜底：

```css
color: var(--widget-fg, #202421);
border: 1px solid var(--widget-border, #e5e7eb);
background: var(--widget-button, #5b3a9e);
```

推荐同时采用两层兜底：

- **方案 A**：在 `:root` 里声明一份默认值，并在 `@media (prefers-color-scheme: dark)` 覆盖。
- **方案 B**：每个 `var(...)` 第二参数直接写兜底色。

## 3. Matte Cupertino 的默认语气

所有 widget 默认遵守以下视觉语气：

- 表面必须不透明：`--widget-card` / `--widget-surface` 为主，不使用玻璃拟态、毛玻璃、透明浮层。
- 强调色要节制：系统紫只用于按钮、选中、图表主系列、重要 hover，不要整块大面积铺紫。
- 边框先于阴影：用 `1px` 结构线划分区块，默认不依赖重阴影。
- 像工具，不像海报：信息密度可以高，但要规整、安静、可扫读。

## 4. 自定义强调色

如果某个 widget 需要自己的强调色（如图表分段色、趋势色），必须：

- 定义在 `:root` 内，命名为 `--my-*` / `--seg-*` 等命名空间。
- 在深色媒体查询里同步覆盖一组更亮、更柔和的取值。
- 仍然服从整体 Matte Cupertino 方向，避免跳成企业蓝、亮青、荧光紫。

推荐示例：

```css
:root {
  --my-accent: #5b3a9e;
  --seg-1: #5b3a9e;
  --seg-2: #9b6fe0;
  --seg-3: #d7c5f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --my-accent: #c9aef5;
    --seg-1: #c9aef5;
    --seg-2: #b898f0;
    --seg-3: #6f5c94;
  }
}
```

状态色也应走克制版：

- 正向：`#346538` / `#edf3ec`
- 警示：`#956400` / `#fbf3db`
- 风险：`#9f2f2d` / `#fdebec`

## 5. 字体

统一字体栈，不引入 Web Font：

```css
font-family:
  ui-sans-serif, system-ui, -apple-system,
  "Segoe UI", "Microsoft YaHei", "PingFang SC",
  sans-serif;
```

字号层级（14px 基线）：

| 层级 | 字号 | 字重 | 用途 |
| --- | --- | --- | --- |
| 大数字 | 24–34px | 700 | KPI / 主值 |
| 卡片标题 | 14–15px | 600 | 卡片标题、区块标题 |
| 表头 / Label | 12px | 600 | 表头、字段名、辅助标签 |
| 正文 | 13–14px | 400 | 表格、表单、卡片正文 |
| 辅助 | 12–13px | 400 | 单位、说明、次要信息 |

## 6. 间距与圆角

固定 4/8 网格，不要出现 7px / 13px / 17px 等野值：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `gap-1` | 4px | 微小内间距、图标与文字 |
| `gap-2` | 8px | 按钮内边距、卡片紧凑分组 |
| `gap-3` | 12px | 字段间距、列表项间距 |
| `gap-4` | 16px | 卡片内边距、列间距 |
| `gap-6` | 24px | 大区块分隔 |
| `gap-8` | 32px | 强视觉断层 |

圆角统一：

- 小元素：`6px` 到 `8px`
- 卡片：`8px` 到 `10px`
- 不要超过 `12px`

## 7. 高度、溢出与可用性

宿主通过 `WIDGET_RESIZE` 消息自适应 widget 高度。请遵守：

- 不要写死 `body` 高度，让内容自然撑开。
- 不要给 `body` 或最外层容器写 `overflow: hidden`。
- 单个 widget 推荐高度区间 `96–360px`；超过建议拆分或分段展示。
- 可点击区域优先完整包裹条目，不要只让小图标可点。
- 默认保留清晰的 `focus-visible` 态，键盘可访问性不要丢。

## 8. 反 Slop 检查

- [ ] 颜色全部来自 `--widget-*` 或命名空间化 `--my-*`，没有裸 `#007BFF` / `#fff` / `#000`。
- [ ] 默认视觉方向符合 Matte Cupertino / Apple Utility Pro，而不是玻璃态、营销卡片或大面积高饱和色块。
- [ ] 所有 `var(--widget-x)` 都带兜底。
- [ ] 4/8 网格，没有野间距。
- [ ] 圆角不超过 12px。
- [ ] 字体只用系统栈，没有引入 Web Font。
- [ ] 深色媒体查询已覆盖自有变量。
- [ ] 信息密度、可扫读性、焦点态、点击热区都足够像工具型界面。
