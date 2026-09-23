# 插件管理模态窗 · 实施计划

> **本文件的范围**：为 Oint 新增一个**插件管理模态窗**（与设置模态同尺寸），并在**左侧栏底部、主题模式按钮的左侧**新增触发按钮。
> 它只管**宿主 UI**（模态窗 + 按钮 + 列表数据通路）。插件运行时（清单校验、加载、进程、界面形态）在 `docs/plugin-system-plan.md` 与 `docs/plugin-ui-surfaces-implementation.md` 里，本文件在 §7 说明两者的接缝。
>
> **可独立交付**：期 1 只需一个返回空列表的 IPC 处理器就能上线，插件运行时随后填充它。

---

## 1. 目标与验收

### 1.1 目标

1. **左侧栏底部、主题切换按钮左侧**新增一个"插件"图标按钮。
2. 点击后打开一个**与设置模态同尺寸**（880×640）的插件管理模态窗。
3. 模态窗里能**看到、启用/停用、查看详情、安装、卸载**插件。
4. 视觉与交互**与设置模态完全同构** —— 同一套尺寸、左侧导航、动效、令牌，用户不应感觉到这是两个不同的东西。

### 1.2 验收判据

| # | 判据 |
| --- | --- |
| 1 | 侧栏底部的顺序是 `[设置] …… [插件][主题]`，插件按钮**紧邻主题按钮左侧** |
| 2 | 点击插件按钮打开模态；模态尺寸、圆角、左侧导航宽度与动效**与设置模态逐像素一致** |
| 3 | `Esc`、点击遮罩、点右上角关闭 —— 三种方式都能关；关闭后焦点回到侧栏的插件按钮 |
| 4 | 插件列表为空时显示空态（含"安装插件包""加载开发插件"两个入口），**不显示空白** |
| 5 | 运行时未接入（IPC 无处理器）时**不抛错、不白屏**，降级为空态 + 一行诊断 |
| 6 | 同一时刻只能开一个模态：插件模态与设置/搜索模态互斥 |
| 7 | `Ctrl/Cmd + Shift + X` 能打开它（与 VS Code 的扩展面板同键）；**且 `Ctrl/Cmd + Shift + K` 不再误触搜索**（§3.3 的顺带修复） |
| 8 | 中英双语词条齐全，`npm run check:i18n` 绿 |
| 9 | `npm run typecheck` / `npm run lint` / `npm run test` 全绿 |

---

## 2. 现状（改之前长什么样）

> 全部逐行核对过，不是推测。

### 2.1 侧栏底部（`src/renderer/app/SidebarShell.tsx:133-141`）

```tsx
{/* 底部：设置（左）+ 主题切换（右） */}
<div className="border-t border-border/60 p-2">
  <div className="flex items-center justify-between">
    <IconButton label={t("sidebar.settings")} onClick={() => openSettings()}>
      <Settings2 className="size-4" />
    </IconButton>
    <ThemeToggle side="right" />
  </div>
</div>
```

### 2.2 设置模态的形状（`features/settings/SettingsModal.tsx`）

| 项 | 实值 |
| --- | --- |
| 尺寸 | `h-[640px] max-h-[86vh] w-[880px] max-w-[92vw]` |
| 圆角 / 内边距 | `rounded-xl p-0 gap-0 overflow-hidden` |
| 结构 | `<Dialog>` → `<Tabs orientation="vertical">` |
| 左导航 | `w-[200px] shrink-0 border-r bg-sidebar p-2`，内含 `DialogTitle` + `TabsList` |
| 右内容 | `<ScrollArea className="h-full">` → 每项 `<TabsContent className="p-5">` |
| 动效 | `motion.div` 淡入 + 上移 4px，`duration 0.18`，`ease [0.23,1,0.32,1]` |
| 导航项样式 | `navItem` 常量（`h-8 rounded-[10px] px-3 text-sm`，选中态 `bg-foreground/[0.06]`） |
| 面板标题 | `<SettingsPanelTitle>`（来自 `settings-shared.tsx`） |

