// 模型设置面板（多供应商 + 多模型 + 默认模型）
// src/components/settings/ModelPanel.tsx

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { listRemoteModels } from "@/lib/electron-api";
import type { ProviderConfig, ProvidersConfig } from "@/types/config";
import { cn } from "@/lib/utils";
import { Field, PageTitle, SettingDropdown } from "./shared";

// 三种接口格式的展示名
const PROVIDER_TYPE_LABELS: Record<ProviderConfig["type"], string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

const PROVIDER_TYPE_OPTIONS = (
  Object.keys(PROVIDER_TYPE_LABELS) as Array<ProviderConfig["type"]>
).map((value) => ({ value, label: PROVIDER_TYPE_LABELS[value] }));

// 生成一个简单的 provider id（开发阶段：随机后缀足够）
function makeProviderId() {
  return `provider-${Math.random().toString(36).slice(2, 8)}`;
}

export function ModelPanel({
  providers,
  onAddProvider,
  onUpdateProvider,
  onRemoveProvider,
  onSetDefaultModel,
}: {
  providers: ProvidersConfig;
  onAddProvider: (provider: ProviderConfig) => Promise<void>;
  onUpdateProvider: (
    id: string,
    updates: Partial<ProviderConfig>,
  ) => Promise<void>;
  onRemoveProvider: (id: string) => Promise<void>;
  onSetDefaultModel: (providerId: string, modelId: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  return (
    <section>
      <PageTitle
        title="模型设置"
        description="管理供应商与模型，支持任意兼容 OpenAI Chat Completions / Responses / Anthropic Messages 的服务。"
      />

      <DefaultModelCard
        providers={providers}
        onSetDefaultModel={onSetDefaultModel}
      />

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold">供应商</h2>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          添加供应商
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
          还没有供应商，点击右上角「添加供应商」开始配置。
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
          title="删除供应商"
          description="删除后该供应商及其模型配置将被移除，使用它的助手需要重新选择模型。确定删除吗？"
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

// 顶部「默认模型」卡片：聚合所有供应商的所有模型，选中即设为全局默认
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
          <h3 className="text-sm font-semibold">默认模型</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            未单独配置模型的助手将使用此模型。
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
            请先在下方添加供应商和模型
          </span>
        )}
      </div>
    </div>
  );
}

