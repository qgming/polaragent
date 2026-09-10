export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  argsText: string;
  risk: "low" | "high";
  /** 审批来源：用户手工触发或 AI 预审 */
  source: "user" | "ai";
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
