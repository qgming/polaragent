// 添加供应商弹窗
import { useState } from "react";
import { Bot, KeyRound, Loader2, Plug, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderConfig } from "@/types/config";
import { Field, SettingDropdown } from "../settings-shared";
import { PROVIDER_TYPE_OPTIONS, makeProviderId } from "./provider-meta";

export function AddProviderDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (provider: ProviderConfig) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] =
    useState<ProviderConfig["type"]>("openai-completions");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setCreating(true);
    await onCreate({
      id: makeProviderId(),
      name: name.trim(),
      type,
      enabled: false,
      config: {
        apiKey: apiKey.trim(),
        baseURL: baseURL.trim(),
        defaultModel: "",
      },
      models: [],
    });
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-[460px] rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold">添加供应商</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <Field icon={Bot} label="名称">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 DeepSeek、Claude 代理"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
          <Field icon={Settings2} label="接口格式">
            <SettingDropdown
              value={type}
              options={PROVIDER_TYPE_OPTIONS}
              onChange={(value) => setType(value as ProviderConfig["type"])}
              className="h-11 w-full justify-between"
            />
          </Field>
          <Field icon={Plug} label="Base URL">
            <input
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.deepseek.com"
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
          <Field icon={KeyRound} label="API Key">
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              placeholder="sk-..."
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring"
            />
          </Field>
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || creating} onClick={() => void submit()}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            创建
          </Button>
        </footer>
      </div>
    </div>
  );
}
