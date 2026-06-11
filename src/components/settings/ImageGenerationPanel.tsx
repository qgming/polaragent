// 图片模式设置面板（容器）
// 用户选择图片接口标准（OpenAI 图片接口 / OpenAI Chat / Google Gemini），
// 并为所选标准配置 Base URL、API Key、模型及默认生成参数。
// 接口标准由此处设置决定。
// 具体字段组件拆分在 ./image 子目录。

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Image, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  ImageApiStandard,
  ImageGenerationConfig,
  Settings,
} from "@/types/config";
import { PageTitle, SettingDropdown } from "./settings-shared";
import { STANDARDS, imageGenerationDefaults } from "./image/image-meta";
import { OpenAiImagesFields, type OpenAiImagesValue } from "./image/OpenAiImagesFields";
import { OpenAiChatFields, type OpenAiChatValue } from "./image/OpenAiChatFields";
import { GeminiFields, type GeminiValue } from "./image/GeminiFields";

// 从配置还原三组字段的本地状态（带兜底默认值）。
// 比例与分辨率不再由设置控制，改为 AI 在调用工具时按需填写。
function deriveState(config: ImageGenerationConfig) {
  const openaiImages: OpenAiImagesValue = {
    apiKey: config.openaiImages?.apiKey ?? "",
    baseURL: config.openaiImages?.baseURL ?? "https://api.openai.com/v1",
    model: config.openaiImages?.model ?? "gpt-image-2",
  };
  const openaiChat: OpenAiChatValue = {
    apiKey: config.openaiChat?.apiKey ?? "",
    baseURL: config.openaiChat?.baseURL ?? "https://api.openai.com/v1",
    model: config.openaiChat?.model ?? "gpt-image-2",
  };
  const gemini: GeminiValue = {
    apiKey: config.gemini?.apiKey ?? "",
    baseURL: config.gemini?.baseURL ?? "",
    model: config.gemini?.model ?? "gemini-3-pro-image-preview",
  };
  return { provider: config.provider ?? "openai-images", openaiImages, openaiChat, gemini };
}

export function ImageGenerationPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const initial = deriveState(settings.imageGeneration ?? imageGenerationDefaults());

  const [provider, setProvider] = useState<ImageApiStandard>(initial.provider);
  const [openaiImages, setOpenaiImages] = useState<OpenAiImagesValue>(initial.openaiImages);
  const [openaiChat, setOpenaiChat] = useState<OpenAiChatValue>(initial.openaiChat);
  const [gemini, setGemini] = useState<GeminiValue>(initial.gemini);

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
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
    const next = deriveState(settings.imageGeneration ?? imageGenerationDefaults());
    setProvider(next.provider);
    setOpenaiImages(next.openaiImages);
    setOpenaiChat(next.openaiChat);
    setGemini(next.gemini);
  }, [settings.imageGeneration]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      // 各标准配置全部保留，仅切换 provider；这样切换标准不会丢失其它标准已填的内容。
      await onUpdate({
        imageGeneration: {
          provider,
          openaiImages: {
            apiKey: openaiImages.apiKey.trim(),
            baseURL: openaiImages.baseURL.trim().replace(/\/+$/, ""),
            model: openaiImages.model.trim(),
          },
          openaiChat: {
            apiKey: openaiChat.apiKey.trim(),
            baseURL: openaiChat.baseURL.trim().replace(/\/+$/, ""),
            model: openaiChat.model.trim(),
          },
          gemini: {
            apiKey: gemini.apiKey.trim(),
            baseURL: gemini.baseURL.trim().replace(/\/+$/, ""),
            model: gemini.model.trim(),
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
      setSaveState("error");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 2500);
    }
  };

  const activeStandard = STANDARDS.find((s) => s.id === provider) ?? STANDARDS[0];

  return (
    <section>
      <PageTitle
        title="图片模式"
        description="选择图片生成使用的接口标准并配置模型。"
      />

      {/* 接口标准选择（下拉，与网络搜索一致） */}
      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">接口标准</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              选择图片生成使用的接口标准。
            </p>
          </div>
          <div className="shrink-0">
            <SettingDropdown
              value={provider}
              onChange={(value) => setProvider(value as ImageApiStandard)}
              options={STANDARDS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        </div>
      </div>

      {/* 所选标准的配置卡 */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Image className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{activeStandard.label}</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{activeStandard.hint}</p>
        </div>

        <div className="space-y-4 px-5 py-5">
          {provider === "openai-images" && (
            <OpenAiImagesFields
              value={openaiImages}
              onChange={(patch) => setOpenaiImages((prev) => ({ ...prev, ...patch }))}
            />
          )}
          {provider === "openai-chat" && (
            <OpenAiChatFields
              value={openaiChat}
              onChange={(patch) => setOpenaiChat((prev) => ({ ...prev, ...patch }))}
            />
          )}
          {provider === "gemini" && (
            <GeminiFields
              value={gemini}
              onChange={(patch) => setGemini((prev) => ({ ...prev, ...patch }))}
            />
          )}

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
