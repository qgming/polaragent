// 音频工具 —— speech_recognition / speech_synthesis
// 调用 OpenAI / OpenAI 兼容的 /audio/transcriptions 与 /audio/speech 接口。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  openAiTranscription,
  openAiSpeech,
  mimoSpeech,
  writeBase64File,
} from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { fileName, resolvePath, text, type ToolContext } from "./tool-context";
import { progressUpdate, throwIfAborted, withDuration, nowMs } from "./tool-progress";

const speechRecognitionParams = Type.Object({
  audioPath: Type.String({ description: "音频文件路径，相对工作目录或绝对路径；支持 mp3/wav/m4a/webm/ogg 等" }),
  language: Type.Optional(
    Type.String({ description: "语言代码，如 zh / en / ja；留空自动检测" }),
  ),
});

const speechSynthesisParams = Type.Object({
  text: Type.String({ description: "要合成为语音的文字内容" }),
  fileName: Type.Optional(
    Type.String({ description: "保存文件名，支持 mp3/opus/aac/flac/wav；留空自动命名" }),
  ),
  voice: Type.Optional(
    Type.String({ description: "音色标识，如 '冰糖' / 'alloy'；留空使用默认音色" }),
  ),
  speed: Type.Optional(
    Type.Number({ description: "语速 0.25–4.0；留空使用默认值", minimum: 0.25, maximum: 4.0 }),
  ),
  responseFormat: Type.Optional(
    Type.Union(
      [
        Type.Literal("mp3"),
        Type.Literal("opus"),
        Type.Literal("aac"),
        Type.Literal("flac"),
        Type.Literal("wav"),
      ],
      { description: "音频格式；留空使用默认值" },
    ),
  ),
  stylePrompt: Type.Optional(
    Type.String({ description: "风格控制提示词，如 '(温柔)...'；仅部分高级 TTS 支持" }),
  ),
});

type SpeechRecognitionParams = Static<typeof speechRecognitionParams>;
type SpeechSynthesisParams = Static<typeof speechSynthesisParams>;

