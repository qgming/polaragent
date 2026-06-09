// 录音 Hook —— 基于 MediaRecorder API
// 录制音频为 webm/opus，直接转文字，不保存文件。

import { useCallback, useEffect, useRef, useState } from "react";

interface UseAudioRecorderResult {
  isRecording: boolean;
  duration: number; // 秒
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  cancelRecording: () => void;
  error: string | null;
}

// 录音大小上限：50MB（防止长时间录音导致内存溢出）
const MAX_RECORDING_SIZE = 50 * 1024 * 1024;

export function useAudioRecorder(): UseAudioRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const totalSizeRef = useRef<number>(0);

  // 清理资源
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    totalSizeRef.current = 0;
    setDuration(0);
  }, []);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 使用 webm/opus（Chrome/Edge 原生支持，体积小）
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      totalSizeRef.current = 0;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          totalSizeRef.current += event.data.size;

          // 检查是否超过大小限制
          if (totalSizeRef.current > MAX_RECORDING_SIZE) {
            mediaRecorder.stop();
            setError(`录音已达到大小上限（${Math.round(MAX_RECORDING_SIZE / 1024 / 1024)}MB），已自动停止`);
            return;
          }

          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start(100); // 每 100ms 触发一次 dataavailable
      startTimeRef.current = Date.now();
      setIsRecording(true);

      // 计时器
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (err) {
      console.error("启动录音失败:", err);
      const message = err instanceof Error ? err.message : "无法访问麦克风";
      setError(message);
      cleanup();
    }
  }, [cleanup]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (!mediaRecorderRef.current || !isRecording) return null;

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current!;

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        cleanup();
        setIsRecording(false);
        resolve(blob);
      };

      recorder.stop();
    });
  }, [isRecording, cleanup]);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
    cleanup();
    setIsRecording(false);
  }, [isRecording, cleanup]);

  return {
    isRecording,
    duration,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  };
}
