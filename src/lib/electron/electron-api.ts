import { mcpSdkCallTool, mcpSdkListTools } from "@/lib/mcp-sdk-client";
import type { McpServerConfig, McpToolConfig } from "@/types/config";

export interface LlmChatMessage {
  role: "assistant" | "user";
  content: string;
}

export interface LlmChatCompletionRequest {
  requestId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: LlmChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object";
}

export interface LlmChatCompletionResponse {
  content: string;
  model: string;
  usage: { input: number; output: number; totalTokens: number };
}

export interface LlmChatStreamEvent {
  requestId: string;
  delta?: string;
  done: boolean;
  error?: string;
  model?: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

function api() {
  if (!window.polaragent) throw new Error("Electron preload API 未初始化");
  return window.polaragent;
}

export function isElectronRuntime(): boolean {
  return Boolean(window.polaragent);
}

export async function chatCompletionStream(
  request: LlmChatCompletionRequest,
  handlers: {
    onDelta: (delta: string) => void;
    onDone: (result: LlmChatCompletionResponse) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  const requestId =
    request.requestId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let content = "";
  let settled = false;

  const unlisten = api().llm.onChatStream((event) => {
    if (event.requestId !== requestId) return;
    if (event.error) {
      settled = true;
      handlers.onError(event.error);
      unlisten();
      return;
    }
    if (event.delta) {
      content += event.delta;
      handlers.onDelta(event.delta);
    }
    if (event.done) {
      settled = true;
      handlers.onDone({
        content,
        model: event.model ?? request.model,
        usage: event.usage ?? { input: 0, output: 0, totalTokens: 0 },
      });
      unlisten();
    }
  });

  try {
    await api().llm.chatCompletionStream({ ...request, requestId });
  } catch (error) {
    if (!settled) handlers.onError(error instanceof Error ? error.message : String(error));
    unlisten();
  }
}

export function chatCompletion(request: LlmChatCompletionRequest) {
  return api().llm.chatCompletion(request);
}

export function listRemoteModels(baseUrl: string, apiKey: string) {
  return api().llm.listModels(baseUrl, apiKey);
}

export const pickWorkingDirectory = () => api().app.pickWorkingDirectory();
export const pickTextFile = () => api().app.pickTextFile();
export const getDataDir = () => api().app.getDataDir();
export const openDataDir = () => api().app.openDataDir();
export const openPath = (path: string) => api().app.openPath(path);
export const openExternal = (url: string) => api().app.openExternal(url);
export const fileUrl = (path: string) => api().app.fileUrl(path);
export const ensureDataDir = () => api().app.ensureDataDir();
export const listDirectory = (path: string) => api().fs.listDirectory(path);
export const listDirectoryEntries = (path: string) => api().fs.listDirectoryEntries(path);
export const readFile = (path: string) => api().fs.readFile(path);
export const fileExists = (path: string): Promise<boolean> => api().fs.exists(path);
export const writeFile = (path: string, content: string) => api().fs.writeFile(path, content);
export const createDirectory = (path: string) => api().fs.createDirectory(path);
export const deleteFile = (path: string) => api().fs.deletePath(path);
export const installSkillFromGit = (repoUrl: string) => api().skills.installFromGit(repoUrl);
export const installSkillFromLocal = (sourcePath: string) => api().skills.installFromLocal(sourcePath);
export const listSkills = (skillType: "builtin" | "custom") => api().skills.list(skillType);
export const readSkillMetadata = (skillId: string) => api().skills.readMetadata(skillId);

export async function readConfig<T = any>(fileName: string): Promise<T> {
  return JSON.parse(await api().config.read(fileName)) as T;
}

export function writeConfig(fileName: string, content: any): Promise<void> {
  return api().config.write(fileName, JSON.stringify(content, null, 2));
}

export interface MarketSkill {
  id: string;
  name: string;
  description: string;
  installs?: number;
  stars?: number;
  source?: string;
  repoUrl?: string;
  category?: string;
  icon?: string;
}

export interface MarketSearchResult {
  skills: MarketSkill[];
  total?: number;
  page?: number;
  hasMore?: boolean;
}

export interface MarketSearchParams {
  query: string;
  apiKey?: string;
  page?: number;
  limit?: number;
  sortBy?: "stars" | "recent";
  category?: string;
  occupation?: string;
}

function pickString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["skills", "data", "results", "items", "prompts"]) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const nestedKey of ["skills", "results", "items", "prompts"]) {
          if (Array.isArray(nested[nestedKey])) return nested[nestedKey] as unknown[];
        }
      }
    }
  }
  return [];
}