function safeAudioFileName(
  input: string | undefined,
  prefix: string,
  extension = "mp3",
) {
  const fallback = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
  const raw = (input?.trim() || fallback).replace(/[<>:"|?*\x00-\x1f]/g, "-");
  const safeExt = /^(mp3|opus|aac|flac|wav|webm|ogg)$/i.test(extension) ? extension.toLowerCase() : "mp3";
  const withExt = /\.(mp3|opus|aac|flac|wav|webm|ogg)$/i.test(raw)
    ? raw
    : `${raw.replace(/\.+$/, "")}.${safeExt}`;
  return withExt;
}

function addAudioArtifact(ctx: ToolContext, path: string) {
  const artifact = { path, name: fileName(path), kind: "final" as const };
  useTaskMonitorStore.getState().addArtifact(ctx.threadId, artifact);
}

export function speechRecognitionTool(ctx: ToolContext): AgentTool<typeof speechRecognitionParams> {
  return {
    name: "speech_recognition",
    label: "语音识别",
    description:
      "将音频文件转写为文字。使用设置 > 音频设置中的 ASR 配置；" +
      "支持常见音频格式（mp3/wav/m4a/webm/ogg 等），返回识别的文本。",
    parameters: speechRecognitionParams,
    execute: async (_id, params: SpeechRecognitionParams, signal, onUpdate) => {
      const startedAt = nowMs();
      progressUpdate(onUpdate, {
        phase: "validating",
        summary: "正在准备语音识别...",
        audioPath: params.audioPath,
      });
      const settings = useConfigStore.getState().settings.audio;
      const asrConfig = settings?.asr;
      if (!asrConfig?.provider) throw new Error("ASR 接口未配置");

      const activeConfig = asrConfig.provider === "audio" ? asrConfig.audio : asrConfig.chat;
      if (!activeConfig?.apiKey?.trim()) throw new Error("语音识别 API Key 未配置");
      if (!activeConfig.model?.trim()) throw new Error("语音识别模型未配置");

      const audioPath = resolvePath(ctx, params.audioPath);
      const language = params.language?.trim() || activeConfig.language?.trim() || undefined;
      throwIfAborted(signal);

      progressUpdate(onUpdate, {
        phase: "processing",
        summary: `正在识别 ${fileName(audioPath)}...`,
        audioPath,
        language,
      });
      const result = await openAiTranscription({
        apiKey: activeConfig.apiKey.trim(),
        baseURL: activeConfig.baseURL,
        model: activeConfig.model.trim(),
        audioPath,
        language,
        responseFormat: "json",
      });
      throwIfAborted(signal);

      return {
        content: text(result.text || "（识别结果为空）"),
        details: withDuration({
          audioPath,
          language,
          model: activeConfig.model,
          text: result.text,
        }, startedAt),
      };
    },
  };
}

export function speechSynthesisTool(ctx: ToolContext): AgentTool<typeof speechSynthesisParams> {
  return {
    name: "speech_synthesis",
    label: "语音合成",
    description:
      "将文字合成为语音并保存到工作目录。使用设置 > 音频设置中的 TTS 配置；" +
      "支持指定音色、语速、格式等参数，返回保存的音频文件路径并登记为产物。",
    parameters: speechSynthesisParams,
    execute: async (_id, params: SpeechSynthesisParams, signal, onUpdate) => {
      const startedAt = nowMs();
      progressUpdate(onUpdate, {
        phase: "validating",
        summary: "正在准备语音合成...",
        textLength: params.text.length,
      });
      const settings = useConfigStore.getState().settings.audio;
      const ttsConfig = settings?.tts;
      if (!ttsConfig?.provider) throw new Error("TTS 接口未配置");

      const activeConfig = ttsConfig.provider === "audio" ? ttsConfig.audio : ttsConfig.chat;
      if (!activeConfig?.apiKey?.trim()) throw new Error("语音合成 API Key 未配置");
      if (!activeConfig.model?.trim()) throw new Error("语音合成模型未配置");
      if (!activeConfig.voices || activeConfig.voices.length === 0) throw new Error("未配置任何音色");

      // 查找指定音色或使用默认音色
      let voiceConfig = activeConfig.voices.find((v) => v.id === activeConfig.defaultVoice);
      if (params.voice) {
        const specified = activeConfig.voices.find((v) => v.voice === params.voice || v.id === params.voice);
        if (specified) voiceConfig = specified;
      }
      if (!voiceConfig) voiceConfig = activeConfig.voices[0];

      const voice = params.voice ?? voiceConfig.voice;
      const speed = params.speed ?? voiceConfig.speed;
      const responseFormat = params.responseFormat ?? voiceConfig.format;
      throwIfAborted(signal);

      // 根据 provider 调用不同接口
      let result;
      progressUpdate(onUpdate, {
        phase: "processing",
        summary: `正在调用语音合成模型 ${activeConfig.model.trim()}...`,
        provider: ttsConfig.provider,
        voice,
        format: responseFormat,
      });
      if (ttsConfig.provider === "chat") {
        result = await mimoSpeech({
          apiKey: activeConfig.apiKey.trim(),
          baseURL: activeConfig.baseURL,
          model: activeConfig.model.trim(),
          input: params.text,
          voice,
          speed,
          responseFormat,
          stylePrompt: params.stylePrompt,
        });
      } else {
        result = await openAiSpeech({
          apiKey: activeConfig.apiKey.trim(),
          baseURL: activeConfig.baseURL,
          model: activeConfig.model.trim(),
          input: params.text,
          voice,
          speed,
          responseFormat,
        });
      }
      throwIfAborted(signal);

      const extension = result.extension || responseFormat;
      const target = resolvePath(
        ctx,
        safeAudioFileName(params.fileName, "synthesized-speech", extension),
      );
      progressUpdate(onUpdate, {
        phase: "saving",
        summary: `正在保存音频：${fileName(target)}`,
        path: target,
      });
      await writeBase64File(target, result.base64, { securityMode: ctx.permissionMode });
      addAudioArtifact(ctx, target);

      return {
        content: text(`已合成语音并保存为：${fileName(target)}`),
        details: withDuration({
          path: target,
          name: fileName(target),
          voice,
          speed,
          format: extension,
          model: activeConfig.model,
          provider: ttsConfig.provider,
          audioPath: target,
          duration: Math.ceil(params.text.length / 10),
        }, startedAt),
      };
    },
  };
}
