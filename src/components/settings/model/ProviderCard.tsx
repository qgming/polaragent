// 单个供应商卡片：可展开编辑 baseURL/apiKey/格式，并增删模型
import { useEffect, useRef, useState } from "react";
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
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { listRemoteModels } from "@/lib/electron/electron-api";
import type { ProviderConfig } from "@/types/config";
import { cn } from "@/lib/utils";
import { Field, SettingDropdown } from "../settings-shared";
import { PROVIDER_TYPE_LABELS, PROVIDER_TYPE_OPTIONS } from "./provider-meta";

export function ProviderCard({
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
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  // "saved" 状态自动复位的定时器，组件卸载时清理，避免对已卸载组件 setState
  const savedTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== undefined) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setBaseURL(provider.config.baseURL);
    setApiKey(provider.config.apiKey);
  }, [provider.config.baseURL, provider.config.apiKey]);

  // 保存 baseURL/apiKey（模型增删各自即时保存）
  const saveConnection = async () => {
    setSaveState("saving");
    try {
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
      if (savedTimerRef.current !== undefined) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1200);
    } catch (error) {
      console.error("保存供应商连接配置失败:", error);
      setSaveState("error");
    }
  };

  const persistModels = async (
    models: ProviderConfig["models"],
  ): Promise<boolean> => {
    try {
      await onUpdate({
        models,
        enabled: Boolean(baseURL.trim() && apiKey.trim() && models.length),
      });
      return true;
    } catch (error) {
      console.error("保存模型列表失败:", error);
      setFetchState("error");
      setFetchMessage("保存模型列表失败，请重试。");
      return false;
    }
  };

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
    void onUpdate({ type }).catch((error) => {
      console.error("保存接口格式失败:", error);
    });
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
      // 保存失败时 persistModels 已设置 error 提示，这里不再覆盖为成功
      if (!(await persistModels(merged))) return;
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
                  ) : saveState === "error" ? (
                    <TriangleAlert className="size-4 text-destructive" />
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
            {saveState === "error" ? (
              <p className="mt-2 text-xs text-destructive">
                保存失败，请重试。
              </p>
            ) : null}
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
