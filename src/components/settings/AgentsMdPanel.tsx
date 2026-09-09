// AGENTS.md 设置面板：仅内容编辑
// src/components/settings/AgentsMdPanel.tsx

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readAgentsMd, writeAgentsMd } from "@/lib/electron/electron-api";
import { invalidateAgentsMdCache } from "@/ai/agents-md";
import { PageTitle } from "./settings-shared";

export function AgentsMdPanel({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation("settings");
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      try {
        const text = await readAgentsMd();
        if (!cancelled) setContent(text);
      } catch (error) {
        if (!cancelled) {
          console.warn("读取 AGENTS.md 失败:", error);
          setContent("");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setStatus("");
    try {
      await writeAgentsMd(content);
      invalidateAgentsMdCache();
      setStatus(t("agentsMd.saved"));
    } catch (error) {
      console.error("保存 AGENTS.md 失败:", error);
      setStatus(t("agentsMd.saveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {!embedded ? (
        <PageTitle title={t("agentsMd.title")} description={t("agentsMd.description")} />
      ) : (
        <h3 className="text-sm font-semibold text-muted-foreground">{t("agentsMd.title")}</h3>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" />
              {t("agentsMd.content")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t("agentsMd.contentDesc")}</p>
          </div>
          <Button size="sm" disabled={isSaving || isLoading} onClick={() => void handleSave()}>
            {isSaving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3.5" />
            )}
            {t("agentsMd.save")}
          </Button>
        </div>
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("common:loading", "加载中...")}
          </div>
        ) : (
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("agentsMd.contentPlaceholder")}
            className="app-scrollbar min-h-[360px] font-mono text-sm"
          />
        )}
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      </section>
    </div>
  );
}