### 2.3 模态状态的既有形状（`stores/ui-store.ts`）

```ts
settingsOpen: boolean;
settingsSection: SettingsSection;
export type SettingsSection = "general" | "services" | "web" | "mcp" | "skills"
  | "subagents" | "promptTemplates" | "personalization" | "data" | "about";
export const SETTINGS_SECTIONS = [...] as const satisfies readonly SettingsSection[];
```

模态都挂在 `App.tsx` 的布局之外（第 56-58 行），注释写明理由：**"浮层挂载在布局之外，避免受侧栏/主区的溢出裁剪"**。

### 2.4 已有的同类口径（要跟随，不要另立）

Oint 现有的四个资源面板（技能 / 子智能体 / 魔法提示 / MCP）都用 **「系统 / 用户」两个页签**分组。**插件管理要沿用这一口径**，不要发明第三套分组语言。

---

## 3. 触发按钮的规格

### 3.1 位置

```
┌ 侧栏底部 ─────────────────────────────────┐
│  [⚙ 设置]  …………………………  [🧩 插件] [🌙 主题] │
└───────────────────────────────────────────┘
```

改法：右侧从"单个 `ThemeToggle`"变成"一个 `gap-1` 的组"：

```tsx
{/* 底部：设置（左）+ 插件/主题（右）。插件紧邻主题左侧 —— 两者都是"改这台机器怎么用"的入口 */}
<div className="border-t border-border/60 p-2">
  <div className="flex items-center justify-between">
    <IconButton label={t("sidebar.settings")} onClick={() => openSettings()}>
      <Settings2 className="size-4" />
    </IconButton>
    <div className="flex items-center gap-1">
      <IconButton label={t("plugins.title")} onClick={openPlugins}>
        <Puzzle className="size-4" />
      </IconButton>
      <ThemeToggle side="right" />
    </div>
  </div>
</div>
```

> **一个可选的替代布局**：把插件与设置归到左边一组（`[设置][插件] … [主题]`），语义上"两个管理入口在一起"更整齐。**本计划按需求采用"紧邻主题左侧"**；改成替代布局只需把 `IconButton` 移进左边那个 div，**一行改动**。

### 3.2 图标与文案

| 项 | 值 | 理由 |
| --- | --- | --- |
| 图标 | `Puzzle`（lucide） | 插件/扩展的通用隐喻；`Plug` 已被设置里的 MCP 分栏占用（`SettingsModal.tsx:47`），**不能重复** |
| 无障碍名 | `t("plugins.title")` | 与模态标题同一词条，避免两处措辞漂移 |
| 按钮组件 | 复用 `SidebarShell` 里既有的 `IconButton`（`SidebarShell.tsx:23`，**文件内本地函数**） | 尺寸/颜色/hover 与相邻按钮一致 |
| Tooltip | `side="right"`（与 `ThemeToggle` 一致） | 侧栏在左，提示朝右不会出屏 |

### 3.3 快捷键 `Ctrl/Cmd + Shift + X` —— **要先修一个既有的隐式冲突**

**核对代码时发现的真问题**（`src/renderer/hooks/useGlobalShortcuts.ts:6-8`）：

```ts
function matchesModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;   // ← 没有检查 shiftKey
}
```

**后果**：`Ctrl+Shift+K` 现在**也会触发搜索**（`event.key` 是 `"K"`，`toLowerCase()` 之后命中 `case "k"`），`Ctrl+Shift+N/B/P/T` 同理。今天没人报，是因为**没有任何快捷键依赖 Shift** —— 而一旦新增一个 Shift 组合，这个隐式容忍就变成真冲突。

**改法**（与新增快捷键同一提交）：

