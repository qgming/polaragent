// PolarAgent Composer 扩展条：工作目录 / 附加文件
// src/components/assistant-ui/extensions/PolarComposerExtras.tsx

import { FolderOpen, Paperclip, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  pickImageFile,
  pickTextFile,
  pickWorkingDirectory,
} from "@/lib/electron/electron-api";
import { useChatStore } from "@/stores/chat-store";
import { useComposerExtrasStore } from "@/runtime/composer-extras-store";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function PolarComposerExtras({ threadId }: { threadId: string }) {
  const filePaths = useComposerExtrasStore((s) => s.filePaths);
  const addFilePath = useComposerExtrasStore((s) => s.addFilePath);
  const removeFilePath = useComposerExtrasStore((s) => s.removeFilePath);

  const workingDir = useChatStore(
    (s) => s.threads.find((t) => t.id === threadId)?.workingDir ?? s.workingDir ?? "",
  );

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (!dir || !threadId) return;
    useChatStore.getState().setThreadWorkingDir(threadId, dir);
  };

  const handlePickFile = async (kind: "text" | "image") => {
    const path = kind === "image" ? await pickImageFile() : await pickTextFile();
    if (path) addFilePath(path);
  };

  return (
    <div className="flex flex-col gap-1 px-3 pb-1">
      {(filePaths.length > 0 || workingDir) && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {workingDir ? (
            <span className="inline-flex max-w-48 items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5">
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">{basename(workingDir)}</span>
            </span>
          ) : null}
          {filePaths.map((path) => (
            <span
              key={path}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5"
            >
              <Paperclip className="size-3" />
              {basename(path)}
              <button
                type="button"
                onClick={() => removeFilePath(path)}
                className="hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handlePickDir}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>工作目录</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7">
              <Paperclip className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void handlePickFile("image")}>
              图片
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handlePickFile("text")}>
              文本文件
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
