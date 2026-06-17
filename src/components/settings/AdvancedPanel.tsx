// 高级设置面板（数据管理）
// src/components/settings/AdvancedPanel.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openDataDir } from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { PageTitle } from "./settings-shared";

export function AdvancedPanel() {
  const { t } = useTranslation("settings");

  return (
    <section>
      <PageTitle title={t("data.title")} description={t("data.description")} />
      <DataDirectoryCard />
    </section>
  );
}

// 数据目录卡片：展示当前路径，并提供在系统文件管理器中打开的按钮
function DataDirectoryCard() {
  const { t } = useTranslation("settings");
  const dataDir = useConfigStore((state) => state.dataDir);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpening(true);
    setError(null);
    try {
      await openDataDir();
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : String(err ?? t("data.unknownError"));
      setError(`${t("data.openFailed")}${detail}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mt-8 rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("data.dataDirectory")}</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("data.dataDirectoryDesc")}
        </p>

        <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <code className="block break-all text-xs text-muted-foreground">
            {dataDir || t("data.uninitialized")}
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
            {t("data.openInFileManager")}
          </Button>
        </div>
      </div>
    </div>
  );
}