```ts
/** 组合键判定：统一要求 Ctrl 或 Cmd，且 shift 必须**精确匹配** */
function matchesModifier(event: KeyboardEvent, options: { shift?: boolean } = {}): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.shiftKey === (options.shift ?? false);
}

// 既有的六个键显式声明 shift: false（行为与今天一致，但把隐式变成显式）
case "k": if (!matchesModifier(event, { shift: false })) break;  // 或把 matchesModifier 提到 switch 前按 key 分派
```

**更省事的等价写法**：把 `matchesModifier` 的调用留在原位（不带 shift 参数即"不要求匹配"会保持旧行为），只在 `case "x"` 分支里额外判 `event.shiftKey`。但**推荐前一种** —— 显式匹配让"Shift 是否参与"成为每个快捷键自己的声明，而不是一个全局的隐含宽容。

**新快捷键**（与 VS Code 的扩展面板同键，肌肉记忆直接可用）：

```ts
case "x":
  if (event.shiftKey) {
    event.preventDefault();
    if (ui.pluginsOpen) ui.closePlugins();
    else ui.openPlugins();
  }
  break;
```

> **一条顺带清理**：`Ctrl/Cmd+Shift+X` 之前没有任何含义，所以不存在兼容问题。而修好 `matchesModifier` 之后，**`Ctrl+Shift+K` 不再误触搜索** —— 这是一个独立的 bug 修复，值得单独一行写进提交信息。

---

## 4. 模态窗的规格

### 4.1 骨架（与 `SettingsModal` 逐项对齐）

```tsx
// src/renderer/features/plugins/PluginsModal.tsx
export function PluginsModal() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.pluginsOpen);
  const section = useUiStore((s) => s.pluginsSection);
  const openPlugins = useUiStore((s) => s.openPlugins);
  const closePlugins = useUiStore((s) => s.closePlugins);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closePlugins()}>
      {/* 与设置模态同尺寸：880×640、xl 圆角、内部自控内边距 */}
      <DialogContent className="flex h-[640px] max-h-[86vh] w-[880px] max-w-[92vw] gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(value) => openPlugins(value as PluginSection)}
          className="flex min-h-0 w-full gap-0"
        >
          {/* 左侧 200px 分类导航：与设置模态同构 */}
          <div className="flex w-[200px] shrink-0 flex-col border-border/60 border-r bg-sidebar p-2">
            <DialogTitle className={cn(typeSection, "px-2.5 pt-1 pb-2")}>{t("plugins.title")}</DialogTitle>
            <DialogDescription className="sr-only">{t("plugins.title")}</DialogDescription>
            <TabsList aria-label={t("plugins.title")} className="w-full flex-col items-stretch justify-start gap-0.5 rounded-none bg-transparent p-0">
              {PLUGIN_SECTIONS.map((item) => (
                <TabsTrigger key={item.id} value={item.id} className={navItem}>
                  <item.Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t(item.labelKey)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="min-w-0 flex-1">
            <ScrollArea className="h-full">
              {PLUGIN_SECTIONS.map((item) => (
                <TabsContent key={item.id} value={item.id} className="p-5">
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  >
                    <SettingsPanelTitle>{t(item.labelKey)}</SettingsPanelTitle>
                    {renderSection(item.id)}
                  </motion.div>
                </TabsContent>
              ))}
            </ScrollArea>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
```

**`navItem` 与 `typeSection` 从哪来**：`navItem` 目前是 `SettingsModal.tsx` 里的模块级常量。**应把它提到 `features/settings/settings-shared.tsx` 并导出**（改名 `modalNavItem`），两个模态共用一份 —— 否则两份样式会各自漂移。

### 4.2 四个分栏

```ts
export type PluginSection = "installed" | "dev" | "sources" | "diagnostics";

export const PLUGIN_SECTIONS = [
  { id: "installed",   labelKey: "plugins.sectionInstalled",   Icon: Package },
  { id: "dev",         labelKey: "plugins.sectionDev",         Icon: Hammer },
  { id: "sources",     labelKey: "plugins.sectionSources",     Icon: Store },
  { id: "diagnostics", labelKey: "plugins.sectionDiagnostics", Icon: Stethoscope },
] as const satisfies readonly { id: PluginSection; labelKey: string; Icon: typeof Package }[];
```

