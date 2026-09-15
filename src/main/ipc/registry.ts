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
import { registerProjectsIpc } from "./projects";
import { registerPromptsIpc } from "./prompts";
import { registerReviewIpc } from "./review";
import { registerServicesIpc } from "./services";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";
import { registerSkillsIpc } from "./skills";
import { registerSubagentsIpc } from "./subagents";
import { registerTerminalIpc } from "./terminal";
import { registerWindowIpc } from "./window";

/** 汇总注册全部 invoke 处理器，避免分散注册导致通道遗漏或重复 */
export function registerIpcHandlers(): void {
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
}
