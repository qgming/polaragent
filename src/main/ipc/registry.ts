import { registerAgentsIpc } from "./agents";
import { registerAppIpc } from "./app";
import { registerApprovalsIpc } from "./approvals";
import { registerChatIpc } from "./chat";
import { registerDialogIpc } from "./dialog";
import { registerModelsCatalogIpc } from "./models-catalog";
import { registerPermissionsIpc } from "./permissions";
import { registerProjectsIpc } from "./projects";
import { registerPromptsIpc } from "./prompts";
import { registerServicesIpc } from "./services";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";
import { registerSkillsIpc } from "./skills";
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
  registerSkillsIpc();
  registerPromptsIpc();
  registerPermissionsIpc();
  registerAgentsIpc();
  registerDialogIpc();
  registerServicesIpc();
  registerModelsCatalogIpc();
}
