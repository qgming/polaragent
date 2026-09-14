// 内置浏览器的 IPC 域：给渲染层的面板一个「读状态」的入口 + 事件推送出口。
//
// 刻意**只有读**：页面的驱动（导航 / 点击 / 读 DOM / 截图）全部走主进程持有的
// guest WebContents（见 browser/service.ts），不经过渲染层 —— 那是本次实现的核心决定，
// 理由写在该文件顶部。所以这里没有 navigate / click 之类的通道，也不该有。
//
// 渲染层的面板需要的只有两件事：
//   1. 挂载后拿一次当前状态（面板重挂载时地址栏要立刻显示模型打开的那个页面）；
//   2. 订阅事件：页面状态变化、以及「模型想用浏览器，请你打开面板」的请求。

import type { BrowserStatus } from "@/shared/contracts/browser";
import { IPC } from "@/shared/contracts/ipc";
import { getBrowserAutomation, initBrowserEvents } from "../browser/service";
import { handle } from "./handler";

export function registerBrowserIpc(): void {
  // 事件出口在注册时绑定：此时 app 已就绪，窗口广播可用（与 terminal 服务同一套）
  initBrowserEvents();

  handle(
    IPC.browser.status,
    "读取内置浏览器状态",
    (): BrowserStatus => getBrowserAutomation().status(),
  );
}
