// 内置十个设置分栏的注册。
//
// 与 builtin-panels.tsx 同构：**只有副作用**，依赖是一条直线
// （sections.ts → 本文件 → settings-registry.ts）。
//
// 注册顺序 = 左导航顺序 = 搜索里「设置」结果的顺序。与过去的 SETTINGS_SECTIONS
// 逐项一致（general → services → web → mcp → skills → subagents → promptTemplates
// → personalization → data → about）。

import {
  Bot,
  Database,
  FileText,
  Globe,
  Info,
  Plug,
  Server,
  Settings2,
  Sparkles,
  SquareSlash,
} from "lucide-react";
import { AboutPanel } from "./panels/AboutPanel";
import { DataPanel } from "./panels/DataPanel";
import { GeneralPanel } from "./panels/GeneralPanel";
import { McpPanel } from "./panels/McpPanel";
import { PersonalizationPanel } from "./panels/PersonalizationPanel";
import { PromptsPanel } from "./panels/PromptsPanel";
import { ServicesPanel } from "./panels/ServicesPanel";
import { SkillsPanel } from "./panels/SkillsPanel";
import { SubagentsPanel } from "./panels/SubagentsPanel";
import { WebPanel } from "./panels/WebPanel";
import { registerSettingsSection } from "./settings-registry";

// 图标语义取自 Elements 的 settings 面
registerSettingsSection({
  id: "general",
  labelKey: "settings.general",
  Icon: Settings2,
  content: GeneralPanel,
});
registerSettingsSection({
  id: "services",
  labelKey: "settings.services",
  Icon: Server,
  content: ServicesPanel,
});
// 网络搜索紧挨模型服务：两者都是「外部服务配置」，放在一起符合直觉
registerSettingsSection({ id: "web", labelKey: "settings.web", Icon: Globe, content: WebPanel });
registerSettingsSection({ id: "mcp", labelKey: "settings.mcp", Icon: Plug, content: McpPanel });
registerSettingsSection({
  id: "skills",
  labelKey: "settings.skills",
  Icon: Sparkles,
  content: SkillsPanel,
});
registerSettingsSection({
  id: "subagents",
  labelKey: "settings.subagents",
  Icon: Bot,
  content: SubagentsPanel,
});
registerSettingsSection({
  id: "promptTemplates",
  labelKey: "settings.promptTemplates",
  Icon: SquareSlash,
  content: PromptsPanel,
});
registerSettingsSection({
  id: "personalization",
  labelKey: "settings.personalization",
  Icon: FileText,
  content: PersonalizationPanel,
});
registerSettingsSection({
  id: "data",
  labelKey: "settings.data",
  Icon: Database,
  content: DataPanel,
});
registerSettingsSection({
  id: "about",
  labelKey: "settings.about",
  Icon: Info,
  content: AboutPanel,
});
