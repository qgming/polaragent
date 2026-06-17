// Serper 配置卡片
// API Key、国家代码（gl）、语言代码（hl）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@/types/config";
import {
  ApiKeyField,
  ConfigCard,
  ExternalLink,
  SaveButton,
  TextField,
  type SaveState,
} from "./web-search-shared";

export function SerperConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const config = settings.webSearch?.serper ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [gl, setGl] = useState(config.gl ?? "cn");
  const [hl, setHl] = useState(config.hl ?? "zh-cn");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const config = settings.webSearch?.serper ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setGl(config.gl ?? "cn");
    setHl(config.hl ?? "zh-cn");
  }, [settings.webSearch?.serper]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        serper: {
          apiKey: apiKey.trim(),
          gl: gl.trim(),
          hl: hl.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <ConfigCard
      title={t("webSearch.serperTitle")}
      description={
        <>
          {t("webSearch.visit")} <ExternalLink url="https://serper.dev">serper.dev</ExternalLink>{" "}
          {t("webSearch.signupQuota2500")}
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} />

      <TextField
        label={t("webSearch.countryCode")}
        value={gl}
        onChange={setGl}
        placeholder="cn"
        hint={t("webSearch.countryCodeHint")}
      />
      <TextField
        label={t("webSearch.languageCode")}
        value={hl}
        onChange={setHl}
        placeholder="zh-cn"
        hint={t("webSearch.languageCodeHint")}
      />

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
