---
feature: assistant-ui-elements
status: delivered
updated: 2026-09-10
branch: main
commits: 6985669..working-tree
---

# 样式基础修复与官方 assistant-ui elements 接入

## Report

**What was built** — 三件事。其一，在 `src/index.css` 补上 shadcn 约定的全局边框兜底 `@layer base { *, ::before, ::after { border-color: var(--border) } }`，让裸 `border`（Tailwind v4 下会落到 `currentColor`，即继承文字色而呈近黑）改落到设计令牌，一次性修正 8 处；显式颜色工具类与任意值因 utilities 层在后而仍生效。其二，恢复被上一轮重构误删的 `tw-shimmer` 依赖与 `@import`，救回 3 处静默失效的流光动画。其三，从官方 registry 逐字节落地 `surfaces.tsx` 与 `thinking-indicator.tsx`，并按官方标准接法在助手消息正文之前接入实时状态行：有未返回的工具调用时显示「正在运行 <工具名>」，否则显示「思考中」并附计时，正文或思考内容产出后自动消失；`useThinkingLabel` 的判定抽为纯函数 `deriveThinkingLabel` 并配单测。

**Verification** — `npm run typecheck` PASS（renderer + electron）；`npm test` PASS（5 文件 35 用例，其中 7 个为本次新增的标签判定单测）；`npm run build` PASS（三进程）。Electron 探针加载构建产物实测：裸 `border` 计算值为 `rgb(229,231,227)` = `--border`（`#e5e7e3`），与文字色 `#202421` 不同，确认兜底生效。产物核对：`.shimmer` 规则、`aui_assistant-thinking`、`思考中` / `正在运行` 文案均已进入构建结果。独立审查复核了 T1–T5（含自行拉官方 JSON 逐字节比对两份新文件），未发现 critical。

**Journey log**

- 全局 `* { border-color }` 这类兜底的缺失是**静默**的：组件自身完全正确（官方 `reasoning.tsx` 与本地逐字节一致），错的是项目没提供它所依赖的基础令牌。排查时不该从组件代码找起，而应直接读构建产物的计算样式。
- `MessagePrimitive.GroupedParts` 的 `indicator` 是**合成**的渲染槽，不在 `message.parts` 里，默认模式 `no-text` 会在「运行中且结尾非 text/reasoning」时发射 —— 例如刚跑完工具、模型正在组织正文那段。若把判定写成 `parts.length === 0`，就会出现「原 `...` 占位有提示、新指示器什么都没有」的倒退。这一档是我首版实现漏掉的，由自己复核发现并修正，随后独立审查确认修正版与库谓词等价。
- 官方 `thinking-indicator` 的定位是**紧凑状态行**（标签 + 计时），与 Reasoning 折叠块互补而非替代；它不接管正文渲染，只补正文产出前的空档。
- 「官方组件」不等于「可以直接覆盖」：`tool-group`（本地 231 行 vs 官方 116）与 `thread-list`（430 vs 81）本地功能远超官方版，覆盖会丢功能；已一致或仅微小差异的 9 个则无需动作。
- 单测的价值在 mutate 验证中体现：把谓词回退成首版的 `parts.length === 0` 后，正是那条覆盖「工具已返回但正文未出」空窗的用例失败了 —— 否则这类空窗只能靠肉眼在特定时序下撞见。

## [S1] Problem

两个用户可见问题，外加一次组件对齐调研。

**P1：部分组件出现黑色外边框。** Tailwind v4 的 preflight 是 `border: 0 solid`，不再设 `border-color`；裸 `border` 因而落到 CSS 默认值 `currentColor`，即继承文字色（浅色主题下近黑）。构建产物证实：`.border{border-style:var(--tw-border-style);border-width:1px}`，无 `border-color`；且 CSS 中不存在全局 `border-color` 兜底。项目 `index.css` 从未有过 shadcn 标准的 `* { border-color }` 规则（`git log -S 'border-border' -- src/index.css` 无历史命中），而 shadcn 模板与官方 elements 都假定项目提供该兜底 —— 官方 `reasoning.tsx` 的 `outline` 变体本身就是裸 `border`（与官方逐字节一致）。

裸 `border` 的 8 处：`reasoning.tsx:28`（截图中的黑框）、`tool-group.aui.tsx:26`、`follow-up-suggestions.aui.tsx:55`、`thread-list.aui.tsx:407`、`thread.aui.tsx:518`、`button.tsx:15`（浅色模式）、`dialog.tsx:62`、`Toast.tsx:43`。

**P2：思考/运行的流光动画静默失效。** 精简重构时移除了 `tw-shimmer`（`package.json` 依赖与 `index.css` 的 `@import`），但代码仍有 3 处在用 `shimmer` 类：`reasoning.tsx:192`、`tool-fallback.aui.tsx:168`、`tool-group.aui.tsx:131`。构建产物中已无 `.shimmer`，动画不生效。官方 `surfaces.tsx` 的 `ShimmerLabel` 同样依赖 `tw-shimmer`。

**P3：缺少「真正的思考状态」。** 正文产出之前界面没有任何运行态反馈，也拿不到正在执行哪个工具。

**组件对齐调研结论**（官方 registry 逐条目比对，本地文件为基准）：

| 类别 | 组件 | 说明 |
| --- | --- | --- |
| 已逐字节一致 | attachment / file / image / markdown-text / reasoning / tooltip-icon-button / follow-up-suggestions | 无需动作 |
| 微小差异 | `thread.aui.tsx` | 官方多「编辑用户消息」按钮，本地**故意移除**（避免 runtime throw） |
| 微小差异 | `tool-fallback.aui.tsx` | 仅 `Object.hasOwn` → `hasOwnProperty.call`（target ES2020 适配） |
| 本地深度定制 | `tool-group.aui.tsx`（231 行 vs 官方 116）/ `thread-list.aui.tsx`（430 行 vs 官方 81） | 覆盖会丢功能 |
| 官方有本地无 | `surfaces.tsx` / `thinking-indicator.tsx` / `reasoning-panel.tsx`（+ `utils/range.ts`） | 前两个是本次接入项 |

