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

export interface SecurityScopedOptions {
  securityMode?: import("@/types/permissions").ToolPermissionMode;
}

export type AppUpdatePhase =
  | "idle"
  | "disabled"
  | "unsupported"
  | "checking"
  | "check-error"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "download-error"
  | "download-unavailable"
  | "downloaded";

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  currentVersion: string;
  platform: string;
  arch: string;
  supported: boolean;
  enabled: boolean;
  updateAvailable: boolean;
  downloaded: boolean;
  repository: string;
  feedUrl: string | null;
  releasesUrl: string;
  message: string;
  error: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  releaseNotesError: string | null;
  updateUrl: string | null;
  triggeredBy: "auto" | "manual" | null;
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
export const pickTextFile = (): Promise<string | null> => api().app.pickTextFile();
export const pickMultipleFiles = (): Promise<string[]> => api().app.pickMultipleFiles();
export const pickZipFile = (): Promise<string | null> => api().app.pickZipFile();
export const getPathForFile = (file: File): string => api().app.getPathForFile(file);
export const pickImageFile = () => api().app.pickImageFile();
export const pickAudioFile = () => api().app.pickAudioFile();
export const pickDocumentFile = (): Promise<string | null> => api().app.pickDocumentFile();
export const getDataDir = () => api().app.getDataDir();
export const getHomeDir = () => api().app.getHomeDir();
export const openDataDir = () => api().app.openDataDir();
export const openPath = (path: string) => api().app.openPath(path);
export const openExternal = (url: string) => api().app.openExternal(url);
export const fileUrl = (path: string) => api().app.fileUrl(path);
export const ensureDataDir = () => api().app.ensureDataDir();
export const getUpdateStatus = (): Promise<AppUpdateStatus> => api().updates.getStatus();
export const checkForUpdates = (): Promise<AppUpdateStatus> => api().updates.check();
export const downloadUpdate = (): Promise<AppUpdateStatus> => api().updates.download();
export const installUpdate = (): Promise<AppUpdateStatus> => api().updates.install();
export const openUpdateReleases = (): Promise<void> => api().updates.openReleases();
export const onUpdateStatus = (handler: (status: AppUpdateStatus) => void) =>
  api().updates.onStatus(handler);
export const listDirectory = (path: string, options?: SecurityScopedOptions) => api().fs.listDirectory(path, options);
export const listDirectoryEntries = (path: string, options?: SecurityScopedOptions) => api().fs.listDirectoryEntries(path, options);
export const readFile = (path: string, options?: SecurityScopedOptions) => api().fs.readFile(path, options);
export const readBase64File = (path: string, options?: SecurityScopedOptions) => api().fs.readBase64File(path, options);
export const fileExists = (path: string, options?: SecurityScopedOptions): Promise<boolean> => api().fs.exists(path, options);
export const writeFile = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.writeFile(path, content, options);
export const writeBase64File = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.writeBase64File(path, content, options);
export const appendFile = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.appendFile(path, content, options);
export const renamePath = (src: string, dest: string, options?: SecurityScopedOptions) => api().fs.rename(src, dest, options);
export const copyPath = (src: string, dest: string, options?: SecurityScopedOptions) => api().fs.copy(src, dest, options);
export const createDirectory = (path: string, options?: SecurityScopedOptions) => api().fs.createDirectory(path, options);
export const deleteFile = (path: string, options?: SecurityScopedOptions) => api().fs.deletePath(path, options);
export const installSkillFromGit = (repoUrl: string) => api().skills.installFromGit(repoUrl);
export const installSkillFromLocal = (sourcePath: string) => api().skills.installFromLocal(sourcePath);
export const installSkillFromZip = (zipPath: string) => api().skills.installFromZip(zipPath);
export const uninstallSkill = (skillId: string) => api().skills.uninstall(skillId);
export const listSkills = (skillType: "builtin" | "custom") => api().skills.list(skillType);
export const readSkillMetadata = (skillId: string) => api().skills.readMetadata(skillId);
export const writeSkill = (name: string, content: string): Promise<{ success: boolean; path: string; message: string }> =>
  api().skills.writeSkill(name, content);
export const patchSkill = (name: string, oldString: string, newString: string): Promise<{ success: boolean; path: string; message: string }> =>
  api().skills.patchSkill(name, oldString, newString);
export const deleteSkillByName = (name: string): Promise<{ success: boolean; path: string; message: string }> =>
  api().skills.deleteSkillByName(name);

export async function readConfig<T = any>(fileName: string): Promise<T> {
  return JSON.parse(await api().config.read(fileName)) as T;
}

export function writeConfig(fileName: string, content: any): Promise<void> {
  return api().config.write(fileName, JSON.stringify(content, null, 2));
}

// AGENTS.md 读写：固定路径 {dataDir}/AGENTS.md
export const readAgentsMd = (): Promise<string> =>
  api().config.readAgentsMd();
export const writeAgentsMd = (content: string): Promise<void> =>
  api().config.writeAgentsMd(content);

