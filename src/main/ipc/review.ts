import { IPC } from "@/shared/contracts/ipc";
import { reviewSummary } from "../review/service";
import { handle } from "./handler";

/** 审查域通道：右侧面板「审查」用，按会话汇总本次的写操作 */
export function registerReviewIpc(): void {
  handle(IPC.review.summary, "汇总会话改动", (request: { sessionId: string }) =>
    reviewSummary(request.sessionId),
  );
}
