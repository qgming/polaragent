// 权限的风险分档。
//
// **档位由主进程给**（见 shared/contracts/plugin.ts 的口径）：判据是宿主的能力面，
// 不是界面偏好。放在渲染层会让"同一个权限在两处显示成不同颜色"成为可能。
//
// ## 为什么用 `Record<PluginPermission, …>` 而不是一张宽松的 Map
//
// 因为**这样加权限时漏了分档会直接编译失败**。用 `Record<string, …>` 的话，
// 新权限会静默走到兜底分支 —— 而兜底是 `high`，于是"我明明给了它 low"这种
// 困惑要等到看见界面上一个红色的 chip 才会出现。类型能挡住的事不要留给运行时。
//
// 三档的界线（与 docs/plugin-system-plan.md §4.5 逐条对应）：
//
//  - **low**：不触碰用户数据，也不改变任何持久状态。装一个只读面板不该让用户
//    面对一张权限弹窗 —— 弹窗的代价是"用户会开始无脑点同意"。
//  - **medium**：读取用户数据，或者写入的是"低价值 / 可恢复"的东西。
//  - **high**：写/删用户的文件、跑命令、出站、给模型加能力。这些每一条都能
//    造成不可逆的后果。

import type { PluginPermission, PluginPermissionView } from "@/shared/contracts/plugin";

/** 风险档位（与契约里 PluginPermissionView.risk 同一份） */
export type PluginRisk = PluginPermissionView["risk"];

/**
 * 每一项权限的档位。
 *
 * **这个表必须覆盖 PLUGIN_PERMISSIONS 的每一项** —— 漏了会编译失败，
 * 这是刻意的（见文件头）。
 */
const RISK: Record<PluginPermission, PluginRisk> = {
  // ── 界面：画东西给人看，不碰数据 ────────────────────────────────────────
  "ui.panel": "low",
  "ui.view": "low",
  "ui.window": "low",
  /*
    模态窗与面板同一档：它同样是宿主渲染的一个容器，插件能做的仍然只有
    "画它自己的页面 + 走桥上的那些方法"。**模态窗不是特权** —— 它不遮挡
    审批卡（审批卡在另一层），也不改变任何权限面的判定。
  */
  "ui.modal": "low",
  "ui.theme": "low",
  notify: "low",
  /** 插件私有 KV：写的是它自己的命名空间，用户数据碰不到 */
  storage: "low",

  // ── 贡献物 ──────────────────────────────────────────────────────────────
  /*
    技能与提示是**模型会读到的文本**，所以它们不是"纯数据"——
    但它们是声明式的、可见的（在插件详情里列得出来），且不引入新的能力面。
    真正的风险在于"注入系统提示"这件事本身，而那由宿主装配、不经过插件代码。
  */
  "skills.contribute": "low",
  "prompts.contribute": "low",
  /** 子智能体定义会让主代理派生子会话，比前两者重一档 */
  "subagents.contribute": "medium",
  /** 注册命令：用户会点到它，而它背后是插件代码 */
  "commands.register": "high",
  /** **给模型加工具**是这一档里最重的：模型会自主调用它 */
  "agent.tool.register": "high",

  // ── 文件 ────────────────────────────────────────────────────────────────
  /*
    读是 medium 而不是 low：读到的字节可以经 net.fetch 出去（那是另一半）。
    写与删是 high，而且校验器额外禁止它们声明整树范围 —— 见 manifest.ts 的说明。
  */
  "fs.read": "medium",
  "fs.write": "high",
  "fs.delete": "high",

  // ── 进程与出站 ──────────────────────────────────────────────────────────
  /** 跑命令：与外层权限门判 bash 为 high 是同一条口径 */
  "shell.exec": "high",
  /** 用系统默认程序打开链接：会脱离应用边界，但只限 http/https/mailto */
  "shell.openExternal": "medium",
  "net.fetch": "high",

  // ── MCP ─────────────────────────────────────────────────────────────────
  /** 起一个本地进程（用户机器上的任意代码） */
  "mcp.server.local": "high",
  /** 连一个远端端点：会把请求与上下文带到外面 */
  "mcp.server.remote": "medium",

  // ── 介入 ────────────────────────────────────────────────────────────────
  /** 介入工具调用：能改变模型看到什么，但宿主钩子只允许 block、不允许改写 */
  "hostHooks.register": "high",
  "clipboard.write": "medium",
  /** 只读当前会话（in-flight 的那一次工具调用），不传 session id —— 范围由宿主给 */
  "session.read": "medium",
};

/**
 * 判一项权限的档位。
 *
 * 表外的值兜底成 `high`：调用方可能拿到一份**旧版本**的清单（插件声明了宿主还没
 * 实现的权限，或者宿主删掉了某个权限）。unknown 按最高档处理是唯一安全的方向 ——
 * 反过来（兜底成 low）会让一个未知能力悄悄免掉审批。
 */
export function assessPermissionRisk(id: string): PluginRisk {
  return (RISK as Readonly<Record<string, PluginRisk | undefined>>)[id] ?? "high";
}

/** 全部权限的档位（诊断与测试用） */
export function permissionRiskTable(): Readonly<Record<string, PluginRisk>> {
  return RISK;
}
