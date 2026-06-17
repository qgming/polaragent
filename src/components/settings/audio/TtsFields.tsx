// TTS 字段组件
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Plus, Edit2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VoiceConfig } from "@/types/config";

export interface TtsValue {
  apiKey: string;
  baseURL: string;
  model: string;
  defaultVoice: string;
  voices: VoiceConfig[];
}

function previewUrl(baseURL: string, fallback: string, endpoint: string): string {
  const base = (baseURL || fallback).trim().replace(/\/+$/, "");
  return `${base}${endpoint}`;
}

export function TtsFields({
  value,
  onChange,
}: {
  value: TtsValue;
  onChange: (patch: Partial<TtsValue>) => void;
}) {
  const { t } = useTranslation("settings");
  const [showKey, setShowKey] = useState(false);
  const [editingVoice, setEditingVoice] = useState<VoiceConfig | null>(null);
  const [showDialog, setShowDialog] = useState(false);

  const handleAddVoice = () => {
    setEditingVoice({
      id: `voice-${Date.now()}`,
      voice: "",
      speed: 1.0,
      format: "mp3",
    });
    setShowDialog(true);
  };

  const handleEditVoice = (voice: VoiceConfig) => {
    setEditingVoice({ ...voice });
    setShowDialog(true);
  };

  const handleDeleteVoice = (voiceId: string) => {
    const updated = value.voices.filter((v) => v.id !== voiceId);
    onChange({ voices: updated });
    if (value.defaultVoice === voiceId && updated.length > 0) {
      onChange({ defaultVoice: updated[0].id });
    }
  };

  const handleSaveVoice = () => {
    if (!editingVoice) return;
    const existing = value.voices.findIndex((v) => v.id === editingVoice.id);
    const updated = existing >= 0
      ? value.voices.map((v, i) => i === existing ? editingVoice : v)
      : [...value.voices, editingVoice];
    onChange({ voices: updated });
    setShowDialog(false);
    setEditingVoice(null);
  };

  return (
    <>
      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          Base URL
        </label>
        <input
          type="text"
          value={value.baseURL}
          onChange={(e) => onChange({ baseURL: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("audio.actualRequest", { url: previewUrl(value.baseURL, "https://api.openai.com/v1", "/chat/completions") })}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          API Key
        </label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={value.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="sk-..."
            className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            aria-label={showKey ? t("models.hideApiKey") : t("models.showApiKey")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          {t("audio.model")}
        </label>
        <input
          type="text"
          value={value.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="tts-1"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
        />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            {t("audio.voiceList")}
          </label>
          <Button variant="outline" size="sm" onClick={handleAddVoice} className="h-7 gap-1 text-xs">
            <Plus className="size-3.5" />
            {t("audio.addVoice")}
          </Button>
        </div>

        <div className="space-y-2">
          {value.voices.map((voice) => (
            <div
              key={voice.id}
              className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="radio"
                  checked={value.defaultVoice === voice.id}
                  onChange={() => onChange({ defaultVoice: voice.id })}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{voice.voice}</span>
                    {value.defaultVoice === voice.id && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                        {t("audio.default")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t("audio.voiceSpeed", { speed: voice.speed })}
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
                  disabled={value.voices.length === 1}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-30"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showDialog && editingVoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">
              {value.voices.find((v) => v.id === editingVoice.id) ? t("audio.editVoice") : t("audio.addVoice")}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  {t("audio.voiceId")}
                </label>
                <input
                  type="text"
                  value={editingVoice.voice}
                  onChange={(e) => setEditingVoice({ ...editingVoice, voice: e.target.value })}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  {t("audio.speed")}
                </label>
                <input
                  type="number"
                  value={editingVoice.speed}
                  onChange={(e) => setEditingVoice({ ...editingVoice, speed: Number(e.target.value) })}
                  step="0.1"
                  min="0.25"
                  max="4.0"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  {t("audio.audioFormat")}
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
                  <option value="pcm16">pcm16</option>
                </select>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDialog(false);
                  setEditingVoice(null);
                }}
              >
                {t("common:cancel")}
              </Button>
              <Button onClick={handleSaveVoice}>{t("common:save")}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
