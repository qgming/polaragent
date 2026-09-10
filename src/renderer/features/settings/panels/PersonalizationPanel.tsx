import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Textarea } from "@/renderer/components/ui/textarea";
import { cn } from "@/renderer/lib/utils";
import { PanelLoading, settingsTextarea } from "../settings-shared";

export function PersonalizationPanel() {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // 载入 AGENTS.md；失败按空文档处理，避免面板卡在加载态
  useEffect(() => {
    let cancelled = false;
    void window.polaragent.agents
      .read()
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 保存成功提示 1.5s 后自动消失
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1500);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const handleSave = async () => {
    if (content === null) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await window.polaragent.agents.write(content);
      setDirty(false);
      setSaved(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (content === null) return <PanelLoading />;

  return (
    <div className="space-y-3">
      <div>
        <h3 className={typeEyebrow}>{t("settings.agentsMd")}</h3>
        <p className="mt-1 text-xs text-foreground/45">{t("settings.agentsMdDesc")}</p>
      </div>
      <Textarea
        value={content}
        placeholder={t("settings.agentsMdPlaceholder")}
        aria-label={t("settings.agentsMd")}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        className={cn(settingsTextarea, "min-h-[300px] resize-y")}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-foreground/45">
          {saved ? (
            <>
              <Check className="size-3.5 text-foreground/70" aria-hidden="true" />
              {t("settings.agentsMdSaved")}
            </>
          ) : saveFailed ? (
            <span className="text-destructive">{t("errors.generic")}</span>
          ) : null}
        </span>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
