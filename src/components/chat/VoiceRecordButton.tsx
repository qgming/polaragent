// 语音录音按钮组件
// src/components/chat/VoiceRecordButton.tsx

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AudioLines } from "@/components/animate-ui/icons/audio-lines";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useConfigStore } from "@/stores/config-store";

interface VoiceRecordButtonProps {
  /** 录音完成后的回调，返回识别后的文本 */
  onTranscriptionComplete: (text: string, shouldAutoSend: boolean) => void;
  /** 是否禁用按钮 */
  disabled?: boolean;
}

export function VoiceRecordButton({
  onTranscriptionComplete,
  disabled = false,
}: VoiceRecordButtonProps) {
  const audioRecorder = useAudioRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRefining, setIsRefining] = useState(false);

  const handleToggleRecording = async () => {
    if (audioRecorder.isRecording) {
      // 结束录音并转文字
      setIsTranscribing(true);
      let tempPath: string | null = null;
      try {
        const blob = await audioRecorder.stopRecording();
        if (!blob) {
          setIsTranscribing(false);
          return;
        }

        if (blob.size === 0) {
          setIsTranscribing(false);
          return;
        }

        // 获取 ASR 配置
        const settings = useConfigStore.getState().settings.audio;
        const asr = settings?.asr;

        if (!asr?.apiKey?.trim() || !asr.model?.trim()) {
          throw new Error("语音识别未配置，请在设置中配置 ASR");
        }

        // 将 Blob 转为 base64
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
        );

        // 保存临时文件用于转写
        const { writeBase64File, deleteFile, openAiTranscription } = await import(
          "@/lib/electron/electron-api"
        );
        const timestamp = Date.now();
        tempPath = `audio-recording-${timestamp}.webm`;
        await writeBase64File(tempPath, base64);

        // 调用语音识别 API
        const transcription = await openAiTranscription({
          apiKey: asr.apiKey.trim(),
          baseURL: asr.baseURL,
          model: asr.model.trim(),
          audioPath: tempPath,
          language: asr.language?.trim() || undefined,
          responseFormat: "json",
        });

        if (transcription.text && transcription.text.trim()) {
          let text = transcription.text.trim();

          // 获取语音输入优化选项
          const inputOptimization = settings?.inputOptimization;
          const shouldRefine = inputOptimization?.refineText ?? false;
          const shouldAutoSend = inputOptimization?.autoSend ?? false;

          // 如果启用了口语优化，调用模型整理文本
          if (shouldRefine) {
            try {
              setIsRefining(true);
              const { refineVoiceText } = await import("@/ai/voice-text-refine");
              const refinedText = await refineVoiceText(text);
              if (refinedText.trim()) {
                text = refinedText.trim();
              }
            } catch (err) {
              console.warn("文本整理失败，使用原始识别结果", err);
              // 整理失败时继续使用原始文本
            } finally {
              setIsRefining(false);
            }
          }

          // 回调返回文本和是否自动发送
          onTranscriptionComplete(text, shouldAutoSend);
        }

        // 删除临时文件
        if (tempPath) {
          await deleteFile(tempPath);
        }
      } catch (error) {
        console.error("语音识别失败", error);
        const message =
          error instanceof Error ? error.message : "语音识别失败，请检查网络或配置";
        alert(message);
      } finally {
        setIsTranscribing(false);
        setIsRefining(false);
      }
    } else {
      // 开始录音
      await audioRecorder.startRecording();
    }
  };

  return (
    <Button
      onClick={() => void handleToggleRecording()}
      disabled={disabled || isTranscribing || isRefining}
      size={audioRecorder.isRecording || isTranscribing || isRefining ? "sm" : "icon"}
      className={
        audioRecorder.isRecording || isTranscribing || isRefining
          ? "h-8 min-w-[80px] gap-1.5 rounded-full px-3"
          : "size-8 rounded-full"
      }
      variant="default"
      type="button"
    >
      {audioRecorder.isRecording ? (
        <>
          <AudioLines animate loop size={16} />
          <span className="text-xs">{audioRecorder.duration}s</span>
        </>
      ) : isRefining ? (
        <>
          <AudioLines animate loop size={16} />
          <span className="text-xs">优化中</span>
        </>
      ) : isTranscribing ? (
        <>
          <AudioLines animate loop size={16} />
          <span className="text-xs">转换中</span>
        </>
      ) : (
        <AudioLines size={16} />
      )}
      <span className="sr-only">
        {audioRecorder.isRecording
          ? "录音中"
          : isRefining
            ? "优化中"
            : isTranscribing
              ? "转换中"
              : "开始录音"}
      </span>
    </Button>
  );
}
