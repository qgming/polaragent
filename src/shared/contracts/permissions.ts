/** 「始终允许」规则的展示形态：工具名 + 可选匹配模式（命令首词或路径首段） */
export interface PermissionRuleView {
  toolName: string;
  pattern?: string;
  createdAt: number;
}
