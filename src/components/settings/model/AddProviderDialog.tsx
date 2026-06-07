// 添加供应商弹窗
import { useState } from "react";
import { Bot, KeyRound, Loader2, Plug, Settings2, X } from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalTitle,
} from "@/components/ui/modal";
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
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalContent size="md" showCloseButton={false} className="max-w-[460px] rounded-xl bg-card">
        <ModalTitle className="sr-only">添加供应商</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Settings2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">添加供应商</span>

          <div className="ml-auto flex h-full items-center gap-0.5">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!name.trim() || creating}
              title={creating ? "创建中..." : "创建"}
              className="flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              创建
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <ModalBody className="space-y-4">
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
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