// 网络搜索接口
export interface WebSearchRequest {
  provider: "tavily" | "exa" | "serper" | "searxng" | "brave";
  query: string;
  limit?: number;
  apiKey?: string;
  // Tavily 特定参数
  searchDepth?: "basic" | "advanced";
  includeDomains?: string;
  excludeDomains?: string;
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeImages?: boolean;
  // Exa 特定参数
  type?: "neural" | "keyword";
  useAutoprompt?: boolean;
  category?: string;
  includeText?: boolean;
  includeHighlights?: boolean;
  includeSummary?: boolean;
  // Serper 特定参数
  gl?: string;
  hl?: string;
  // SearXNG 特定参数
  instances?: string;
  // Brave 特定参数
  country?: string;
  searchLang?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  // Tavily 完整内容字段
  rawContent?: string;
  images?: string[];
  // Exa 完整内容字段
  text?: string;
  highlights?: string[];
  summary?: string;
}

export interface WebSearchResponse {
  success: boolean;
  provider: string;
  instance?: string;
  results: WebSearchResult[];
  // Tavily AI 答案
  answer?: string;
}

export function webSearch(request: WebSearchRequest): Promise<WebSearchResponse> {
  return api().network.webSearch(request);
}

export interface DownloadUrlAsBase64Request {
  url: string;
  timeoutMs?: number;
}

export interface DownloadUrlAsBase64Response {
  base64: string;
  contentType: string;
  extension: string;
}

export function downloadUrlAsBase64(
  request: DownloadUrlAsBase64Request,
): Promise<DownloadUrlAsBase64Response> {
  return api().network.downloadUrlAsBase64(request);
}

export interface OpenAiImageEditRequest {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  imagePath: string;
  maskPath?: string;
  n?: number;
  size?: string;
  quality?: string;
  responseFormat?: "b64_json" | "url";
}

export interface OpenAiImageResponse {
  created?: number;
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
}

export function openAiImageEdit(request: OpenAiImageEditRequest): Promise<OpenAiImageResponse> {
  return api().network.openaiImageEdit(request);
}

// 音频转写（语音识别 ASR）—— OpenAI /audio/transcriptions
export interface OpenAiTranscriptionRequest {
  apiKey: string;
  baseURL: string;
  model: string;
  audioPath: string;
  language?: string;
  responseFormat?: "json" | "text" | "srt" | "verbose_json" | "vtt";
}

export interface OpenAiTranscriptionResponse {
  text: string;
}

export function openAiTranscription(
  request: OpenAiTranscriptionRequest,
): Promise<OpenAiTranscriptionResponse> {
  return api().network.openaiTranscription(request);
}

// 语音合成（TTS）—— OpenAI /audio/speech
export interface OpenAiSpeechRequest {
  apiKey: string;
  baseURL: string;
  model: string;
  input: string;
  voice: string;
  speed?: number;
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm16";
}

export interface OpenAiSpeechResponse {
  base64: string;
  contentType: string;
  extension: string;
}

export function openAiSpeech(request: OpenAiSpeechRequest): Promise<OpenAiSpeechResponse> {
  return api().network.openaiSpeech(request);
}

// 语音合成（TTS）—— MiMo /chat/completions
export interface MimoSpeechRequest {
  apiKey: string;
  baseURL: string;
  model: string;
  input: string;
  voice: string;
  speed?: number; // MiMo 不支持，保留兼容
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm16";
  stylePrompt?: string; // 风格控制提示词
}

export interface MimoSpeechResponse {
  base64: string;
  contentType: string;
  extension: string;
}

export function mimoSpeech(request: MimoSpeechRequest): Promise<MimoSpeechResponse> {
  return api().network.mimoSpeech(request);
}

// 跨域代理请求 —— 由主进程统一发起 HTTP 请求并回传原始响应。
// 复用 network:cors-fetch IPC，供网页读取等需要拉取任意 URL 的能力使用。
export interface CorsFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface CorsFetchResponse {
  status: number;
  statusText: string;
  // 主进程以 [key, value][] 形式回传响应头（已过滤 content-length 等）
  headers: Array<[string, string]>;
  body: string;
}

export function corsFetch(request: CorsFetchRequest): Promise<CorsFetchResponse> {
  return api().network.corsFetch(request) as Promise<CorsFetchResponse>;
}

// Shell 命令执行 —— 由主进程在指定工作目录下执行 shell 命令，供 run_bash 工具使用。
// 主进程会做黑名单校验、超时 kill、输出截断。
export interface ShellExecRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  securityMode?: import("@/types/permissions").ToolPermissionMode;
}

export interface ShellExecResponse {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  blocked?: boolean;
}

export function runShell(request: ShellExecRequest): Promise<ShellExecResponse> {
  return api().shell.exec(request);
}

export interface HtmlToPdfRequest {
  html?: string;
  sourcePath?: string;
  targetPath: string;
  baseDir?: string;
  pageSize?: "A4" | "Letter" | "Legal";
  landscape?: boolean;
  margins?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface HtmlToPdfResponse {
  path: string;
  size: number;
}

export function htmlToPdf(request: HtmlToPdfRequest): Promise<HtmlToPdfResponse> {
  return api().office.htmlToPdf(request);
}

export interface HtmlToPptxRequest {
  html?: string;
  sourcePath?: string;
  targetPath: string;
  baseDir?: string;
}

export interface HtmlToPptxResponse {
  path: string;
  slides: number;
  size: number;
}

export function htmlToPptx(request: HtmlToPptxRequest): Promise<HtmlToPptxResponse> {
  return api().office.htmlToPptx(request);
}
