// Tavily 配置卡片
// API Key、搜索深度、限定/排除域名，以及完整内容增强选项。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@/types/config";
import { SettingDropdown } from "../settings-shared";
import {
  ApiKeyField,
  CheckboxRow,
  ConfigCard,
  ContentOptionsGroup,
  ExternalLink,
  SaveButton,
  TextField,
  labelClass,
  type SaveState,
} from "./web-search-shared";

export function TavilyConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const config = settings.webSearch?.tavily ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [searchDepth, setSearchDepth] = useState<"basic" | "advanced">(
    config.searchDepth ?? "basic",
  );
  const [includeDomains, setIncludeDomains] = useState(config.includeDomains ?? "");
  const [excludeDomains, setExcludeDomains] = useState(config.excludeDomains ?? "");
  const [includeAnswer, setIncludeAnswer] = useState(config.includeAnswer ?? false);
  const [includeRawContent, setIncludeRawContent] = useState(config.includeRawContent ?? false);
  const [includeImages, setIncludeImages] = useState(config.includeImages ?? false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const config = settings.webSearch?.tavily ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setSearchDepth(config.searchDepth ?? "basic");
    setIncludeDomains(config.includeDomains ?? "");
    setExcludeDomains(config.excludeDomains ?? "");
    setIncludeAnswer(config.includeAnswer ?? false);
    setIncludeRawContent(config.includeRawContent ?? false);
    setIncludeImages(config.includeImages ?? false);
  }, [settings.webSearch?.tavily]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        tavily: {
          apiKey: apiKey.trim(),
          searchDepth,
          includeDomains: includeDomains.trim(),
          excludeDomains: excludeDomains.trim(),
          includeAnswer,
          includeRawContent,
          includeImages,
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <ConfigCard
      title={t("webSearch.tavilyTitle")}
      description={
        <>
          {t("webSearch.visit")} <ExternalLink url="https://tavily.com">tavily.com</ExternalLink>{" "}
          {t("webSearch.signupQuota1000")}
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="tvly-..." />

      <div>
        <label className={labelClass}>{t("webSearch.searchDepth")}</label>
        <SettingDropdown
          value={searchDepth}
          onChange={(v) => setSearchDepth(v as "basic" | "advanced")}
          options={[
            { value: "basic", label: t("webSearch.depthBasic") },
            { value: "advanced", label: t("webSearch.depthAdvanced") },
          ]}
          className="w-full"
        />
      </div>

      <TextField
        label={t("webSearch.includeDomains")}
        value={includeDomains}
        onChange={setIncludeDomains}
        placeholder="example.com, docs.example.com"
        hint={t("webSearch.includeDomainsHint")}
      />
      <TextField
        label={t("webSearch.excludeDomains")}
        value={excludeDomains}
        onChange={setExcludeDomains}
        placeholder="spam.com, ads.com"
        hint={t("webSearch.excludeDomainsHint")}
      />

      <ContentOptionsGroup>
        <CheckboxRow checked={includeAnswer} onChange={setIncludeAnswer}>
          {t("webSearch.includeAnswer")}
        </CheckboxRow>
        <CheckboxRow checked={includeRawContent} onChange={setIncludeRawContent}>
          {t("webSearch.includeRawContent")}
        </CheckboxRow>
        <CheckboxRow checked={includeImages} onChange={setIncludeImages}>
          {t("webSearch.includeImages")}
        </CheckboxRow>
      </ContentOptionsGroup>

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
