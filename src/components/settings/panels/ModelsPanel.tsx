// 模型服务：模型路由
// src/components/settings/panels/ModelsPanel.tsx

import type { Settings, ProviderConfig } from "@/types/config";
import { ModelPanel } from "../ModelPanel";
import { SectionHeader } from "./GeneralPanel";

export function ModelsPanel({
  providers,
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
  return (
    <div className="space-y-8">
      <SectionHeader title="模型" />
      <ModelPanel
        providers={providers}
        onAddProvider={onAddProvider}
        onUpdateProvider={onUpdateProvider}
        onRemoveProvider={onRemoveProvider}
        onSetDefaultModel={onSetDefaultModel}
        embedded
      />
    </div>
  );
}