| 分栏 | 内容 | 期 |
| --- | --- | --- |
| **已安装** | 「系统（内置）/ 用户」两页签；每行：名称 + id + 版本 + 启停开关；展开看贡献物、权限、错误；行操作：启用/停用、打开界面、打开数据目录、卸载 | 期 1 |
| **开发** | 开发插件（目录引用，不拷贝）+ 监视状态；「加载开发插件」按钮（选目录）；重载/停止监视 | 期 2 |
| **来源** | 市场源配置（官方 / 备份 / 自定义 URL）+ 缓存年龄 + 刷新；**期 1 显示为"尚未接入"的只读态** | 期 3（P6） |
| **诊断** | 加载错误清单、审计事件（安装/启用/停用/崩溃）、`check` 结果 | 期 2 |

**为什么是这四个**：对齐 `plugin-system-plan.md` 的 P2/P3/P6 分期；而**「系统 / 用户」页签沿用既有四面板的口径**，不发明新语言。

### 4.3 列表行的形状

```
┌────────────────────────────────────────────────────────────────┐
│ 🧩  Git Lens                              com.example.git-lens │
│     v1.0.0 · 贡献 1 个面板                    [开关] [⋯]        │
│     ── 展开 ──────────────────────────────────────────────────  │
│     贡献物  面板 Git · 命令 0 · 技能 0 · MCP 0 · 工具 0          │
│     权限    [🟡 ui.panel] [🟠 shell.exec: git]                  │
│     状态    已加载 · 12ms · 0 次崩溃                             │
│     操作    打开界面 · 打开数据目录 · 重载 · 卸载                │
└────────────────────────────────────────────────────────────────┘
```

三条设计决定：

1. **权限 chip 按风险着色**（低=中性、中=琥珀、高=红），**且文件类权限永远把范围显示在旁边**（`fs.read · workspace/**`）—— 照抄 PI-Desktop 的"文件权限从不单独出现"，也对应本仓库 README 对 `permission-rules` 的既有口径。
2. **升级新增的权限要标出来**（`新` 徽标）。这是"升级不能静默扩权"的界面实现，配合 `plugin-system-plan.md` §4.10 的哈希绑定。
3. **卸载是不可逆的**，收在 `⋯` 菜单里并带二次确认；卸载时问"是否保留插件数据"。

### 4.4 空态

```
        还没有安装任何插件

   插件可以给 Oint 加技能包、面板、工具或独立窗口。

   [ 安装插件包 (.ointplug) ]   [ 加载开发插件 ]
```

**运行时未接入时**（IPC 返回 `UNSUPPORTED` / 无处理器）：空态不变，底部加一行灰字诊断 `插件运行时尚未就绪（IPC plugins:list 未实现）`。**这一条让模态可以先于运行时上线。**

---

## 5. 数据契约

### 5.1 共享契约（新文件 `src/shared/contracts/plugin.ts`）

```ts
/** 插件来源 —— 与既有 SkillSource / SubagentSource 同一条原则：用户只关心"是不是自带的" */
export type PluginSource = "builtin" | "user" | "dev";

export type PluginState =
  | "disabled"          // 已安装、用户关掉了
  | "loading"           // 正在加载
  | "running"           // 已加载
  | "load_error"        // 加载失败（见 error）
  | "invalid"           // 清单/文件校验失败
  | "crashed";          // 运行中崩溃

export interface PluginContributionSummary {
  panels: number; windows: number; commands: number;
  skills: number; prompts: number; subagents: number; mcpServers: number; tools: number;
}

export interface PluginPermissionView {
  id: string;                       // "ui.panel" / "shell.exec" …
  /** 权限的范围（如 fs scope、命令白名单）；没有范围时 undefined */
  scope?: string;
  risk: "low" | "medium" | "high";
}

/** 列表与详情共用的一行 */
export interface PluginView {
  id: string;                       // 反向域名
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  enabled: boolean;
  state: PluginState;
  /** state === "load_error" / "invalid" / "crashed" 时的可读原因 */
  error?: string;
  contributions: PluginContributionSummary;
  permissions: PluginPermissionView[];
  /** 相对"用户已批准的那一份清单"新增的权限（升级时非空） */
  newlyRequested: string[];
  /** 用户能看到的界面（面板 / 窗口），供"打开界面"用 */
  surfaces: { id: string; kind: "panel" | "window"; title: string }[];
  installedAt?: number;
  updatedAt?: number;
}
```

