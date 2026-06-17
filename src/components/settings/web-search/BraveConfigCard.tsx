// Brave Search 配置卡片
// API Key、国家代码、搜索语言。

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

export function BraveConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const config = settings.webSearch?.brave ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [country, setCountry] = useState(config.country ?? "");
  const [searchLang, setSearchLang] = useState(config.searchLang ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const config = settings.webSearch?.brave ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setCountry(config.country ?? "");
    setSearchLang(config.searchLang ?? "");
  }, [settings.webSearch?.brave]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        brave: {
          apiKey: apiKey.trim(),
          country: country.trim(),
          searchLang: searchLang.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <ConfigCard
      title={t("webSearch.braveTitle")}
      description={
        <>
          {t("webSearch.visit")}{" "}
          <ExternalLink url="https://brave.com/search/api/">Brave Search API</ExternalLink>{" "}
          {t("webSearch.signupQuota2000")}
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="BSA..." />

      <TextField
        label={t("webSearch.countryCodeOptional")}
        value={country}
        onChange={setCountry}
        placeholder="cn"
        hint={t("webSearch.countryCodeShortHint")}
      />
      <TextField
        label={t("webSearch.searchLanguage")}
        value={searchLang}
        onChange={setSearchLang}
        placeholder="zh"
        hint={t("webSearch.searchLanguageHint")}
      />

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
