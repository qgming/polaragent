// 音频设置面板（容器）
// 参考图片设置和网络搜索的设计模式，接口标准选择 + 配置卡

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Loader2, Mic, Save, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AudioApiStandard, AudioConfig, Settings } from "@/types/config";
import { PageTitle, SettingDropdown } from "./settings-shared";
import { API_STANDARDS, audioDefaults } from "./audio/audio-meta";
import { TtsFields, type TtsValue } from "./audio/TtsFields";
import { AsrFields, type AsrValue } from "./audio/AsrFields";

function deriveState(config: AudioConfig) {
  const ttsProvider = config.tts?.provider ?? "chat";
  const asrProvider = config.asr?.provider ?? "audio";

  return {
    ttsProvider,
    asrProvider,
    ttsAudio: config.tts?.audio ?? audioDefaults().tts.audio!,
    ttsChat: config.tts?.chat ?? audioDefaults().tts.chat!,
    asrAudio: config.asr?.audio ?? audioDefaults().asr.audio!,
    asrChat: config.asr?.chat ?? audioDefaults().asr.chat!,
  };
}

export function AudioPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const initial = deriveState(settings.audio ?? audioDefaults());

  const [ttsProvider, setTtsProvider] = useState<AudioApiStandard>(initial.ttsProvider);
  const [asrProvider, setAsrProvider] = useState<AudioApiStandard>(initial.asrProvider);
  const [ttsAudio, setTtsAudio] = useState<TtsValue>(initial.ttsAudio);
  const [ttsChat, setTtsChat] = useState<TtsValue>(initial.ttsChat);
  const [asrAudio, setAsrAudio] = useState<AsrValue>(initial.asrAudio);
  const [asrChat, setAsrChat] = useState<AsrValue>(initial.asrChat);

  const [ttsSaveState, setTtsSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [asrSaveState, setAsrSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const mountedRef = useRef(true);
  const ttsResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asrResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (ttsResetTimerRef.current) clearTimeout(ttsResetTimerRef.current);
      if (asrResetTimerRef.current) clearTimeout(asrResetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const next = deriveState(settings.audio ?? audioDefaults());
    setTtsProvider(next.ttsProvider);
    setAsrProvider(next.asrProvider);
    setTtsAudio(next.ttsAudio);
    setTtsChat(next.ttsChat);
    setAsrAudio(next.asrAudio);
    setAsrChat(next.asrChat);
  }, [settings.audio]);

  const handleSaveTts = async () => {
    setTtsSaveState("saving");
    try {
      const currentAudio = settings.audio ?? audioDefaults();
      await onUpdate({
        audio: {
          ...currentAudio,
          tts: {
            provider: ttsProvider,
            audio: {
              ...ttsAudio,
              apiKey: ttsAudio.apiKey.trim(),
              baseURL: ttsAudio.baseURL.trim().replace(/\/+$/, ""),
            },
            chat: {
              ...ttsChat,
              apiKey: ttsChat.apiKey.trim(),
              baseURL: ttsChat.baseURL.trim().replace(/\/+$/, ""),
            },
          },
        },
      });
      if (!mountedRef.current) return;
      setTtsSaveState("saved");
      ttsResetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setTtsSaveState("idle");
      }, 1500);
    } catch (error) {
      console.error(t("audio.saveTtsFailed"), error);
      if (!mountedRef.current) return;
      setTtsSaveState("error");
      ttsResetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setTtsSaveState("idle");
      }, 2500);
    }
  };

  const handleSaveAsr = async () => {
    setAsrSaveState("saving");
    try {
      const currentAudio = settings.audio ?? audioDefaults();
      await onUpdate({
        audio: {
          ...currentAudio,
          asr: {
            provider: asrProvider,
            audio: {
              ...asrAudio,
              apiKey: asrAudio.apiKey.trim(),
              baseURL: asrAudio.baseURL.trim().replace(/\/+$/, ""),
              model: asrAudio.model.trim(),
              language: asrAudio.language?.trim(),
            },
            chat: {
              ...asrChat,
              apiKey: asrChat.apiKey.trim(),
              baseURL: asrChat.baseURL.trim().replace(/\/+$/, ""),
              model: asrChat.model.trim(),
              language: asrChat.language?.trim(),
            },
          },
        },
      });
      if (!mountedRef.current) return;
      setAsrSaveState("saved");
      asrResetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setAsrSaveState("idle");
      }, 1500);
    } catch (error) {
      console.error(t("audio.saveAsrFailed"), error);
      if (!mountedRef.current) return;
      setAsrSaveState("error");
      asrResetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setAsrSaveState("idle");
      }, 2500);
    }
  };

  const activeTtsStandard = API_STANDARDS.find((s) => s.id === ttsProvider) ?? API_STANDARDS[0];
  const activeAsrStandard = API_STANDARDS.find((s) => s.id === asrProvider) ?? API_STANDARDS[0];
  const activeTtsHint = t(`audio.standards.${activeTtsStandard.id}`);
  const activeAsrHint = t(`audio.standards.${activeAsrStandard.id}`);

  return (
    <section>
      <PageTitle
        title={t("audio.title")}
        description={t("audio.description")}
      />

      {/* TTS 接口标准选择 */}
      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t("audio.ttsStandard")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("audio.ttsStandardDesc")}
            </p>
          </div>
          <div className="shrink-0">
            <SettingDropdown
              value={ttsProvider}
              onChange={(value) => setTtsProvider(value as AudioApiStandard)}
              options={API_STANDARDS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        </div>
      </div>

      {/* TTS 配置卡 */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{activeTtsStandard.label}</h3>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {ttsProvider === "audio" ? (
            <TtsFields
              value={ttsAudio}
              onChange={(patch) => setTtsAudio((prev) => ({ ...prev, ...patch }))}
            />
          ) : (
            <TtsFields
              value={ttsChat}
              onChange={(patch) => setTtsChat((prev) => ({ ...prev, ...patch }))}
            />
          )}

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            {activeTtsHint}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            {ttsSaveState === "error" && (
              <span className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="size-3.5" />
                {t("audio.saveFailedRetry")}
              </span>
            )}
            <Button onClick={() => void handleSaveTts()} disabled={ttsSaveState === "saving"}>
              {ttsSaveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : ttsSaveState === "saved" ? (
                <Check className="size-4" />
              ) : ttsSaveState === "error" ? (
                <AlertCircle className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              {t("common:saveConfig")}
            </Button>
          </div>
        </div>
      </div>

      {/* ASR 接口标准选择 */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t("audio.asrStandard")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("audio.asrStandardDesc")}
            </p>
          </div>
          <div className="shrink-0">
            <SettingDropdown
              value={asrProvider}
              onChange={(value) => setAsrProvider(value as AudioApiStandard)}
              options={API_STANDARDS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        </div>
      </div>

      {/* ASR 配置卡 */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Mic className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{activeAsrStandard.label}</h3>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {asrProvider === "audio" ? (
            <AsrFields
              value={asrAudio}
              onChange={(patch) => setAsrAudio((prev) => ({ ...prev, ...patch }))}
            />
          ) : (
            <AsrFields
              value={asrChat}
              onChange={(patch) => setAsrChat((prev) => ({ ...prev, ...patch }))}
            />
          )}

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            {activeAsrHint}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            {asrSaveState === "error" && (
              <span className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="size-3.5" />
                {t("audio.saveFailedRetry")}
              </span>
            )}
            <Button onClick={() => void handleSaveAsr()} disabled={asrSaveState === "saving"}>
              {asrSaveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : asrSaveState === "saved" ? (
                <Check className="size-4" />
              ) : asrSaveState === "error" ? (
                <AlertCircle className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              {t("common:saveConfig")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
