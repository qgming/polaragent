// 知识库设置弹窗
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from "@/components/ui/modal";
import { Switch } from "@/components/ui/switch";
import type { KnowledgeBase } from "@/lib/knowledge";
import { useKnowledgeStore } from "@/stores/knowledge-store";

interface KnowledgeSettingsModalProps {
  knowledgeBase: KnowledgeBase;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KnowledgeSettingsModal({
  knowledgeBase,
  open,
  onOpenChange,
}: KnowledgeSettingsModalProps) {
  const { t } = useTranslation("knowledge");
  const updateKnowledgeBase = useKnowledgeStore((state) => state.updateKnowledgeBase);
  const [name, setName] = useState(knowledgeBase.name);
  const [description, setDescription] = useState(knowledgeBase.description || "");
  const [enabled, setEnabled] = useState(knowledgeBase.enabled);
  const [chunkSize, setChunkSize] = useState(knowledgeBase.chunkSize);
  const [overlap, setOverlap] = useState(knowledgeBase.overlap);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    try {
      await updateKnowledgeBase(knowledgeBase.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        enabled,
        chunkSize,
        overlap,
      });
      onOpenChange(false);
    } catch (error) {
      console.error(t("form.updateFailed"), error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="lg">
        <ModalHeader>
          <ModalTitle>{t("form.settingsTitle")}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                {t("form.name")} <span className="text-destructive">*</span>
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                required
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">{t("form.description")}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              />
            </label>

            <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="text-sm text-muted-foreground">{t("form.enabled")}</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t("form.chunkSize")}
                </span>
                <select
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                >
                  <option value={256}>256</option>
                  <option value={512}>512</option>
                  <option value={1024}>1024</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t("form.overlap")}
                </span>
                <select
                  value={overlap}
                  onChange={(e) => setOverlap(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                >
                  <option value={0}>0</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </label>
            </div>

            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              {t("form.rebuildNotice")}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim() || submitting}>
                {t("common:save")}
              </Button>
            </div>
          </form>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
