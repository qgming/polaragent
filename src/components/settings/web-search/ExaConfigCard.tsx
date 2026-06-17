// Exa 配置卡片
// API Key、搜索类型、Autoprompt、分类过滤，以及完整内容增强选项。

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

export function ExaConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const config = settings.webSearch?.exa ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [type, setType] = useState<"neural" | "keyword">(config.type ?? "neural");
  const [useAutoprompt, setUseAutoprompt] = useState(config.useAutoprompt ?? false);
  const [category, setCategory] = useState(config.category ?? "");
  const [includeText, setIncludeText] = useState(config.includeText ?? false);
  const [includeHighlights, setIncludeHighlights] = useState(config.includeHighlights ?? false);
  const [includeSummary, setIncludeSummary] = useState(config.includeSummary ?? false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const config = settings.webSearch?.exa ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setType(config.type ?? "neural");
    setUseAutoprompt(config.useAutoprompt ?? false);
    setCategory(config.category ?? "");
    setIncludeText(config.includeText ?? false);
    setIncludeHighlights(config.includeHighlights ?? false);
    setIncludeSummary(config.includeSummary ?? false);
  }, [settings.webSearch?.exa]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        exa: {
          apiKey: apiKey.trim(),
          type,
          useAutoprompt,
          category: category.trim(),
          includeText,
          includeHighlights,
          includeSummary,
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <ConfigCard
      title={t("webSearch.exaTitle")}
      description={
        <>
          {t("webSearch.visit")} <ExternalLink url="https://exa.ai">exa.ai</ExternalLink>{" "}
          {t("webSearch.signupQuota1000")}
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="exa_..." />

      <div>
        <label className={labelClass}>{t("webSearch.searchType")}</label>
        <SettingDropdown
          value={type}
          onChange={(v) => setType(v as "neural" | "keyword")}
          options={[
            { value: "neural", label: t("webSearch.typeNeural") },
            { value: "keyword", label: t("webSearch.typeKeyword") },
          ]}
          className="w-full"
        />
      </div>

      <div>
        <label className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            type="checkbox"
            checked={useAutoprompt}
            onChange={(e) => setUseAutoprompt(e.target.checked)}
            className="size-4"
          />
          {t("webSearch.useAutoprompt")}
        </label>
      </div>

      <TextField
        label={t("webSearch.categoryFilter")}
        value={category}
        onChange={setCategory}
        placeholder="news, research, company"
      />

      <ContentOptionsGroup>
        <CheckboxRow checked={includeText} onChange={setIncludeText}>
          {t("webSearch.includeText")}
        </CheckboxRow>
        <CheckboxRow checked={includeHighlights} onChange={setIncludeHighlights}>
          {t("webSearch.includeHighlights")}
        </CheckboxRow>
        <CheckboxRow checked={includeSummary} onChange={setIncludeSummary}>
          {t("webSearch.includeSummary")}
        </CheckboxRow>
      </ContentOptionsGroup>

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