// 单个供应商卡片：可展开编辑 baseURL/apiKey/格式，并增删模型
function ProviderCard({
  provider,
  onUpdate,
  onRemove,
}: {
  provider: ProviderConfig;
  onUpdate: (updates: Partial<ProviderConfig>) => Promise<void>;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [baseURL, setBaseURL] = useState(provider.config.baseURL);
  const [apiKey, setApiKey] = useState(provider.config.apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [fetchMessage, setFetchMessage] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  useEffect(() => {
    setBaseURL(provider.config.baseURL);
    setApiKey(provider.config.apiKey);
  }, [provider.config.baseURL, provider.config.apiKey]);

  // 保存 baseURL/apiKey（模型增删各自即时保存）
  const saveConnection = async () => {
    setSaveState("saving");
    await onUpdate({
      enabled: Boolean(
        baseURL.trim() && apiKey.trim() && provider.models.length,
      ),
      config: {
        ...provider.config,
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
      },
    });
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1200);
  };

  const persistModels = (models: ProviderConfig["models"]) =>
    onUpdate({
      models,
      enabled: Boolean(baseURL.trim() && apiKey.trim() && models.length),
    });

  const addModel = (id: string) => {
    const modelId = id.trim();
    if (!modelId || provider.models.some((m) => m.id === modelId)) return;
    void persistModels([
      ...provider.models,
      {
        id: modelId,
        name: modelId,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ]);
  };

  const removeModel = (id: string) => {
    void persistModels(provider.models.filter((m) => m.id !== id));
  };

  const setType = (type: ProviderConfig["type"]) => {
    void onUpdate({ type });
  };

  const fetchModels = async () => {
    setFetchState("loading");
    setFetchMessage("正在读取模型列表...");
    try {
      const remote = await listRemoteModels(baseURL.trim(), apiKey.trim());
      const existing = new Set(provider.models.map((m) => m.id));
      const merged = [
        ...provider.models,
        ...remote
          .filter((id) => !existing.has(id))
          .map((id) => ({
            id,
            name: id,
            contextWindow: 128000,
            maxTokens: 8192,
          })),
      ];
      await persistModels(merged);
      setFetchState("idle");
      setFetchMessage(
        remote.length > 0
          ? `已合并 ${remote.length} 个云端模型。`
          : "接口未返回模型，请手动添加。",
      );
    } catch (error) {
      setFetchState("error");
      setFetchMessage(
        `读取失败：${error instanceof Error ? error.message : "未知错误"}。请确认 Base URL 与 API Key。`,
      );
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* 头部：点击展开/收起 */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded ? "rotate-180" : "",
            )}
          />
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Bot className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {provider.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {PROVIDER_TYPE_LABELS[provider.type]} · {provider.models.length}{" "}
              个模型{provider.enabled ? " · 已启用" : ""}
            </span>
          </span>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>

      {expanded ? (
        <div className="border-t border-border px-5 py-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Field icon={Plug} label="Base URL">
              <input
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                onBlur={() => void saveConnection()}
                placeholder="https://api.deepseek.com"
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
              />
            </Field>
            <Field icon={Settings2} label="接口格式">
              <SettingDropdown
                value={provider.type}
                options={PROVIDER_TYPE_OPTIONS}
                onChange={(value) => setType(value as ProviderConfig["type"])}
                className="h-11 w-full justify-between"
              />
            </Field>
          </div>

          <div className="mt-5">
            <Field icon={KeyRound} label="API Key">
              <div className="relative">
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  onBlur={() => void saveConnection()}
                  type={showApiKey ? "text" : "password"}
                  placeholder="sk-..."
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 pr-20 text-base outline-none focus:border-ring"
                />
                <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
                  {saveState === "saving" ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : saveState === "saved" ? (
                    <Check className="size-4 text-muted-foreground" />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setShowApiKey((value) => !value)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showApiKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>
            </Field>
          </div>

          {/* 模型管理 */}
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Bot className="size-4" />
                模型
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !baseURL.trim() || !apiKey.trim() || fetchState === "loading"
                }
                onClick={() => void fetchModels()}
              >
                {fetchState === "loading" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                云端获取
              </Button>
            </div>

            <div className="flex gap-2">
              <input
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    addModel(newModel);
                    setNewModel("");
                  }
                }}
                placeholder="手动输入模型名称，例如 deepseek-chat"
                className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!newModel.trim()}
                onClick={() => {
                  addModel(newModel);
                  setNewModel("");
                }}
              >
                <Plus className="size-4" />
                添加
              </Button>
            </div>

            {fetchMessage ? (
              <p
                className={cn(
                  "mt-2 text-xs",
                  fetchState === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {fetchMessage}
              </p>
            ) : null}

            {provider.models.length > 0 ? (
              <div className="mt-3 rounded-lg border border-border">
                {provider.models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-sm">{model.id}</span>
                    <button
                      type="button"
                      onClick={() => removeModel(model.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                还没有模型，手动输入或点击「云端获取」。
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 添加供应商弹窗
function AddProviderDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (provider: ProviderConfig) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] =
    useState<ProviderConfig["type"]>("openai-completions");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setCreating(true);
    await onCreate({
      id: makeProviderId(),
      name: name.trim(),
      type,
      enabled: false,
      config: {
        apiKey: apiKey.trim(),
        baseURL: baseURL.trim(),
        defaultModel: "",
      },
      models: [],
    });
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-[460px] rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold">添加供应商</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <Field icon={Bot} label="名称">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 DeepSeek、Claude 代理"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
          <Field icon={Settings2} label="接口格式">
            <SettingDropdown
              value={type}
              options={PROVIDER_TYPE_OPTIONS}
              onChange={(value) => setType(value as ProviderConfig["type"])}
              className="h-11 w-full justify-between"
            />
          </Field>
          <Field icon={Plug} label="Base URL">
            <input
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.deepseek.com"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
          <Field icon={KeyRound} label="API Key">
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              placeholder="sk-..."
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || creating} onClick={() => void submit()}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            创建
          </Button>
        </footer>
      </div>
    </div>
  );
}
