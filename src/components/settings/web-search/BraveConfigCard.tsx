// Brave Search 配置卡片
// API Key、国家代码、搜索语言。

import { useEffect, useState } from "react";
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
      title="Brave Search 配置"
      description={
        <>
          访问{" "}
          <ExternalLink url="https://brave.com/search/api/">Brave Search API</ExternalLink>{" "}
          注册并获取 API Key。免费账户每月 2,000 次搜索。
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="BSA..." />

      <TextField
        label="国家代码（可选）"
        value={country}
        onChange={setCountry}
        placeholder="cn"
        hint="如 cn（中国）、us（美国）"
      />
      <TextField
        label="搜索语言（可选）"
        value={searchLang}
        onChange={setSearchLang}
        placeholder="zh"
        hint="如 zh（中文）、en（英语）"
      />

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
