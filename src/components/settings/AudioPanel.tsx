// 音频设置面板（语音识别 ASR + 语音合成 TTS）
// TTS 采用音色列表管理，支持添加多个音色配置。

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Eye, EyeOff, Mic, Volume2, Loader2, Save, Plus, Edit2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AudioConfig, Settings, VoiceConfig } from "@/types/config";
import { defaultSettings } from "@/config/defaults";
import { PageTitle } from "./settings-shared";

function audioDefaults(): AudioConfig {
  return (
    defaultSettings.audio ?? {
      asr: {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "whisper-1",
        language: "",
      },
      tts: {
        apiKey: "",
        baseURL: "https://api.xiaomimimo.com/v1",
        defaultVoice: "bingtang",
        voices: [
          {
            id: "bingtang",
            name: "冰糖",
            provider: "mimo",
            model: "mimo-v2.5-tts",
            voice: "冰糖",
            speed: 1.0,
            format: "mp3",
          },
        ],
      },
    }
  );
}

export function AudioPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.audio ?? audioDefaults();

  // ASR 状态
  const [asrApiKey, setAsrApiKey] = useState(config.asr.apiKey ?? "");
  const [asrBaseURL, setAsrBaseURL] = useState(config.asr.baseURL ?? "https://api.openai.com/v1");
  const [asrModel, setAsrModel] = useState(config.asr.model ?? "whisper-1");
  const [asrLanguage, setAsrLanguage] = useState(config.asr.language ?? "");
  const [showAsrKey, setShowAsrKey] = useState(false);

  // TTS 状态
  const [ttsApiKey, setTtsApiKey] = useState(config.tts.apiKey ?? "");
  const [ttsBaseURL, setTtsBaseURL] = useState(config.tts.baseURL ?? "https://api.xiaomimimo.com/v1");
  const [showTtsKey, setShowTtsKey] = useState(false);
  const [voices, setVoices] = useState<VoiceConfig[]>(config.tts.voices ?? []);
  const [defaultVoice, setDefaultVoice] = useState(config.tts.defaultVoice ?? "bingtang");

  // 编辑音色弹窗状态
  const [editingVoice, setEditingVoice] = useState<VoiceConfig | null>(null);
  const [showVoiceDialog, setShowVoiceDialog] = useState(false);

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
    const next = settings.audio ?? audioDefaults();
    setAsrApiKey(next.asr.apiKey ?? "");
    setAsrBaseURL(next.asr.baseURL ?? "https://api.openai.com/v1");
    setAsrModel(next.asr.model ?? "whisper-1");
    setAsrLanguage(next.asr.language ?? "");
    setTtsApiKey(next.tts.apiKey ?? "");
    setTtsBaseURL(next.tts.baseURL ?? "https://api.xiaomimimo.com/v1");
    setVoices(next.tts.voices ?? []);
    setDefaultVoice(next.tts.defaultVoice ?? "bingtang");
  }, [settings.audio]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await onUpdate({
        audio: {
          asr: {
            apiKey: asrApiKey.trim(),
            baseURL: asrBaseURL.trim().replace(/\/+$/, ""),
            model: asrModel.trim(),
            language: asrLanguage.trim(),
          },
          tts: {
            apiKey: ttsApiKey.trim(),
            baseURL: ttsBaseURL.trim().replace(/\/+$/, ""),
            defaultVoice,
            voices,
          },
        },
      });
      if (!mountedRef.current) return;
      setSaveState("saved");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 1500);
    } catch (error) {
      console.error("保存音频配置失败", error);
      if (!mountedRef.current) return;
      setSaveState("error");
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setSaveState("idle");
      }, 2500);
    }
  };

  const handleAddVoice = () => {
    setEditingVoice({
      id: `voice-${Date.now()}`,
      name: "新音色",
      provider: "mimo",
      model: "mimo-v2.5-tts",
      voice: "",
      speed: 1.0,
      format: "mp3",
    });
    setShowVoiceDialog(true);
  };

  const handleEditVoice = (voice: VoiceConfig) => {
    setEditingVoice({ ...voice });
    setShowVoiceDialog(true);
  };

  const handleDeleteVoice = (voiceId: string) => {
    const updated = voices.filter((v) => v.id !== voiceId);
    setVoices(updated);
    // 如果删除的是默认音色，切换到第一个
    if (defaultVoice === voiceId && updated.length > 0) {
      setDefaultVoice(updated[0].id);
    }
  };

  const handleSaveVoice = () => {
    if (!editingVoice) return;
    const existing = voices.findIndex((v) => v.id === editingVoice.id);
    if (existing >= 0) {
      const updated = [...voices];
      updated[existing] = editingVoice;
      setVoices(updated);
    } else {
      setVoices([...voices, editingVoice]);
    }
    setShowVoiceDialog(false);
    setEditingVoice(null);
  };

  return (
    <section>
      <PageTitle
        title="音频设置"
        description="配置语音识别（ASR）与语音合成（TTS）。TTS 支持添加多个音色配置，AI 可灵活选择。"
      />

      {/* ASR 卡片 */}
      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Mic className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">语音识别 (ASR)</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            将语音转写为文字，供 speech_recognition 工具使用。支持 OpenAI 官方接口和兼容端点。
          </p>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              Base URL
            </label>
            <input
              type="text"
              value={asrBaseURL}
              onChange={(event) => setAsrBaseURL(event.target.value)}
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
                type={showAsrKey ? "text" : "password"}
                value={asrApiKey}
                onChange={(event) => setAsrApiKey(event.target.value)}
                placeholder="sk-..."
                className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShowAsrKey((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showAsrKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              识别模型
            </label>
            <input
              type="text"
              value={asrModel}
              onChange={(event) => setAsrModel(event.target.value)}
              placeholder="whisper-1"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              语言（可选，如 zh / en，留空自动检测）
            </label>
            <input
              type="text"
              value={asrLanguage}
              onChange={(event) => setAsrLanguage(event.target.value)}
              placeholder="zh"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>
        </div>
      </div>

      {/* TTS 卡片 */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">语音合成 (TTS)</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            将文字合成为语音，供 speech_synthesis 工具使用。支持添加多个音色配置，AI 可根据场景灵活选择。
          </p>
        </div>

        <div className="space-y-4 px-5 py-5">
          {/* 通用配置 */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              Base URL
            </label>
            <input
              type="text"
              value={ttsBaseURL}
              onChange={(event) => setTtsBaseURL(event.target.value)}
              placeholder="https://api.xiaomimimo.com/v1"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative">
              <input
                type={showTtsKey ? "text" : "password"}
                value={ttsApiKey}
                onChange={(event) => setTtsApiKey(event.target.value)}
                placeholder="sk-..."
                className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShowTtsKey((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showTtsKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {/* 音色列表 */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                音色列表（可添加多个音色配置）
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddVoice}
                className="h-7 gap-1 text-xs"
              >
                <Plus className="size-3.5" />
                添加音色
              </Button>
            </div>

            <div className="space-y-2">
              {voices.map((voice) => (
                <div
                  key={voice.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="radio"
                      checked={defaultVoice === voice.id}
                      onChange={() => setDefaultVoice(voice.id)}
                      className="shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{voice.name}</span>
                        {defaultVoice === voice.id && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                            默认
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        模型: {voice.model} · 音色: {voice.voice} · 语速: {voice.speed}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleEditVoice(voice)}
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <Edit2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteVoice(voice.id)}
                      disabled={voices.length === 1}
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            AI 调用 speech_synthesis 工具时，会使用默认音色；也可在工具参数中指定 voice 参数覆盖。支持 OpenAI / MiMo 等兼容接口。
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

      {/* 编辑音色弹窗 */}
      {showVoiceDialog && editingVoice ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">
              {voices.find((v) => v.id === editingVoice.id) ? "编辑音色" : "添加音色"}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  音色名称
                </label>
                <input
                  type="text"
                  value={editingVoice.name}
                  onChange={(e) => setEditingVoice({ ...editingVoice, name: e.target.value })}
                  placeholder="冰糖"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  服务商
                </label>
                <select
                  value={editingVoice.provider}
                  onChange={(e) =>
                    setEditingVoice({
                      ...editingVoice,
                      provider: e.target.value as "openai" | "mimo",
                    })
                  }
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                >
                  <option value="mimo">MiMo (推荐)</option>
                  <option value="openai">OpenAI</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {editingVoice.provider === "mimo"
                    ? "使用 /chat/completions 接口，支持风格控制"
                    : "使用 /audio/speech 接口"}
                </p>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  模型
                </label>
                <input
                  type="text"
                  value={editingVoice.model}
                  onChange={(e) => setEditingVoice({ ...editingVoice, model: e.target.value })}
                  placeholder="mimo-v2.5-tts"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  音色标识（手动输入，支持任意值）
                </label>
                <input
                  type="text"
                  value={editingVoice.voice}
                  onChange={(e) => setEditingVoice({ ...editingVoice, voice: e.target.value })}
                  placeholder="冰糖"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  语速（0.25 - 4.0）
                </label>
                <input
                  type="number"
                  value={editingVoice.speed}
                  onChange={(e) =>
                    setEditingVoice({ ...editingVoice, speed: Number(e.target.value) })
                  }
                  placeholder="1.0"
                  step="0.1"
                  min="0.25"
                  max="4.0"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  音频格式
                </label>
                <select
                  value={editingVoice.format}
                  onChange={(e) =>
                    setEditingVoice({
                      ...editingVoice,
                      format: e.target.value as VoiceConfig["format"],
                    })
                  }
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                >
                  <option value="mp3">mp3</option>
                  <option value="opus">opus</option>
                  <option value="aac">aac</option>
                  <option value="flac">flac</option>
                  <option value="wav">wav</option>
                  <option value="pcm16">pcm16 (MiMo 流式)</option>
                </select>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowVoiceDialog(false);
                  setEditingVoice(null);
                }}
              >
                取消
              </Button>
              <Button onClick={handleSaveVoice}>保存</Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
