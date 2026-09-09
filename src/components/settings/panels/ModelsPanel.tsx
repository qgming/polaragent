// 模型服务：模型路由 + 图片生成 + 音频 + 知识库嵌入
// src/components/settings/panels/ModelsPanel.tsx

import { useTranslation } from "react-i18next";
import type { Settings, ProviderConfig } from "@/types/config";
import { ModelPanel } from "../ModelPanel";
import { ImageGenerationPanel } from "../ImageGenerationPanel";
import { AudioPanel } from "../AudioPanel";
import { KnowledgePanel } from "../KnowledgePanel";
import { SectionHeader } from "./GeneralPanel";

export function ModelsPanel({
  providers,
  settings,
  onUpdate,
  onAddProvider,
  onUpdateProvider,
  onRemoveProvider,
  onSetDefaultModel,
}: {
  providers: { providers: ProviderConfig[]; defaultProvider: string; defaultModel: string };
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
  onAddProvider: (provider: ProviderConfig) => Promise<void>;
  onUpdateProvider: (id: string, updates: Partial<ProviderConfig>) => Promise<void>;
  onRemoveProvider: (id: string) => Promise<void>;
  onSetDefaultModel: (providerId: string, modelId: string) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-8">
      <SectionHeader title={t("nav.models")} />
      <ModelPanel
        providers={providers}
        onAddProvider={onAddProvider}
        onUpdateProvider={onUpdateProvider}
        onRemoveProvider={onRemoveProvider}
        onSetDefaultModel={onSetDefaultModel}
        embedded
      />
      <ImageGenerationPanel settings={settings} onUpdate={onUpdate} embedded />
      <AudioPanel settings={settings} onUpdate={onUpdate} embedded />
      <KnowledgePanel settings={settings} onUpdate={onUpdate} embedded />
    </div>
  );
}