### 5.2 IPC 通道（加到 `shared/contracts/ipc.ts`）

| 通道 | 签名 | 期 |
| --- | --- | --- |
| `plugins:list` | `() => PluginView[]` | **期 1（先返回 `[]`）** |
| `plugins:enable` | `(id: string) => PluginView[]` | 期 2 |
| `plugins:disable` | `(id: string) => PluginView[]` | 期 2 |
| `plugins:reload` | `(id: string) => PluginView[]` | 期 2 |
| `plugins:install` | `() => { canceled: boolean; views: PluginView[]; diagnostics: string[] }` | 期 2 |
| `plugins:uninstall` | `(id: string, keepData: boolean) => PluginView[]` | 期 2 |
| `plugins:loadDev` | `() => { canceled: boolean; views: PluginView[] }` | 期 2 |
| `plugins:openSurface` | `(id: string, surfaceId: string) => void` | 期 2（依赖 S2/S3） |
| `plugins:revealData` | `(id: string) => void` | 期 2 |
| `plugins:diagnostics` | `() => PluginDiagnostic[]` | 期 2 |

**所有变更类通道返回"变更后的完整列表"**，而不是 `void` —— 与 `ipc/mcp.ts` 的既有做法一致（面板不必再拉一次，也不会出现"点了没反应"的中间态）。

### 5.3 渲染层状态（新文件 `src/renderer/stores/plugins-store.ts`）

```ts
interface PluginsState {
  views: PluginView[] | null;      // null = 尚未加载
  /** 运行时未接入时的诊断；非空时列表按空处理并在空态下方显示一行 */
  unavailable: string | null;
  busyId: string | null;           // 正在启停/卸载的那个插件（行内转圈）
  load(): Promise<void>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  install(): Promise<void>;
  uninstall(id: string, keepData: boolean): Promise<void>;
}
```

**`unavailable` 的处理**：`load()` 捕获 IPC 失败，写入 `unavailable` 并把 `views` 置为 `[]`。**不抛到界面**。

### 5.4 `ui-store` 的增量

```ts
pluginsOpen: boolean;
pluginsSection: PluginSection;
openPlugins: (section?: PluginSection) => void;
closePlugins: () => void;
```

**互斥**：`openPlugins()` 内部先 `set({ settingsOpen: false, searchOpen: false, pluginsOpen: true })`；反过来 `openSettings()` / `openSearch()` 也要关掉 `pluginsOpen`。**三个模态互斥是同一条纪律**，写在 `ui-store` 里而不是各组件里。

---

## 6. 文件清单

### 6.1 新增（11 个）

| 文件 | 职责 |
| --- | --- |
| `src/shared/contracts/plugin.ts` | §5.1 的类型 |
| `src/renderer/features/plugins/index.ts` | 只导出 `PluginsModal`（与 `features/settings/index.ts` 同构） |
| `src/renderer/features/plugins/PluginsModal.tsx` | §4.1 的骨架 + `renderSection` 分发 |
| `src/renderer/features/plugins/panels/InstalledPanel.tsx` | 列表 + 系统/用户页签 + 空态 |
| `src/renderer/features/plugins/panels/DevPanel.tsx` | 开发插件 |
| `src/renderer/features/plugins/panels/SourcesPanel.tsx` | 市场源（期 1 只读占位） |
| `src/renderer/features/plugins/panels/DiagnosticsPanel.tsx` | 诊断 |
| `src/renderer/features/plugins/PluginRow.tsx` | §4.3 的行 |
| `src/renderer/features/plugins/plugin-permissions.ts` | **纯函数**：权限 → 风险档 / 文案 key / 范围展示串 |
| `src/renderer/stores/plugins-store.ts` | §5.3 |
| `src/main/ipc/plugins.ts` | IPC 处理器（期 1 只有 `plugins:list` 返回 `[]`） |

