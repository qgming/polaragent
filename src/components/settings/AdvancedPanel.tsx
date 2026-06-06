// 高级设置面板（数据管理）
// src/components/settings/AdvancedPanel.tsx

import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openDataDir } from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { PageTitle } from "./settings-shared";

export function AdvancedPanel() {
  return (
    <section>
      <PageTitle title="数据管理" description="管理应用的本地数据存放位置。" />
      <DataDirectoryCard />
    </section>
  );
}

// 数据目录卡片：展示当前路径，并提供在系统文件管理器中打开的按钮
function DataDirectoryCard() {
  const dataDir = useConfigStore((state) => state.dataDir);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpening(true);
    setError(null);
    try {
      await openDataDir();
    } catch (err) {
      // 把底层真实错误透传出来，便于定位（权限/路径/未重建等）
      const detail =
        err instanceof Error ? err.message : String(err ?? "未知错误");
      setError(`无法打开数据目录：${detail}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mt-8 rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">数据目录</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          应用的配置、助手、技能与会话都保存在这里。
        </p>

        <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <code className="block break-all text-xs text-muted-foreground">
            {dataDir || "（尚未初始化）"}
          </code>
        </div>

        {error ? (
          <p className="mt-3 text-xs text-destructive">{error}</p>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Button onClick={() => void handleOpen()} disabled={opening || !dataDir}>
            {opening ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            在文件管理器中打开
          </Button>
        </div>
      </div>
    </div>
  );
}
