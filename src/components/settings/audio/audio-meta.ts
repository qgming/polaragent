// 音频配置元数据
import type { AudioApiStandard, AudioConfig } from "@/types/config";

export const API_STANDARDS: Array<{ id: AudioApiStandard; label: string; hint: string }> = [
  {
    id: "audio",
    label: "OpenAI Audio",
    hint: "标准音频接口 (/audio/transcriptions, /audio/speech)",
  },
  {
    id: "chat",
    label: "OpenAI Chat",
    hint: "Chat 接口 (/chat/completions)，支持更多模型和风格控制",
  },
];

export function audioDefaults(): AudioConfig {
  return {
    asr: {
      provider: "audio",
      audio: {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "whisper-1",
        language: "",
      },
      chat: {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o-audio-preview",
        language: "",
      },
    },
    tts: {
      provider: "chat",
      audio: {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "tts-1",
        defaultVoice: "alloy",
        voices: [
          { id: "alloy", voice: "alloy", speed: 1.0, format: "mp3" },
        ],
      },
      chat: {
        apiKey: "",
        baseURL: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-tts",
        defaultVoice: "bingtang",
        voices: [
          { id: "bingtang", voice: "冰糖", speed: 1.0, format: "mp3" },
        ],
      },
    },
    inputOptimization: {
      autoSend: false,
      refineText: false,
    },
  };
}
