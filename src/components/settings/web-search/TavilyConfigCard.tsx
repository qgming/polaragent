// Tavily 配置卡片
// API Key、搜索深度、限定/排除域名，以及完整内容增强选项。

import { useEffect, useState } from "react";
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
      title="Tavily 配置"
      description={
        <>
          访问 <ExternalLink url="https://tavily.com">tavily.com</ExternalLink>{" "}
          注册并获取 API Key。免费账户每月 1,000 次搜索。
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="tvly-..." />

      <div>
        <label className={labelClass}>搜索深度</label>
        <SettingDropdown
          value={searchDepth}
          onChange={(v) => setSearchDepth(v as "basic" | "advanced")}
          options={[
            { value: "basic", label: "基础（更快）" },
            { value: "advanced", label: "深度（更全面）" },
          ]}
          className="w-full"
        />
      </div>

      <TextField
        label="限定域名（可选）"
        value={includeDomains}
        onChange={setIncludeDomains}
        placeholder="example.com, docs.example.com"
        hint="仅搜索这些域名，多个用逗号分隔。"
      />
      <TextField
        label="排除域名（可选）"
        value={excludeDomains}
        onChange={setExcludeDomains}
        placeholder="spam.com, ads.com"
        hint="排除这些域名，多个用逗号分隔。"
      />

      <ContentOptionsGroup>
        <CheckboxRow checked={includeAnswer} onChange={setIncludeAnswer}>
          包含 AI 生成的答案
        </CheckboxRow>
        <CheckboxRow checked={includeRawContent} onChange={setIncludeRawContent}>
          包含原始网页内容
        </CheckboxRow>
        <CheckboxRow checked={includeImages} onChange={setIncludeImages}>
          包含图片链接
        </CheckboxRow>
      </ContentOptionsGroup>

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
