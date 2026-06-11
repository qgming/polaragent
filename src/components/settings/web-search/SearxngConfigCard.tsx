// SearXNG 配置卡片
// 开源元搜索引擎，无需 API Key；配置实例地址（每行一个或逗号分隔）。

import { useEffect, useState } from "react";
import type { Settings } from "@/types/config";
import {
  ConfigCard,
  ExternalLink,
  SaveButton,
  labelClass,
  type SaveState,
} from "./web-search-shared";

export function SearxngConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.searxng ?? { instances: "" };
  const [instances, setInstances] = useState(config.instances ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const config = settings.webSearch?.searxng ?? { instances: "" };
    setInstances(config.instances ?? "");
  }, [settings.webSearch?.searxng]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        searxng: {
          instances: instances.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <ConfigCard
      title="SearXNG 配置"
      description="SearXNG 是开源元搜索引擎，无需 API Key。可使用公共实例或自建服务。留空则使用内置默认实例。"
    >
      <div>
        <label className={labelClass}>实例地址</label>
        <textarea
          value={instances}
          onChange={(e) => setInstances(e.target.value)}
          placeholder="https://searx.example.com&#10;https://search.example.org"
          rows={4}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          每行一个实例 URL，或用逗号分隔。留空使用默认实例。
        </p>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          💡 推荐公共实例：
          <span className="ml-1">
            <ExternalLink url="https://searx.be">searx.be</ExternalLink>
          </span>
          、
          <ExternalLink url="https://searx.work">searx.work</ExternalLink>
        </p>
      </div>

      <SaveButton state={saveState} onSave={handleSave} />
    </ConfigCard>
  );
}
