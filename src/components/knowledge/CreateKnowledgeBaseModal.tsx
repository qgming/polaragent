// 创建知识库弹窗
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from "@/components/ui/modal";
import { useKnowledgeStore } from "@/stores/knowledge-store";

interface CreateKnowledgeBaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateKnowledgeBaseModal({ open, onOpenChange }: CreateKnowledgeBaseModalProps) {
  const { t } = useTranslation("knowledge");
  const createKnowledgeBase = useKnowledgeStore((state) => state.createKnowledgeBase);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [chunkSize, setChunkSize] = useState(512);
  const [overlap, setOverlap] = useState(50);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    try {
      await createKnowledgeBase({
        name: name.trim(),
        description: description.trim() || undefined,
        chunkSize,
        overlap,
      });
      onOpenChange(false);
      setName("");
      setDescription("");
      setChunkSize(512);
      setOverlap(50);
    } catch (error) {
      console.error(t("form.createFailed"), error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>{t("form.createTitle")}</ModalTitle>
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
                placeholder={t("form.namePlaceholder")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                required
                autoFocus
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">{t("form.description")}</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("form.descriptionPlaceholder")}
                rows={3}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              />
            </label>

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
                  <option value={512}>{t("form.recommended", { value: 512 })}</option>
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
                  <option value={50}>{t("form.recommended", { value: 50 })}</option>
                  <option value={100}>100</option>
                </select>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim() || submitting}>
                {t("form.create")}
              </Button>
            </div>
          </form>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