### 6.2 改动（8 个）

| 文件 | 改动 |
| --- | --- |
| `src/renderer/stores/ui-store.ts` | `PluginSection` + `PLUGIN_SECTIONS` + 四个方法与字段；**三模态互斥** |
| `src/renderer/app/SidebarShell.tsx` | §3.1 的按钮（+ `Puzzle` import） |
| `src/renderer/app/App.tsx` | 挂 `<PluginsModal />`（与 `SettingsModal` 并列，布局之外） |
| `src/renderer/features/settings/settings-shared.tsx` | **导出 `modalNavItem`**（从 `SettingsModal` 提上来） |
| `src/renderer/features/settings/SettingsModal.tsx` | 改用导出的 `modalNavItem` |
| `src/renderer/hooks/useGlobalShortcuts.ts` | `Ctrl/Cmd+Shift+X` **+ 修 `matchesModifier` 不检查 Shift 的隐式冲突**（§3.3） |
| `src/main/ipc/registry.ts` | `registerPluginsIpc()` |
| `src/shared/contracts/ipc.ts` · `api.ts` · `src/preload/index.ts` | 通道常量与桥（三处同改，`shared/contracts/api.ts` 是形状的唯一真相） |
| `src/shared/i18n/locales/zh-CN.ts` · `en-US.ts` | §6.3 的词条 |

### 6.3 i18n 词条（新增 `plugins.*` 命名空间）

```
plugins.title                插件
plugins.sectionInstalled     已安装
plugins.sectionDev           开发
plugins.sectionSources       来源
plugins.sectionDiagnostics   诊断
plugins.tabSystem            系统
plugins.tabUser              用户
plugins.empty                还没有安装任何插件
plugins.emptyHint            插件可以给 Oint 加技能包、面板、工具或独立窗口。
plugins.installPackage       安装插件包
plugins.loadDev              加载开发插件
plugins.unavailable          插件运行时尚未就绪
plugins.enable / disable / reload / uninstall / openSurface / revealData
plugins.contributions        贡献物
plugins.permissions          权限
plugins.status               状态
plugins.newPermission        新
plugins.keepData             保留插件数据
plugins.state.disabled / loading / running / loadError / invalid / crashed
plugins.contrib.panels / windows / commands / skills / prompts / subagents / mcpServers / tools
plugins.perm.<permissionId>  每个权限一句人话解释（先做 ui.panel / ui.window / shell.exec / fs.read / fs.write / net.fetch / mcp.server.local 七条）
```

> **必须遵守的两条既有门禁**：
> 1. `en-US.ts` 用 `satisfies Messages` 做类型闭合 —— **漏译 = 编译错误**；
> 2. `scripts/check-i18n.mjs` 抓**编译期字面量键** —— `labelKey` 直接写字符串，**不要拼**（`t(\`plugins.${x}\`)` 会被漏检，`SearchModal` 那处历史包袱就是这么来的）。
> 3. **权限的解释文案不能从插件传进来**（插件传 i18n key 会原样显示键名）。宿主维护一份 `permissionId → 文案 key` 表；**表外的权限显示 id 原文 + "未知权限"**，而不是空白。

### 6.4 测试

