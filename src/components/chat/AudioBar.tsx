// 语音条组件 —— 微信风格的音频播放器
// 点击播放/暂停，显示波形和时长。

import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { fileUrl } from "@/lib/electron/electron-api";
import { cn } from "@/lib/utils";

interface AudioBarProps {
  audioPath: string;
  duration?: number; // 秒，可选（用于显示总时长）
  className?: string;
  variant?: "user" | "assistant"; // 用户消息右对齐，AI消息左对齐
}

export function AudioBar({ audioPath, duration, className, variant = "user" }: AudioBarProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 加载音频 URL
  useEffect(() => {
    let alive = true;
    void fileUrl(audioPath)
      .then((url) => {
        if (alive) setAudioUrl(url);
      })
      .catch(() => {
        if (alive) setAudioUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [audioPath]);

  // 播放/暂停
  const togglePlay = async () => {
    if (!audioRef.current || !audioUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        console.error("播放失败", err);
      }
    }
  };

  // 更新播放进度
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  // 播放结束
  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  // 格式化时间 mm:ss
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // 伪随机静态波形（基于时长生成）
  const waveformBars = Array.from({ length: 15 }, (_, i) => {
    const seed = (duration ?? 5) + i;
    const height = 30 + (seed % 7) * 10; // 30-90%
    return height;
  });

  const totalDuration = duration ?? audioRef.current?.duration ?? 0;
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg bg-muted px-3 py-2",
        variant === "user" ? "max-w-[260px]" : "max-w-[300px]",
        className,
      )}
    >
      {/* 播放/暂停按钮 */}
      <button
        type="button"
        onClick={() => void togglePlay()}
        disabled={!audioUrl}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background/60 hover:bg-background disabled:opacity-50"
      >
        {isPlaying ? (
          <Pause className="size-3.5 fill-current text-foreground" />
        ) : (
          <Play className="size-3.5 fill-current text-foreground" />
        )}
      </button>

      {/* 波形 + 进度条 */}
      <div className="relative flex min-w-0 flex-1 items-center gap-0.5">
        {waveformBars.map((height, index) => {
          const highlighted = progress > 0 && (index / waveformBars.length) * 100 < progress;
          return (
            <div
              key={index}
              className={cn(
                "w-1 rounded-full transition-colors",
                highlighted ? "bg-primary" : "bg-muted-foreground/30",
              )}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>

      {/* 时长 */}
      <span className="shrink-0 text-xs text-muted-foreground">
        {isPlaying ? formatTime(currentTime) : formatTime(totalDuration)}″
      </span>

      {/* 隐藏的 audio 元素 */}
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          preload="metadata"
        />
      ) : null}
    </div>
  );
}
