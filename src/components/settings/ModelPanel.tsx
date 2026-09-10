// 模型设置面板（多模型服务 + 默认路由模型）
// src/components/settings/ModelPanel.tsx
//
// 模型服务卡片与「添加模型服务」弹窗拆分至 model/ 子目录。

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { ProviderConfig, ProvidersConfig } from "@/types/config";
import { PageTitle, SettingDropdown } from "./settings-shared";
import { ProviderCard } from "./model/ProviderCard";
import { AddProviderDialog } from "./model/AddProviderDialog";

export function ModelPanel({
  providers,
  onAddProvider,
  onUpdateProvider,
  onRemoveProvider,
  onSetDefaultModel,
  embedded,
}: {
  providers: ProvidersConfig;
  onAddProvider: (provider: ProviderConfig) => Promise<void>;
  onUpdateProvider: (
    id: string,
    updates: Partial<ProviderConfig>,
  ) => Promise<void>;
  onRemoveProvider: (id: string) => Promise<void>;
  onSetDefaultModel: (providerId: string, modelId: string) => Promise<void>;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  return (
    <section>
      {!embedded ? (
        <PageTitle title="模型" description="配置模型服务与默认路由模型" />
      ) : (
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground">模型</h3>
      )}

      <DefaultModelCard
        providers={providers}
        onSetDefaultModel={onSetDefaultModel}
      />

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold">模型服务</h2>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          添加服务
        </Button>
      </div>

      {providers.providers.length > 0 ? (
        <div className="mt-4 space-y-3">
          {providers.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onUpdate={(updates) => onUpdateProvider(provider.id, updates)}
              onRemove={() => setRemovingId(provider.id)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          还没有配置模型服务，先添加一个开始使用。
        </div>
      )}

      {adding ? (
        <AddProviderDialog
          onClose={() => setAdding(false)}
          onCreate={async (provider) => {
            await onAddProvider(provider);
            setAdding(false);
          }}
        />
      ) : null}

      {removingId ? (
        <ConfirmDialog
          isOpen
          title="删除模型服务"
          description="删除后该服务下的模型与密钥配置会一并移除，且不可恢复。"
          confirmLabel="删除"
          variant="destructive"
          onConfirm={async () => {
            await onRemoveProvider(removingId);
            setRemovingId(null);
          }}
          onCancel={() => setRemovingId(null)}
        />
      ) : null}
    </section>
  );
}

// 顶部「默认路由模型」卡片：聚合所有模型服务的所有模型，选中即设为全局默认
function DefaultModelCard({
  providers,
  onSetDefaultModel,
}: {
  providers: ProvidersConfig;
  onSetDefaultModel: (providerId: string, modelId: string) => Promise<void>;
}) {
  // 把所有 provider 的 models 拍平成可选项，value 编码为 "providerId::modelId"
  const options = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [];
    for (const provider of providers.providers) {
      for (const model of provider.models) {
        list.push({
          value: `${provider.id}::${model.id}`,
          label: `${provider.name} · ${model.name || model.id}`,
        });
      }
    }
    return list;
  }, [providers.providers]);

  const currentValue =
    providers.defaultProvider && providers.defaultModel
      ? `${providers.defaultProvider}::${providers.defaultModel}`
      : "";

  return (
    <div className="mt-8 rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">默认路由模型</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            所有新对话默认使用该模型
          </p>
        </div>
        {options.length > 0 ? (
          <SettingDropdown
            value={currentValue}
            placeholder="选择默认模型"
            options={options}
            onChange={(value) => {
              const [providerId, modelId] = value.split("::");
              void onSetDefaultModel(providerId, modelId);
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            先添加模型后再选择
          </span>
        )}
      </div>
    </div>
  );
}
