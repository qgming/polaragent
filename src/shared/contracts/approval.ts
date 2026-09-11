export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  argsText: string;
  risk: "low" | "high";
  /** 审批来源：用户手工触发或 AI 预审 */
  source: "user" | "ai";
  /** AI 预审是否已出结论；拒绝/失败时请求仍挂起，卡片转为等用户覆盖 */
  aiReviewed?: boolean;
  reason?: string;
}

export type ApprovalDecision = "allow_once" | "always_allow" | "deny";

export interface ApprovalRecord {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: number;
  decidedBy: "user" | "ai";
  note?: string;
}