function normalizeSkill(raw: unknown, index: number): MarketSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = pickString(obj, ["name", "title", "displayName", "slug"]) ?? "未命名技能";
  const id = pickString(obj, ["id", "slug", "fullName", "repo"]) ?? `${name}-${index}`;
  const repoUrl = pickString(obj, ["repoUrl", "repository", "url", "githubUrl", "html_url"]);
  return {
    id,
    name,
    description: pickString(obj, ["description", "summary", "desc"]) ?? "",
    installs: pickNumber(obj, ["installs", "installCount", "downloads"]),
    stars: pickNumber(obj, ["stars", "stargazers", "starCount"]),
    source:
      pickString(obj, ["source", "fullName", "owner", "repo"]) ??
      (repoUrl ? repoUrl.replace(/^https?:\/\/github\.com\//, "") : undefined),
    repoUrl,
    category: pickString(obj, ["category", "categorySlug"]),
    icon: pickString(obj, ["icon", "emoji"]),
  };
}

export async function searchMarketSkills(params: MarketSearchParams): Promise<MarketSearchResult> {
  const payload = JSON.parse(
    await api().network.skillsMarketSearch({
      apiKey: params.apiKey || undefined,
      query: params.query,
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy,
      category: params.category,
      occupation: params.occupation,
    }),
  ) as unknown;
  const skills = extractArray(payload)
    .map((item, index) => normalizeSkill(item, index))
    .filter((skill): skill is MarketSkill => skill !== null);
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const pagination = (obj.pagination as Record<string, unknown> | undefined) ?? obj;
  return {
    skills,
    total: pickNumber(pagination, ["total", "totalCount", "count"]),
    page: pickNumber(pagination, ["page", "currentPage"]),
    hasMore: typeof pagination.hasMore === "boolean" ? pagination.hasMore : undefined,
  };
}

export interface MarketAgent {
  id: string;
  name: string;
  emoji: string;
  description: string;
  group: string[];
  prompt: string;
}

function normalizeAgent(raw: unknown, index: number): MarketAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = pickString(obj, ["name", "title"]);
  const prompt = pickString(obj, ["prompt", "content"]);
  if (!name || !prompt) return null;
  const rawGroup = obj.group;
  return {
    id: pickString(obj, ["id", "slug"]) ?? `${name}-${index}`,
    name,
    emoji: (pickString(obj, ["emoji", "icon"]) ?? "").trim() || "⚡",
    description: pickString(obj, ["description", "summary", "desc"]) ?? "",
    group: Array.isArray(rawGroup)
      ? rawGroup.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
    prompt,
  };
}

// 助手广场分类索引中的一项
export interface MarketAgentCategory {
  category: string; // 分类显示名
  icon: string; // 分类代表 emoji
  count: number; // 该分类下助手数量
  file: string; // 对应的分类文件名，如 "cat-编程.json"
}

// 读取助手广场分类索引（轻量，无 prompt），用于渲染分类 chip
export async function fetchAgentIndex(): Promise<MarketAgentCategory[]> {
  const payload = JSON.parse(await api().network.fetchAgentIndex()) as unknown;
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(obj.categories) ? obj.categories : [];
  return list
    .map((item): MarketAgentCategory | null => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const category = typeof o.category === "string" ? o.category : "";
      const file = typeof o.file === "string" ? o.file : "";
      if (!category || !file) return null;
      return {
        category,
        file,
        icon: typeof o.icon === "string" && o.icon.trim() ? o.icon : "⚡",
        count: typeof o.count === "number" ? o.count : 0,
      };
    })
    .filter((c): c is MarketAgentCategory => c !== null);
}

// 按分类文件名读取该分类下的全部助手（点击分类 chip 时懒加载）
export async function fetchAgentCategory(fileName: string): Promise<MarketAgent[]> {
  const payload = JSON.parse(await api().network.fetchAgentCategory(fileName)) as unknown;
  return extractArray(payload)
    .map((item, index) => normalizeAgent(item, index))
    .filter((agent): agent is MarketAgent => agent !== null);
}

export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export const mcpListTools = (server: McpServerConfig): Promise<McpRemoteTool[]> =>
  mcpSdkListTools(server);

export const mcpCallTool = (params: {
  server: McpServerConfig;
  toolName: string;
  arguments?: Record<string, unknown>;
}): Promise<unknown> => mcpSdkCallTool(params);

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  success: boolean;
  query: string;
  instance: string;
  totalCount: number;
  results: WebSearchResultItem[];
  error?: string;
}

export const webSearch = (params: {
  query: string;
  limit?: number;
  language?: string;
  instances?: string[];
}): Promise<WebSearchResponse> =>
  api().network.webSearch({
    query: params.query,
    limit: params.limit,
    language: params.language,
    instances: params.instances ?? [],
  });

export interface WebReadResponse {
  success: boolean;
  url: string;
  title?: string;
  actualMethod?: string;
  truncated: boolean;
  totalChars: number;
  markdown: string;
  error?: string;
}

export const webRead = (params: {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
  method?: "proxy_markdown" | "direct_html";
}): Promise<WebReadResponse> => api().network.webRead(params);

export const listAgents = (): Promise<string[]> => api().config.listAgents();
export async function readAgentConfig<T = any>(agentId: string): Promise<T> {
  return JSON.parse(await api().config.readAgent(agentId)) as T;
}
export const writeAgentConfig = (agentId: string, content: any) =>
  api().config.writeAgent(agentId, JSON.stringify(content, null, 2));
export const deleteAgentConfig = (agentId: string) => api().config.deleteAgent(agentId);

export async function fetchBuiltinMcpConfigs(): Promise<McpToolConfig[]> {
  return JSON.parse(await api().config.fetchBuiltinMcpConfigs()) as McpToolConfig[];
}
export const listMcpConfigs = (): Promise<string[]> => api().config.listMcp();
export async function readMcpConfig<T = any>(mcpId: string): Promise<T> {
  return JSON.parse(await api().config.readMcp(mcpId)) as T;
}
export const writeMcpConfig = (mcpId: string, content: any) =>
  api().config.writeMcp(mcpId, JSON.stringify(content, null, 2));
export const deleteMcpConfig = (mcpId: string) => api().config.deleteMcp(mcpId);

export const listTeams = (): Promise<string[]> => api().config.listTeams();
export async function readTeamConfig<T = any>(teamId: string): Promise<T> {
  return JSON.parse(await api().config.readTeam(teamId)) as T;
}
export const writeTeamConfig = (teamId: string, content: any) =>
  api().config.writeTeam(teamId, JSON.stringify(content, null, 2));
export const deleteTeamConfig = (teamId: string) => api().config.deleteTeam(teamId);