## [S2] Design

### S2.1 全局边框兜底（修 P1）

在 `src/index.css` 的 `@import "tailwindcss"` 之后加：

```css
@layer base {
  *,
  ::before,
  ::after {
    border-color: var(--border);
  }
}
```

用 `var(--border)` 而非 `--color-border`：本项目的 `@theme inline` 会把主题变量内联进工具类（构建产物中 `.border-border/60` 即 `border-color:var(--border)`），`--color-border` 并不作为 CSS 自定义属性存在。

这条规则让裸 `border` 落到设计令牌的边框色，一次性修正全部 8 处，并与显式的 `border-border/60` 等保持一致；未来接入任何官方 element 都不再重复踩坑。显式颜色声明（如 `border-input`、`border-destructive`）优先级更高，不受影响。

### S2.2 恢复 shimmer（修 P2）

恢复 `tw-shimmer` 依赖与 `index.css` 中的 `@import "tw-shimmer";`，使 `shimmer` 类重新可用。这是接入官方 `surfaces.tsx` 的前置条件。

### S2.3 新增官方组件（P3 的基础）

从官方 registry 取 `elements-surfaces` 与 `elements-thinking-indicator` 两份文件，**逐字节落地**到 `src/components/assistant-ui/elements/`：

- `surfaces.tsx` —— 官方共享样式令牌与 `ShimmerLabel` / `SwapLabel`；提供 `paper` / `field` / `ghostButton` / `mono` 等。
- `thinking-indicator.tsx` —— `ThinkingIndicator({ label, elapsed })`：脉冲点 + 每次变化重放的流光标签 + 可选计时徽标。

两者保持与官方一致（不做本地改写），以便后续整体重新拉取时无冲突。`thinking-indicator.tsx` 对 `surfaces` 的 `import { mono, ShimmerLabel } from "./surfaces"` 与落地路径天然匹配。

### S2.4 接入 ThinkingIndicator（修 P3）

按官方文档的标准接法，在对话消息内、正文之前渲染一条状态行：

- **标签来源**：`useAuiState` 推导，三档 —— 消息 `status.type === "running"` 时，(1) 若存在 `result === undefined` 的 `tool-call` part 则显示 `正在运行 <工具名>`；(2) 否则若结尾不是 `text`/`reasoning`（含 `parts` 为空）则显示 `思考中`；(3) 否则返回 `undefined`，指示器消失、让位给真实内容。
  第 (2) 档必须与 `MessagePrimitive.GroupedParts` 默认的 indicator 模式（`no-text`）对齐：该模式在「运行中且结尾不是 text/reasoning」时也会发射 indicator，例如刚跑完工具、模型正在组织正文的那段。漏掉这一档会出现「原 `...` 占位有提示、新指示器什么都没有」的倒退。另注：`IndicatorPart` 是 `GroupedParts` 合成的渲染槽，**不在** `s.message.parts` 中，因此不能靠扫描 `parts` 判断它是否会被发射。
- **计时**：独立 `setInterval` 每秒更新（官方说明 `metadata.timing` 只在流结束后才最终化，实时徽标必须自己计时），`label` 变为 `undefined` 时清除。
- **落点**：接入 `thread.aui.tsx` 的助手消息渲染路径，位于消息正文之前，仅在该消息处于运行态时参与渲染。

### S2.5 不改动项

`tool-group.aui.tsx` 与 `thread-list.aui.tsx` 保留本地版本（本地功能超出官方版），`thread.aui.tsx` 保留「不做用户消息就地编辑」的本地决定，`tool-fallback.aui.tsx` 保留 ES2020 适配。

## [S3] Out of Scope

- 不接入 `reasoning-panel`（需额外引入 `utils/range.ts`，属新增 UI 面板，本次未要求；先落地会形成死代码）。
- 不覆盖 `tool-group` / `thread-list` 的本地定制。
- 不恢复 `thread.aui.tsx` 的用户消息编辑按钮。
- 不更换包管理器（项目为 npm，不使用 pnpm）。
- 不调整 `reasoning-panel` 之外的其它 elements 视觉。
- 不改动出网桥接与工具层。

## Tasks

- [x] T1: 加全局边框兜底 — acceptance: `index.css` 含 `@layer base` 下的 `border-color: var(--border)`；构建产物中裸 `border` 继承该令牌而非 `currentColor` (covers: S2.1)
- [x] T2: 恢复 tw-shimmer — acceptance: `package.json` 含 `tw-shimmer`，`index.css` 含其 `@import`，构建产物中存在 `.shimmer` (covers: S2.2)
- [x] T3: 落地官方 surfaces.tsx 与 thinking-indicator.tsx — acceptance: 两文件存在且与官方 registry 内容一致；typecheck 通过 (covers: S2.3; depends: T2)
- [x] T4: 接入 ThinkingIndicator — acceptance: 运行态且无待完成工具时显示「思考中」，有待完成工具时显示「正在运行 <工具名>」，正文产出后消失 (covers: S2.4; depends: T3)
- [x] T5: 全量验证 — acceptance: `npm run typecheck` / `npm test` / `npm run build` 全绿 (covers: S2; depends: T1-T4)
- [x] T6: 抽出标签谓词并补单测 — acceptance: `deriveThinkingLabel` 为纯函数且有单测覆盖三档判定；回退为仅 `parts.length === 0` 时测试失败 (covers: S2.4; depends: T4)
