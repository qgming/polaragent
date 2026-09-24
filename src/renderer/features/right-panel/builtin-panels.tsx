// 内置六个右侧面板的注册。
//
// 这个文件**只有副作用**：它在模块加载时把六个描述子登记进 panel-registry。
// 之所以能这么写而不成环，是因为依赖是一条直线：
//
//     panels.ts（唯一入口） → 本文件 → panel-registry.ts
//
// 谁都不该绕过 `panels.ts` 直接 import 本文件或 panel-registry.ts ——
// 那样拿到的是一个空注册表（详见 panel-registry.ts 的文件头）。
//
// ## 注册顺序就是显示顺序
//
// 与过去 `RIGHT_PANEL_VIEWS` 的顺序逐项一致（review → files → file → subagent →
// browser → terminal）。**`file` 排第三但它 `chooseable: false`** —— 顺序仍然有意义，
// 因为标签条上的图标/名字也走这张表。

import { Bot, Braces, FileText, Globe, SquareTerminal } from "lucide-react";
import { BrowserPanel } from "./BrowserPanel";
import { FilesPanel } from "./FilesPanel";
import { FileViewPanel } from "./FileViewPanel";
import { registerPanel } from "./panel-registry";
import { ReviewPanel } from "./ReviewPanel";
import { SubagentPanel } from "./SubagentPanel";
import { TerminalPanel } from "./TerminalPanel";

/*
  六项一次性注册。重复导入不会重复执行（ESM 模块体只跑一次），
  所以这里不需要幂等判断 —— registerPanel 的重复注册抛错也就不会误伤自己。
*/
registerPanel({
  view: "review",
  // 审查：diff 语义。用 Braces 而不是 FileDiff —— lucide 没有 FileDiff，
  // 而 Braces 与「代码改动」的关联比一个通用文件图标更直接
  labelKey: "rightPanel.review",
  Icon: Braces,
  chooseable: true,
  content: ReviewPanel,
});

registerPanel({
  view: "files",
  // 文件：Ctrl+P，与主流编辑器/IDE 的「快速打开文件」同键，肌肉记忆直接可用
  labelKey: "rightPanel.files",
  Icon: FileText,
  shortcut: "P",
  chooseable: true,
  content: FilesPanel,
});

registerPanel({
  view: "file",
  /*
    单文件查看器的标签名会被文件名覆盖（见 openFilePanel），
    这个 labelKey 只在还没打开任何文件时兜底。

    **`chooseable: false`**：它不是用户从列表里挑出来的「视图」，而是点某张文件卡片
    的结果。放进列表会让「文件」与「文件查看器」两个入口指向同一件事，
    用户得先猜该点哪个。
  */
  labelKey: "rightPanel.file",
  Icon: FileText,
  chooseable: false,
  content: FileViewPanel,
});

registerPanel({
  view: "subagent",
  // 子智能体：Bot 而不是 Network —— 一次委派的详情是「某个代理在干活」，
  // 而 Network 在浏览器工具卡里已经表示「网络请求」，同屏可能出现两处，图标要能分得开
  labelKey: "rightPanel.subagent",
  Icon: Bot,
  chooseable: true,
  content: SubagentPanel,
});

registerPanel({
  view: "browser",
  // 浏览器：Ctrl+T，与「新建标签页」同键
  labelKey: "rightPanel.browser",
  Icon: Globe,
  shortcut: "T",
  chooseable: true,
  /*
    唯一的常驻面板：所有浏览器标签都渲染（各自一个宿主 div），只有当前标签可见。
    这是「页面状态活过切换」的实现处 —— display:none 不销毁 guest，
    切回来时页面、滚动位置、表单草稿都还在。
  */
  resident: true,
  content: BrowserPanel,
});

registerPanel({
  view: "terminal",
  labelKey: "rightPanel.terminal",
  Icon: SquareTerminal,
  chooseable: true,
  content: TerminalPanel,
});