| 层 | 内容 |
| --- | --- |
| `vitest --project node` | `plugin-permissions.ts` 的分档与范围投影（表驱动）；IPC 处理器在无插件时返回 `[]` |
| `vitest --project ui` | `PluginsModal` 在 `views: []` 下渲染空态；`views: null` + `unavailable` 下渲染空态 + 诊断行；`PluginRow` 展开显示贡献物与权限；风险着色按档位正确 |
| 冒烟 | 期 2 起并入 `scripts/probe-plugins.mjs`：用独立 `OINT_HOME` 打开模态、断言空态、装一个技能包、断言行出现 |

---

## 7. 与插件运行时的接缝

**这个模态是宿主 UI，不是插件贡献物。** 三条边界：

1. **它不进入 `panelRegistry`** —— 它是模态，不是右侧面板视图。`plugin-system-plan.md` §4.7 的注册表化管的是**右侧面板 / 设置分栏 / 工具渲染器 / 命令 / 快捷键 / 斜杠命令**六处，模态不在其中。
2. **插件不能往里加页签** —— 「来源」分栏是宿主给市场源用的，不是插件的扩展点。插件的 UI 出口只有 `panel` 与 `window` 两种形态（`plugin-ui-surfaces-implementation.md` §2）。
3. **模态里的"打开界面"要打到运行时** —— 面板类表面让 `ui-store` 切到右侧面板并选中该视图；窗口类表面走 `IPC.plugins.openSurface` → `surface-manager`（S2）。**期 1 该按钮置灰并提示"运行时未就绪"。**

**依赖顺序**：

```
本计划（期 1）  ← 不依赖任何插件运行时，可立即做
   │
   ├─→ plugin-system-plan.md  P2（清单 + 宿主骨架）  → 期 1 的列表开始有数据
   ├─→ plugin-ui-surfaces-implementation.md  S2（独立窗口）→ "打开界面"对 window 生效
   └─→ plugin-ui-surfaces-implementation.md  S3（面板槽）  → "打开界面"对 panel 生效
```

**为什么先做 UI**：它把"插件系统"从一个抽象概念变成一个**能被看见、被点击、被验收**的东西；而且它的数据契约（§5.1）一旦定下来，后端实现就有了明确的目标形状 —— 这正是 `resources.ts` 那条"面板看到的与运行时注入的必须同源"的既有原则。

---

## 8. 分期与工期

| 期 | 内容 | 工期 | 交付 |
| --- | --- | --- | --- |
| **期 1 · 骨架** | 触发按钮 + 模态骨架 + 四个分栏的壳 + 空态 + `plugins:list` 返回 `[]` + i18n + 测试 | **2 天** | 按钮能点开一个与设置同尺寸的模态，显示空态 |
| **期 2 · 列表与操作** | 接真实数据、行展开、权限 chip、启停/卸载/安装/开发插件、诊断分栏 | 2.5 天 | 能装、能停、能卸，且每次操作后列表就地刷新 |
| **期 3 · 来源与市场** | 来源分栏接 catalog、检查更新、权限升级提示 | 2 天（依赖 P6） | 能从市场装 |

**期 1 可以立刻开始，且不阻塞任何其他工作。**

---

## 9. 非目标

| 不做 | 理由 |
| --- | --- |
| 插件往模态里加页签 | 插件的 UI 出口只有 `panel` / `window`（§7 第 2 条） |
| 把技能 / MCP / 子智能体搬进这个模态 | 沿用既有四面板的口径（§2.4）；`plugin-system-plan.md` §4.8 已定这条边界 |
| 在模态里内嵌文档 / README 渲染器 | 期 2 可以先只显示 `description`；README 渲染要引入 Markdown 管线，是独立的一件事 |
| 数值化的"安全评分" | PI-Desktop 实测 31 个插件**零数值评分**，只有分档的 `review.risk`。**分档 + 权限 + 范围**已经够用，评分会造出虚假的精确感 |
| 插件自带图标文件 | 用封闭的 `IconToken` 集（`plugin-ui-surfaces-implementation.md` §10） |
