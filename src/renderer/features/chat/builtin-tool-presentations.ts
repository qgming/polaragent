// 内置工具的展示注册（27 项）。
//
// 与 builtin-panels.tsx / builtin-sections.tsx 同构：**只有副作用**，依赖是一条直线
// （tool-presentations.ts → 本文件 → tool-presentation-registry.ts）。
//
// 这张表由原来的 TOOL_ICONS 与 TOOL_LABELS **两张**合并而成 —— 它们的键集合逐字相同，
// 各写一份时加一个工具要改两处。图标与文案现在住在同一条描述子里，
// 于是"图标登记了、文案忘了"这种半成品状态在结构上不可能出现。
//
// ## ⚠️ 为什么是 27 个对象字面量，而不是一张 `[名字, 图标, 键, 键]` 的数组
//
// 因为 **scripts/check-i18n.mjs 按 `resting:` / `active:` 字段抓键**（见它源码的
// KEY_FIELD_RE）。写成数组元组的话，那两个键就变成了裸字符串 —— 前面没有字段名，
// 正则匹配不到，**这 54 个词条键会整体从门禁里消失**。
//
// 这不是推测：本文件的第一版就是数组形态，写完立刻意识到键会丢，才改成现在这样。
// 冗长是这份约束的代价，换的是"打错一个键名会让 check:i18n 变红"。

import {
  BellRingIcon,
  Bot,
  CameraIcon,
  CloudDownloadIcon,
  CodeIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  ListIcon,
  ListTodoIcon,
  MessageCircleQuestion,
  MousePointerClickIcon,
  NetworkIcon,
  PenLineIcon,
  RocketIcon,
  ScanEyeIcon,
  ScrollTextIcon,
  SearchIcon,
  SquareIcon,
  SquarePenIcon,
  TerminalIcon,
  TextSearchIcon,
  TimerIcon,
} from "lucide-react";
import { registerToolPresentation } from "./tool-presentation-registry";

// ── pi 内核四件套 ──────────────────────────────────────────────────────────
registerToolPresentation({
  name: "bash",
  Icon: TerminalIcon,
  resting: "tools.bash",
  active: "tools.bashActive",
});
registerToolPresentation({
  name: "read",
  Icon: FileTextIcon,
  resting: "tools.read",
  active: "tools.readActive",
});
registerToolPresentation({
  name: "write",
  Icon: SquarePenIcon,
  resting: "tools.write",
  active: "tools.writeActive",
});
registerToolPresentation({
  name: "edit",
  Icon: PenLineIcon,
  resting: "tools.edit",
  active: "tools.editActive",
});

// ── 自建检索与待办 ─────────────────────────────────────────────────────────
registerToolPresentation({
  name: "grep",
  Icon: TextSearchIcon,
  resting: "tools.grep",
  active: "tools.grepActive",
});
registerToolPresentation({
  name: "glob",
  Icon: FileSearchIcon,
  resting: "tools.glob",
  active: "tools.globActive",
});
registerToolPresentation({
  name: "todo",
  Icon: ListTodoIcon,
  resting: "tools.todo",
  active: "tools.todoActive",
});

// ── 提问 ───────────────────────────────────────────────────────────────────
registerToolPresentation({
  name: "ask_user",
  Icon: MessageCircleQuestion,
  resting: "tools.askUser",
  active: "tools.askUserActive",
});

/*
  读图片：ImageIcon（与浏览器截图那个 CameraIcon 分开 —— 一个是「读一张已有的图」，
  一个是「现拍一张」）
*/
registerToolPresentation({
  name: "read_image",
  Icon: ImageIcon,
  resting: "tools.readImage",
  active: "tools.readImageActive",
});

// ── 后台作业四件套：起进程 / 读输出 / 列清单 / 停掉 ────────────────────────
registerToolPresentation({
  name: "bash_background",
  Icon: RocketIcon,
  resting: "tools.bashBackground",
  active: "tools.bashBackgroundActive",
});
registerToolPresentation({
  name: "job_output",
  Icon: ScrollTextIcon,
  resting: "tools.jobOutput",
  active: "tools.jobOutputActive",
});
registerToolPresentation({
  name: "job_list",
  Icon: ListIcon,
  resting: "tools.jobList",
  active: "tools.jobListActive",
});
registerToolPresentation({
  name: "job_kill",
  Icon: SquareIcon,
  resting: "tools.jobKill",
  active: "tools.jobKillActive",
});

/*
  浏览器九件套：打开 / 历史 / 读页面 / 动作（点击·输入·按键·悬停·下拉·滚动）/
  等待 / 截图 / 日志（控制台·网络）/ 弹窗策略 / 执行脚本
*/
registerToolPresentation({
  name: "browser_open",
  Icon: GlobeIcon,
  resting: "tools.browserOpen",
  active: "tools.browserOpenActive",
});
registerToolPresentation({
  name: "browser_history",
  Icon: HistoryIcon,
  resting: "tools.browserHistory",
  active: "tools.browserHistoryActive",
});
registerToolPresentation({
  name: "browser_snapshot",
  Icon: ScanEyeIcon,
  resting: "tools.browserSnapshot",
  active: "tools.browserSnapshotActive",
});
registerToolPresentation({
  name: "browser_act",
  Icon: MousePointerClickIcon,
  resting: "tools.browserAction",
  active: "tools.browserActionActive",
});
registerToolPresentation({
  name: "browser_wait",
  Icon: TimerIcon,
  resting: "tools.browserWait",
  active: "tools.browserWaitActive",
});
registerToolPresentation({
  name: "browser_screenshot",
  Icon: CameraIcon,
  resting: "tools.browserScreenshot",
  active: "tools.browserScreenshotActive",
});
registerToolPresentation({
  name: "browser_logs",
  Icon: ScrollTextIcon,
  resting: "tools.browserLogs",
  active: "tools.browserLogsActive",
});
registerToolPresentation({
  name: "browser_dialog",
  Icon: BellRingIcon,
  resting: "tools.browserDialog",
  active: "tools.browserDialogActive",
});
registerToolPresentation({
  name: "browser_evaluate",
  Icon: CodeIcon,
  resting: "tools.browserEvaluate",
  active: "tools.browserEvaluateActive",
});

// ── 网络工具：检索（SearchIcon）/ 抓取（CloudDownloadIcon）────────────────
registerToolPresentation({
  name: "web_search",
  Icon: SearchIcon,
  resting: "tools.webSearch",
  active: "tools.webSearchActive",
});
registerToolPresentation({
  name: "web_fetch",
  Icon: CloudDownloadIcon,
  resting: "tools.webFetch",
  active: "tools.webFetchActive",
});

// ── 子智能体四件套（与主进程 tools.ts 的 Task 系列一一对应）───────────────
registerToolPresentation({
  name: "Task",
  Icon: Bot,
  resting: "tools.task",
  active: "tools.taskActive",
});
registerToolPresentation({
  name: "TaskWait",
  Icon: NetworkIcon,
  resting: "tools.taskWait",
  active: "tools.taskWaitActive",
});
registerToolPresentation({
  name: "TaskList",
  Icon: ListIcon,
  resting: "tools.taskList",
  active: "tools.taskListActive",
});
registerToolPresentation({
  name: "TaskStop",
  Icon: SquareIcon,
  resting: "tools.taskStop",
  active: "tools.taskStopActive",
});
