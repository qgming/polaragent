export type McpTransport = "stdio" | "streamable-http" | "sse";

export type McpInstallStatus = "unknown" | "checking" | "installed" | "failed";

export interface McpInstallCheck {
  status: McpInstallStatus;
  checkedAt?: number;
  message?: string;
  toolCount?: number;
}

export interface McpConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea";
  required?: boolean;
  target: "env" | "headers" | "args" | "url";
  placeholder?: string;
  description?: string;
}

export interface McpServerConfig {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpDiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpToolConfig {
  id: string;
  name: string;
  description: string;
  type: "mcp";
  origin: "builtin" | "market" | "custom";
  version?: string;
  category?: string;
  icon?: string;
  tags?: string[];
  source?: string;
  server: McpServerConfig;
  discoveredTools?: McpDiscoveredTool[];
  disabledToolNames?: string[];
  installCheck?: McpInstallCheck;
  configFields?: McpConfigField[];
  notes?: string;
}
