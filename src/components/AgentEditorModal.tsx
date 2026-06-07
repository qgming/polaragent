// 助手编辑模态窗：编辑助手的名称、头像、描述、模型与启用技能
// 从 AgentsPage 拆分而来，基于通用 Modal 组件居中弹出
// src/components/AgentEditorModal.tsx

import { Bot, Brain, Sparkles, Wrench, Zap } from "lucide-react";
import { useMemo, useState } from "react";

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
} from "@/lib/skill/skill-selection";
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

  // 已配置的供应商及其模型（供下拉选择）
  const providers = useConfigStore((state) => state.providers);
  const providerOptions = useMemo(
    () =>
      providers.providers.map((item) => ({
        value: item.id,
        label: item.name,
      })),
    [providers.providers],
  );
  // 当前所选供应商下的模型选项
  const modelOptions = useMemo(() => {
    const current = providers.providers.find((item) => item.id === provider);
    return (current?.models ?? []).map((item) => ({
      value: item.id,
      label: item.name || item.id,
    }));
  }, [providers.providers, provider]);

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
        <ModalTitle className="sr-only">助手详情</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">助手详情</span>
        </header>

        <ModalBody className="bg-background">
          <div className="space-y-6">
            {/* 头像与名称 */}
            <Field icon={Sparkles} label="头像与名称">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(true)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-input bg-muted/60 text-2xl transition-colors hover:border-ring hover:bg-muted"
                  title="点击选择 Emoji"
                >
                  {avatar || "⚡"}
                </button>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 flex-1 rounded-lg border border-input bg-background px-4 text-base outline-none transition-colors focus:border-ring"
                  placeholder="助手名称"
                />
              </div>
            </Field>

            {/* 助手描述 */}
            <Field icon={Bot} label="助手描述">
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="app-scrollbar min-h-[96px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder="描述这个助手适合处理什么任务"
              />
            </Field>

            {/* 供应商与模型 */}
            <div className="grid gap-6 sm:grid-cols-2">
              <Field icon={Zap} label="供应商">
                <SettingDropdown
                  value={provider}
                  placeholder="选择供应商"
                  options={providerOptions}
                  onChange={(value) => {
                    setProvider(value);
                    // 切换供应商后清空模型，避免残留不属于该供应商的模型 id
                    setModel("");
                  }}
                  className="h-11 w-full justify-between"
                />
              </Field>
              <Field icon={Brain} label="模型">
                {modelOptions.length > 0 ? (
                  <SettingDropdown
                    value={model}
                    placeholder="选择模型"
                    options={modelOptions}
                    onChange={setModel}
                    className="h-11 w-full justify-between"
                  />
                ) : (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus:border-ring"
                    placeholder="该供应商暂无模型，可手动输入"
                  />
                )}
              </Field>
            </div>

            {/* 系统提示词 */}
            <Field icon={Bot} label="系统提示词">
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="app-scrollbar min-h-[200px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder="定义这个助手的身份、行为边界、回答风格和工具使用策略"
              />
            </Field>

            {/* 技能列表 */}
            <Field icon={Wrench} label="启用技能">
              <div className="app-scrollbar max-h-[300px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm">
                {skills.length > 0 ? (
                  <>
                    <div className="flex min-h-[72px] items-center gap-4 border-b border-border bg-muted/30 px-5 py-4">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          全部技能
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          开启后运行时自动使用当前所有内置与已安装技能，包括之后新增的技能。
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
                    暂无可用技能
                  </div>
                )}
              </div>
            </Field>
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" onClick={() => onStartChat(agent.id)}>
            开始对话
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="default" onClick={save}>
            保存
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
