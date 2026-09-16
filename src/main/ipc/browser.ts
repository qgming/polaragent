// 内置浏览器的 IPC 域：状态读取 + 标签登记 + 事件推送出口。
//
// 页面的驱动（导航 / 点击 / 读 DOM / 截图）全部走主进程持有的 guest WebContents
//（见 browser/service.ts），不经过渲染层 —— 那是本次实现的核心决定，理由写在该文件顶部。
// 所以这里没有 navigate / click 之类的通道，也不该有。
//
// 渲染层面板需要的是三件事：
//   1. 挂载后拿一次当前状态（打开了哪些标签、模型是否在操作）；
//   2. 把新建的 webview guest **登记**回来（tabId 由渲染层分配，只有它知道是哪一个）；
//   3. 订阅事件：状态变化、「模型想用浏览器，请开/切标签」、以及「模型在操作」的提示。

import type { BrowserStatus } from "@/shared/contracts/browser";
import { IPC } from "@/shared/contracts/ipc";
import {
  activateBrowserTab,
  getBrowserAutomation,
  initBrowserEvents,
  registerBrowserTab,
  unregisterBrowserTab,
} from "../browser/service";
import { handle } from "./handler";

export function registerBrowserIpc(): void {
  // 事件出口在注册时绑定：此时 app 已就绪，窗口广播可用（与 terminal 服务同一套）
  initBrowserEvents();

  handle(
    IPC.browser.status,
    "读取内置浏览器状态",
    (): BrowserStatus => getBrowserAutomation().status(),
  );
  handle(
    IPC.browser.registerTab,
    "登记浏览器标签",
    (request: { tabId: string; webContentsId: number; requestId?: string }): void => {
      registerBrowserTab(request.tabId, request.webContentsId, request.requestId);
    },
  );
  handle(IPC.browser.unregisterTab, "注销浏览器标签", (request: { tabId: string }): void => {
    unregisterBrowserTab(request.tabId);
  });
  handle(IPC.browser.activateTab, "激活浏览器标签", (request: { tabId: string }): void => {
    activateBrowserTab(request.tabId);
  });
}
