// Serper 配置卡片
// API Key、国家代码（gl）、语言代码（hl）。

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

export function SerperConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
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
      title="Serper 配置"
      description={
        <>
          访问 <ExternalLink url="https://serper.dev">serper.dev</ExternalLink>{" "}
          注册并获取 API Key。免费账户每月 2,500 次搜索。
        </>
      }
    >
      <ApiKeyField value={apiKey} onChange={setApiKey} />

      <TextField
        label="国家代码（gl）"
        value={gl}
        onChange={setGl}
        placeholder="cn"
        hint="如 cn（中国）、us（美国）、jp（日本）"
      />
      <TextField
        label="语言代码（hl）"
        value={hl}
        onChange={setHl}
        placeholder="zh-cn"
        hint="如 zh-cn（简体中文）、en（英语）、ja（日语）"
      />

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
