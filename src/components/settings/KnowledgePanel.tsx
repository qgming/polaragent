// 嵌入配置面板（OpenAI 标准 embeddings + 检索配置）
import { useEffect, useRef, useState } from "react";
import { Check, Database, Eye, EyeOff, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { defaultSettings } from "@/config/defaults";
import type { Settings } from "@/types/config";
import { PageTitle } from "./settings-shared";

export function KnowledgePanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.knowledge ?? defaultSettings.knowledge!;

  const [apiKey, setApiKey] = useState(config.embedding.apiKey ?? "");
  const [baseURL, setBaseURL] = useState(
    config.embedding.baseURL ?? "https://api.openai.com/v1",
  );
  const [model, setModel] = useState(
    config.embedding.model ?? "text-embedding-3-small",
  );
  const [showKey, setShowKey] = useState(false);
  const [topK, setTopK] = useState(config.retrieval.topK ?? 5);
  const [threshold, setThreshold] = useState(config.retrieval.threshold ?? 0.7);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await onUpdate({
        knowledge: {
          embedding: {
            apiKey: apiKey.trim(),
            baseURL: baseURL.trim().replace(/\/+$/, ""),
            model: model.trim(),
            dimension: 0, // 始终使用模型默认维度
          },
          retrieval: {
            topK,
            threshold,
            reranker: "none",
          },
        },
      });
      if (!mountedRef.current) return;
      setSaveState("saved");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 1500);
    } catch (error) {
      console.error("保存嵌入配置失败", error);
      if (!mountedRef.current) return;
      setSaveState("error");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 2000);
    }
  };

  return (
    <section>
      <PageTitle
        title="嵌入配置"
        description="配置 OpenAI 标准 embeddings 接口，用于知识库向量化与检索"
      />

      <div className="mt-8 space-y-6">
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-medium">
            <Database className="size-4" />
            OpenAI Embeddings
          </h3>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                Base URL
              </span>
              <input
                type="text"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                placeholder="https://api.openai.com/v1"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                API Key
              </span>
              <div className="flex gap-2">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                  placeholder="sk-..."
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  className="rounded-md border border-input bg-background px-3 text-muted-foreground hover:bg-muted"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showKey ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                模型
              </span>
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                placeholder="text-embedding-3-small"
              />
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 text-sm font-medium">检索配置</h3>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                TopK (每次检索返回的相似块数量)
              </span>
              <select
                value={topK}
                onChange={(event) => setTopK(Number(event.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              >
                {[1, 3, 5, 10, 15, 20].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                相似度阈值 (低于此值的结果会被过滤)
              </span>
              <select
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              >
                {[0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saveState === "saving"}>
            {saveState === "saving" && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {saveState === "saved" && <Check className="size-4" />}
            {saveState === "idle" && <Save className="size-4" />}
            {saveState === "error" && "重试"}
            {saveState === "saving"
              ? "保存中..."
              : saveState === "saved"
                ? "已保存"
                : "保存"}
          </Button>
        </div>
      </div>
    </section>
  );
}
