import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { AskCard } from "@/renderer/components/assistant-ui/elements/ask-card";
import type { AskReply, AskRequest } from "@/shared/contracts/interaction";

interface AskSectionProps {
  requests: AskRequest[];
  onRespond?: (id: string, reply: AskReply) => void;
}

/**
 * 提问区：模型运行中途提出的问题，每条请求一张卡，挂在消息流尾部（与审批卡同区）。
 *
 * 卡片的状态只由 store 决定：作答后 store 立刻把请求移出列表（乐观，见 respondAsk），
 * ask-resolved 到达时同样移除 —— 所以这里没有「已决」态，只用 AnimatePresence
 * 把移除做成退出动画，避免卡片硬闪一下（与审批卡同一手法）。
 */
export function AskSection({ requests, onRespond }: AskSectionProps) {
  const { t } = useTranslation();

  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-2 pt-2">
      <AnimatePresence initial={false}>
        {requests.map((request) => (
          <motion.div
            key={request.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          >
            <AskCard
              questions={request.questions}
              labels={{
                title: t("ask.title"),
                waiting: t("ask.waiting"),
                placeholder: t("ask.placeholder"),
                multiSelect: t("ask.multiSelect"),
                progressOf: (current, total) => t("ask.progress", { current, total }),
                next: t("ask.next"),
                back: t("ask.back"),
                submit: t("ask.submit"),
                submitted: t("ask.submitted"),
                skipHint: t("ask.skipHint"),
              }}
              onSubmit={(answers) => onRespond?.(request.id, { outcome: "answered", answers })}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
