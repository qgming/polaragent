// 图片模式设置面板（OpenAI / OpenAI 兼容图片生成接口）

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Eye, EyeOff, Image, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImageGenerationConfig, Settings } from "@/types/config";
import { defaultSettings } from "@/config/defaults";
import { PageTitle } from "./settings-shared";

function imageGenerationDefaults(): ImageGenerationConfig {
  // 不依赖 defaultSettings.imageGeneration 的非空断言：返回稳定的兜底默认值，
  // 避免某些 settings 迁移路径下该字段缺失导致运行时崩溃。
  return (
    defaultSettings.imageGeneration ?? {
      provider: "openai",
      openai: {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-image-1",
      },
    }
  );
}

export function ImageGenerationPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.imageGeneration ?? imageGenerationDefaults();
  const openai = config.openai;
  const [apiKey, setApiKey] = useState(openai.apiKey ?? "");
  const [baseURL, setBaseURL] = useState(openai.baseURL ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(openai.model ?? "gpt-image-1");
  const [showKey, setShowKey] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // 组件挂载标志 + 定时器引用：避免异步保存后在已卸载组件上 setState 与定时器残留
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const next = settings.imageGeneration ?? imageGenerationDefaults();
    setApiKey(next.openai.apiKey ?? "");
    setBaseURL(next.openai.baseURL ?? "https://api.openai.com/v1");
    setModel(next.openai.model ?? "gpt-image-1");
  }, [settings.imageGeneration]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await onUpdate({
        imageGeneration: {
          ...config,
          provider: "openai",
          openai: {
            apiKey: apiKey.trim(),
            baseURL: baseURL.trim().replace(/\/+$/, ""),
            model: model.trim(),
          },
        },
      });
      if (!mountedRef.current) return;
      setSaveState("saved");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 1500);
    } catch (error) {
      console.error("保存图片模式配置失败", error);
      if (!mountedRef.current) return;
      // 保存失败时回到可重试的错误态，而不是卡在 saving 永久禁用按钮
      setSaveState("error");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 2500);
    }
  };

  return (
    <section>
      <PageTitle
        title="图片模式"
        description="配置图片生成工具使用的模型与 OpenAI 兼容接口。"
      />

      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Image className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">OpenAI 图片生成</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            支持 OpenAI 官方接口和常见兼容端口。Base URL 可填写官方 /v1 地址，也可填写兼容服务地址。
          </p>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              Base URL
            </label>
            <input
              type="text"
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              图片模型
            </label>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-image-1"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            生成图片时，AI 会调用 image_generation 工具，并在工具参数中选择 /images/generations 或 /chat/completions 格式以及尺寸、质量、风格等选项；编辑图片时会调用 image_edit 工具。
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            {saveState === "error" ? (
              <span className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="size-3.5" />
                保存失败，请重试
              </span>
            ) : null}
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : saveState === "error" ? (
                <AlertCircle className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
