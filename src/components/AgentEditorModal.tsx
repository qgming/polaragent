// 助手编辑模态窗：编辑助手的名称、头像、描述、模型与启用技能
// 从 AgentsPage 拆分而来，基于通用 Modal 组件居中弹出
// src/components/AgentEditorModal.tsx

import { Bot, Brain, Sparkles, Wrench, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Field, SettingDropdown } from "@/components/settings/settings-shared";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import {
  hasAllSkills,
  normalizeSkillSelection,
  ALL_SKILLS_ID,
} from "@/lib/skill";
import { useConfigStore } from "@/stores/config-store";
import type { AgentConfig } from "@/types/config";

export function AgentEditorModal({
  agent,
  skills,
  onClose,
  onSave,
  onStartChat,
}: {
  agent: AgentConfig;
  skills: Array<{ id: string; name: string; description: string; enabled: boolean }>;
  onClose: () => void;
  onSave: (agent: AgentConfig) => void;
  onStartChat: (agentId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const [name, setName] = useState(agent.name);
  const [avatar, setAvatar] = useState(agent.avatar || "⚡");
  const [description, setDescription] = useState(agent.description);
  const [provider, setProvider] = useState(agent.config.provider);
  const [model, setModel] = useState(agent.config.model);
  const [systemPrompt, setSystemPrompt] = useState(agent.config.systemPrompt);
  const [enabledSkills, setEnabledSkills] = useState<string[]>(
    normalizeSkillSelection(agent.config.enabledSkills),
  );
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const allSkillsEnabled = hasAllSkills(enabledSkills);

  // 已配置的模型服务及其模型（供下拉选择）
  const providers = useConfigStore((state) => state.providers);
  const providerOptions = useMemo(
    () => [
      { value: "", label: t("editor.followModelSettings") },
      ...providers.providers.map((item) => ({
        value: item.id,
        label: item.name,
      })),
    ],
    [providers.providers, t],
  );
  // 当前所选模型服务下的模型选项
  const modelOptions = useMemo(() => {
    if (!provider) {
      return [{ value: "", label: t("editor.followDefaultModel") }];
    }
    const current = providers.providers.find((item) => item.id === provider);
    return (current?.models ?? []).map((item) => ({
      value: item.id,
      label: item.name || item.id,
    }));
  }, [providers.providers, provider, t]);

  const toggleSkill = (skillId: string) => {
    setEnabledSkills((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId],
    );
  };

  const toggleAllSkills = (checked: boolean) => {
    setEnabledSkills(checked ? [ALL_SKILLS_ID] : []);
  };

  const save = () => {
    onSave({
      ...agent,
      name: name.trim() || agent.name,
      avatar: avatar.trim() || "⚡",
      description: description.trim(),
      config: {
        ...agent.config,
        provider,
        model: model.trim(),
        systemPrompt: systemPrompt.trim(),
        enabledSkills: normalizeSkillSelection(enabledSkills),
      },
    });
  };

  return (
    <Modal open onOpenChange={(next) => { if (!next) onClose(); }}>
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">{t("editor.title")}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{t("editor.title")}</span>
        </header>

        <ModalBody className="bg-background">
          <div className="space-y-6">
            {/* 头像与名称 */}
            <Field icon={Sparkles} label={t("editor.avatarName")}>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(true)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-input bg-muted/60 text-2xl transition-colors hover:border-ring hover:bg-muted"
                  title={t("editor.pickEmoji")}
                >
                  {avatar || "⚡"}
                </button>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 flex-1 rounded-lg border border-input bg-background px-4 text-base outline-none transition-colors focus:border-ring"
                  placeholder={t("editor.namePlaceholder")}
                />
              </div>
            </Field>

            {/* 助手描述 */}
            <Field icon={Bot} label={t("editor.description")}>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="app-scrollbar min-h-[96px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder={t("editor.descriptionPlaceholder")}
              />
            </Field>

            {/* 模型服务与模型 */}
            <div className="grid gap-6 sm:grid-cols-2">
              <Field icon={Zap} label={t("editor.modelProvider")}>
                <SettingDropdown
                  value={provider}
                  placeholder={t("editor.selectProvider")}
                  options={providerOptions}
                  onChange={(value) => {
                    setProvider(value);
                    // 切换模型服务后清空模型，避免残留不属于该服务的模型 id
                    setModel("");
                  }}
                  className="h-11 w-full justify-between"
                />
              </Field>
              <Field icon={Brain} label={t("editor.model")}>
                {modelOptions.length > 0 ? (
                  <SettingDropdown
                    value={model}
                    placeholder={t("editor.selectModel")}
                    options={modelOptions}
                    onChange={setModel}
                    className="h-11 w-full justify-between"
                  />
                ) : (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus:border-ring"
                    placeholder={t("editor.manualModelPlaceholder")}
                  />
                )}
              </Field>
            </div>

            {/* 系统提示词 */}
            <Field icon={Bot} label={t("editor.systemPrompt")}>
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="app-scrollbar min-h-[200px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder={t("editor.systemPromptPlaceholder")}
              />
            </Field>

            {/* 技能列表 */}
            <Field icon={Wrench} label={t("editor.enabledSkills")}>
              <div className="app-scrollbar max-h-[300px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm">
                {skills.length > 0 ? (
                  <>
                    <div className="flex min-h-[72px] items-center gap-4 border-b border-border bg-muted/30 px-5 py-4">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          {t("editor.allSkills")}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {t("editor.allSkillsDescription")}
                        </span>
                      </span>
                      <Switch
                        checked={allSkillsEnabled}
                        onCheckedChange={toggleAllSkills}
                      />
                    </div>
                    {skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="flex min-h-[68px] items-center gap-4 border-b border-border px-5 py-4 transition-colors last:border-b-0 hover:bg-muted/30"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">
                            {skill.name}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {skill.description}
                          </span>
                        </span>
                        <Switch
                          checked={
                            allSkillsEnabled || enabledSkills.includes(skill.id)
                          }
                          disabled={allSkillsEnabled}
                          onCheckedChange={() => toggleSkill(skill.id)}
                        />
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">
                    {t("editor.noSkills")}
                  </div>
                )}
              </div>
            </Field>
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" onClick={() => onStartChat(agent.id)}>
            {t("editor.startChat")}
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button variant="default" onClick={save}>
            {t("common:save")}
          </Button>
        </ModalFooter>
      </ModalContent>

      <EmojiPicker
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onSelect={(emoji) => setAvatar(emoji)}
      />
    </Modal>
  );
}
