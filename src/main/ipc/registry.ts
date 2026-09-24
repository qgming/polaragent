import { registerAgentsIpc } from "./agents";
import { registerAppIpc } from "./app";
import { registerApprovalsIpc } from "./approvals";
import { registerBrowserIpc } from "./browser";
import { registerChatIpc } from "./chat";
import { registerDialogIpc } from "./dialog";
import { registerFilesIpc } from "./files";
import { registerInteractionsIpc } from "./interactions";
import { registerJobsIpc } from "./jobs";
import { registerMcpIpc } from "./mcp";
import { registerModelsCatalogIpc } from "./models-catalog";
import { registerPermissionsIpc } from "./permissions";
import { registerPluginsIpc } from "./plugins";
import { registerProjectsIpc } from "./projects";
import { registerPromptsIpc } from "./prompts";
import { registerReviewIpc } from "./review";
import { registerServicesIpc } from "./services";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";
import { registerSkillsIpc } from "./skills";
import { registerSubagentsIpc } from "./subagents";
import { registerSurfaceIpc } from "./surface";
import { registerTerminalIpc } from "./terminal";
import { registerWebIpc } from "./web";
import { registerWindowIpc } from "./window";

/**
 * 汇总注册全部 invoke 处理器，避免分散注册导致通道遗漏或重复。
 *
 * `appPath` 由调用方注入（`app.getAppPath()`）：内置插件住在
 * `<appPath>/resources/plugins`，而 ipc/plugins.ts **刻意不 import electron**
 * —— 单测要能在 node 环境里跑。与 resources.ts / kernel-deps.ts 同一手法。
 */
export function registerIpcHandlers(options: { appPath?: string } = {}): void {
  registerAppIpc();
  registerWindowIpc();
  registerSettingsIpc();
  registerSessionsIpc();
  registerProjectsIpc();
  registerChatIpc();
  registerApprovalsIpc();
  registerInteractionsIpc();
  registerJobsIpc();
  registerSkillsIpc();
  registerSubagentsIpc();
  registerPromptsIpc();
  registerPermissionsIpc();
  registerAgentsIpc();
  registerDialogIpc();
  registerServicesIpc();
  registerMcpIpc();
  registerModelsCatalogIpc();
  registerFilesIpc();
  registerReviewIpc();
  registerTerminalIpc();
  registerBrowserIpc();
  registerWebIpc();
  registerPluginsIpc(options);
  // 插件界面桥：**面向第三方页面**的那一组通道，每个处理器都先查身份
  registerSurfaceIpc();
}
