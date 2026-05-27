/**
 * ZtoApi - OpenAI兼容API代理服务器
 *
 * 功能概述：
 * - 为 Z.ai 的 GLM-4.5, GLM-4.5V, GLM-4.6 等模型提供 OpenAI 兼容的 API 接口
 * - 支持流式和非流式响应模式
 * - 提供实时监控 Dashboard 功能
 * - 支持匿名 token 自动获取
 * - 智能处理模型思考过程展示
 * - 完整的请求统计和错误处理
 *
 * 技术栈：
 * - Deno 原生 HTTP API
 * - TypeScript 类型安全
 * - Server-Sent Events (SSE) 流式传输
 * - 支持 Deno Deploy 和自托管部署
 *
 * @author ZtoApi Team
 * @version 2.0.0
 * @since 2024
 */
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

declare namespace Deno {
  interface Conn {
    readonly rid: number;
    localAddr: Addr;
    remoteAddr: Addr;
    read(p: Uint8Array): Promise<number | null>;
    write(p: Uint8Array): Promise<number>;
    close(): void;
  }

  interface Addr {
    hostname: string;
    port: number;
    transport: string;
  }

  interface Listener extends AsyncIterable<Conn> {
    readonly addr: Addr;
    accept(): Promise<Conn>;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<Conn>;
  }

  interface HttpConn {
    nextRequest(): Promise<RequestEvent | null>;
    [Symbol.asyncIterator](): AsyncIterableIterator<RequestEvent>;
  }

  interface RequestEvent {
    request: Request;
    respondWith(r: Response | Promise<Response>): Promise<void>;
  }

  function listen(options: { port: number }): Listener;
  function serveHttp(conn: Conn): HttpConn;
  function serve(handler: (request: Request) => Promise<Response>): void;

  class Command {
    constructor(command: string | URL, options?: Record<string, unknown>);
    spawn(): ChildProcess;
  }

  interface ChildProcess {
    readonly pid: number;
    readonly stdin: WritableStream<Uint8Array>;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly status: Promise<{ success: boolean; code: number; signal?: string }>;
    kill(signo?: string): void;
  }

  namespace env {
    function get(key: string): string | undefined;
  }

  function kill(pid: number, signo?: string): void;

  function makeTempFile(options?: { suffix?: string }): Promise<string>;
  function readTextFile(path: string | URL): Promise<string>;
  function remove(path: string | URL): Promise<void>;
  function stat(path: string | URL): Promise<{ isFile: boolean }>;
}

/**
 * 请求统计信息接口
 * 用于跟踪API调用的各项指标
 */
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequestTime: Date;
  averageResponseTime: number;
}

/**
 * 实时请求信息接口
 * 用于Dashboard显示最近的API请求记录
 */
interface LiveRequest {
  id: string;
  timestamp: Date;
  method: string;
  path: string;
  status: number;
  duration: number;
  userAgent: string;
  model?: string;
}

/**
 * OpenAI兼容请求结构
 * 标准的聊天完成API请求格式
 */

/**
 * OpenAI工具定义
 */
interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

/**
 * 工具选择策略
 */
type ToolChoice = "none" | "auto" | { type: "function"; function: { name: string } };

interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning?: boolean;
  tools?: Tool[];
  tool_choice?: ToolChoice;
}

/**
 * 聊天消息结构
 * 支持全方位多模态内容：文本、图像、视频、文档
 */
interface Message {
  role: string;
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
        video_url?: { url: string };
        document_url?: { url: string };
        audio_url?: { url: string };
      }>;
}

/**
 * 文件上传结果结构
 */
interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  type: string;
  url?: string;
}

/**
 * 上游服务请求结构
 * 向Z.ai服务发送的请求格式
 */
interface UpstreamRequest {
  stream: boolean;
  model: string;
  messages: Message[];
  captcha_verify_param?: string;
  extra?: Record<string, unknown>;
  params: Record<string, unknown>;
  features: Record<string, unknown>;
  background_tasks?: Record<string, boolean>;
  chat_id?: string;
  session_id?: string;
  id?: string;
  current_user_message_id?: string;
  current_user_message_parent_id?: string | null;
  mcp_servers?: string[];
  model_item?: {
    id: string;
    name: string;
    owned_by: string;
    openai?: any;
    urlIdx?: number;
    info?: any;
    actions?: any[];
    tags?: any[];
  };
  tool_servers?: string[];
  variables?: Record<string, string>;
  files?: UploadedFile[];
  signature_prompt?: string;
}

interface UpstreamChatHistoryNode {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  role: string;
  content: Message["content"];
  timestamp?: number;
  models?: string[];
}

interface UpstreamChatBootstrapPayload {
  id: string;
  title: string;
  models: string[];
  params: Record<string, unknown>;
  history: {
    messages: Record<string, UpstreamChatHistoryNode>;
    currentId: string | null;
  };
  tags: unknown[];
  flags: unknown[];
  features: unknown[];
  enable_thinking: boolean;
  auto_web_search: boolean;
  message_version: number;
  extra: Record<string, unknown>;
  timestamp: number;
  type: string;
}

/**
 * OpenAI兼容响应结构
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  finish_reason?: string;
}

interface Delta {
  role?: string;
  content?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * 上游SSE数据结构
 */
interface UpstreamData {
  type: string;
  data: {
    delta_content: string;
    phase: string;
    done: boolean;
    usage?: Usage;
    error?: UpstreamError;
    data?: {
      error?: UpstreamError;
      done?: boolean;
      delta_content?: string;
      phase?: string;
    };
    inner?: {
      error?: UpstreamError;
    };
  };
  error?: UpstreamError;
}

interface UpstreamError {
  detail: string;
  code: number;
  error_code?: string;
  captcha_error_type?: string;
  verify_code?: string;
}

interface ModelsResponse {
  object: string;
  data: Model[];
}

interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/**
 * MCP 服务器配置
 */
interface MCPServerConfig {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * 高级模式检测配置
 */
interface ModelCapabilities {
  thinking: boolean;
  search: boolean;
  advancedSearch: boolean;
  vision: boolean;
  mcp: boolean;
}

/**
 * 配置常量定义
 */

// 思考内容处理策略: strip-去除<details>标签, think-转为<thinking>标签, raw-保留原样
const THINK_TAGS_MODE = "strip";

// MCP 服务器配置
const MCP_SERVERS: Record<string, MCPServerConfig> = {
  "deep-web-search": {
    name: "Deep Web Search",
    description: "深度网络搜索功能",
    enabled: true,
  },
  "advanced-search": {
    name: "Advanced Search",
    description: "高级搜索功能",
    enabled: true,
  },
  "vibe-coding": {
    name: "Vibe Coding",
    description: "编程助手功能",
    enabled: true,
  },
  "ppt-maker": {
    name: "PPT Maker",
    description: "PPT 生成功能",
    enabled: true,
  },
  "image-search": {
    name: "Image Search",
    description: "图像搜索功能",
    enabled: true,
  },
  "deep-research": {
    name: "Deep Research",
    description: "深度研究功能",
    enabled: true,
  },
};

/**
 * 高级模式检测器
 */
class ModelCapabilityDetector {
  /**
   * 检测模型的高级能力
   */
  static detectCapabilities(modelId: string, reasoning?: boolean): ModelCapabilities {
    const normalizedModelId = modelId.toLowerCase();

    return {
      thinking: this.isThinkingModel(normalizedModelId, reasoning),
      search: this.isSearchModel(normalizedModelId),
      advancedSearch: this.isAdvancedSearchModel(normalizedModelId),
      vision: this.isVisionModel(normalizedModelId),
      mcp: this.supportsMCP(normalizedModelId),
    };
  }

  private static isThinkingModel(modelId: string, reasoning?: boolean): boolean {
    return modelId.includes("thinking") ||
           modelId.includes("4.6") ||
           reasoning === true ||
           modelId.includes("0727-360b-api");
  }

  private static isSearchModel(modelId: string): boolean {
    return modelId.includes("search") ||
           modelId.includes("web") ||
           modelId.includes("browser");
  }

  private static isAdvancedSearchModel(modelId: string): boolean {
    return modelId.includes("advanced-search") ||
           modelId.includes("advanced") ||
           modelId.includes("pro-search");
  }

  private static isVisionModel(modelId: string): boolean {
    return modelId.includes("4.5v") ||
           modelId.includes("vision") ||
           modelId.includes("image") ||
           modelId.includes("multimodal");
  }

  private static supportsMCP(modelId: string): boolean {
    // 大部分高级模型都支持 MCP
    return this.isThinkingModel(modelId) ||
           this.isSearchModel(modelId) ||
           this.isAdvancedSearchModel(modelId);
  }

  /**
   * 获取模型对应的 MCP 服务器列表
   */
  static getMCPServersForModel(capabilities: ModelCapabilities): string[] {
    const servers: string[] = [];

    if (capabilities.advancedSearch) {
      servers.push("advanced-search");
    } else if (capabilities.search) {
      servers.push("deep-web-search");
    }

    // 添加隐藏的 MCP 服务器特性
    if (capabilities.mcp) {
      // 这些服务器作为隐藏特性添加到 features 中
      debugLog("模型支持隐藏 MCP 特性: vibe-coding, ppt-maker, image-search, deep-research");
    }

    return servers;
  }

  /**
   * 获取隐藏的 MCP 特性列表
   */
  static getHiddenMCPFeatures(): Array<{ type: string; server: string; status: string }> {
    return [
      { type: "mcp", server: "vibe-coding", status: "hidden" },
      { type: "mcp", server: "ppt-maker", status: "hidden" },
      { type: "mcp", server: "image-search", status: "hidden" },
      { type: "mcp", server: "deep-research", status: "hidden" }
    ];
  }
}

/**
 * 智能 Header 生成器
 * 动态生成真实的浏览器请求头
 */
class SmartHeaderGenerator {
  private static cachedHeaders: Record<string, string> | null = null;
  private static cacheExpiry: number = 0;
  private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

  /**
   * 生成智能浏览器头部
   */
  static async generateHeaders(chatId: string = ""): Promise<Record<string, string>> {
    // 检查缓存
    const now = Date.now();
    if (this.cachedHeaders && this.cacheExpiry > now) {
      const headers = { ...this.cachedHeaders };
      if (chatId) {
        headers["Referer"] = `${ORIGIN_BASE}/c/${chatId}`;
      }
      return headers;
    }

    // 生成新的头部
    const baseHeaders = await this.generateFreshHeaders();
    this.cachedHeaders = baseHeaders;
    this.cacheExpiry = now + this.CACHE_DURATION;

    debugLog("智能 Header 已生成并缓存");
    const headers = { ...baseHeaders };
    if (chatId) {
      headers["Referer"] = `${ORIGIN_BASE}/c/${chatId}`;
    }
    return headers;
  }

  private static async generateFreshHeaders(): Promise<Record<string, string>> {
      return {
        // 基础头部
        "Accept": "*/*",
        "Accept-Language": getPreferredBrowserAcceptLanguage(),
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "application/json",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",

      // 浏览器特定头部
      "User-Agent": getPreferredBrowserUserAgent(),
      "Sec-Ch-Ua": getPreferredSecChUa(),
      "Sec-Ch-Ua-Mobile": getPreferredSecChUaMobile(),
      "Sec-Ch-Ua-Platform": getPreferredSecChUaPlatform(),

      // Z.AI 特定头部
      "Origin": ORIGIN_BASE,
      "Referer": "",
      "X-Fe-Version": X_FE_VERSION,
      "X-Region": BROWSER_REGION,
    };
  }

  /**
   * 清除缓存
   */
  static clearCache(): void {
    this.cachedHeaders = null;
    this.cacheExpiry = 0;
    debugLog("Header 缓存已清除");
  }
}

/**
 * 浏览器指纹参数生成器
 */
class BrowserFingerprintGenerator {
  /**
   * 生成完整的浏览器指纹参数
   */
  static generateFingerprintParams(
    timestamp: number,
    requestId: string,
    token: string,
    chatId: string = ""
  ): Record<string, string> {
    // 从 JWT token 提取用户 ID（多字段支持，与 Python 版本一致）
    let userId = "guest";
    try {
      const tokenParts = token.split(".");
      if (tokenParts.length === 3) {
        const payload = JSON.parse(atob(tokenParts[1]));

        // 尝试多个可能的 user_id 字段（与 Python 版本一致）
        for (const key of ["id", "user_id", "uid", "sub"]) {
          const val = payload[key];
          if (typeof val === "string" || typeof val === "number") {
            const strVal = String(val);
            if (strVal.length > 0) {
              userId = strVal;
              break;
            }
          }
        }
      }
    } catch (e) {
      debugLog("解析 JWT token 失败: %v", e);
    }

    const now = new Date(timestamp);
    const localTime = now.toISOString();

    return {
      // 基础参数
      "timestamp": timestamp.toString(),
      "requestId": requestId,
      "user_id": userId,
      "version": "0.0.1",
      "platform": "web",
      "token": token,

      // 浏览器环境参数
      "user_agent": getPreferredBrowserUserAgent(),
      "language": getPreferredBrowserLanguage(),
      "languages": getPreferredBrowserLanguages(),
      "timezone": getPreferredBrowserTimezone(),
      "cookie_enabled": "true",

      // 屏幕参数
      "screen_width": getPreferredBrowserScreenWidth(),
      "screen_height": getPreferredBrowserScreenHeight(),
      "screen_resolution": `${getPreferredBrowserScreenWidth()}x${getPreferredBrowserScreenHeight()}`,
      "viewport_height": getPreferredBrowserViewportHeight(),
      "viewport_width": getPreferredBrowserViewportWidth(),
      "viewport_size": `${getPreferredBrowserViewportWidth()}x${getPreferredBrowserViewportHeight()}`,
      "color_depth": getPreferredBrowserColorDepth(),
      "pixel_ratio": getPreferredBrowserPixelRatio(),

      // URL 参数
      "current_url": chatId ? `${ORIGIN_BASE}/c/${chatId}` : ORIGIN_BASE,
      "pathname": chatId ? `/c/${chatId}` : "/",
      "search": "",
      "hash": "",
      "host": "chat.z.ai",
      "hostname": "chat.z.ai",
      "protocol": "https:",
      "referrer": "",
      "title": getPreferredBrowserTitle(),

      // 时间参数
      "timezone_offset": getPreferredBrowserTimezoneOffset(),
      "local_time": localTime,
      "utc_time": now.toUTCString(),

      // 设备参数
      "is_mobile": "false",
      "is_touch": "false",
      "max_touch_points": "0",
      "browser_name": getPreferredBrowserName(),
      "os_name": getPreferredBrowserOsName(),

      // 签名参数
      "signature_timestamp": timestamp.toString(),
    };
  }
}

// 伪装前端头部（来自抓包分析）
const X_FE_VERSION = Deno.env.get("UPSTREAM_X_FE_VERSION") || "prod-fe-1.1.35";
const BROWSER_UA =
  Deno.env.get("UPSTREAM_BROWSER_UA") ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";
const SEC_CH_UA =
  Deno.env.get("UPSTREAM_SEC_CH_UA") ||
  '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"';
const SEC_CH_UA_MOB = Deno.env.get("UPSTREAM_SEC_CH_UA_MOBILE") || "?0";
const SEC_CH_UA_PLAT = Deno.env.get("UPSTREAM_SEC_CH_UA_PLATFORM") || '"Linux"';
const BROWSER_TITLE =
  Deno.env.get("UPSTREAM_BROWSER_TITLE") ||
  "Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5";
const BROWSER_NAME = Deno.env.get("UPSTREAM_BROWSER_NAME") || "Chrome";
const BROWSER_OS_NAME = Deno.env.get("UPSTREAM_BROWSER_OS_NAME") || "Linux";
const BROWSER_NAVIGATOR_PLATFORM =
  Deno.env.get("UPSTREAM_BROWSER_NAVIGATOR_PLATFORM") || "Linux x86_64";
const ORIGIN_BASE = "https://chat.z.ai";
const BROWSER_REGION = Deno.env.get("UPSTREAM_BROWSER_REGION") || "overseas";
const BROWSER_LANGUAGE = Deno.env.get("UPSTREAM_BROWSER_LANGUAGE") || "zh-CN";
const BROWSER_LANGUAGES = Deno.env.get("UPSTREAM_BROWSER_LANGUAGES") || "zh-CN,en,en-GB,en-US";
const BROWSER_TIMEZONE = Deno.env.get("UPSTREAM_BROWSER_TIMEZONE") || "Asia/Shanghai";
const BROWSER_TIMEZONE_OFFSET = Deno.env.get("UPSTREAM_BROWSER_TIMEZONE_OFFSET") || "-480";
const BROWSER_SCREEN_WIDTH = Deno.env.get("UPSTREAM_BROWSER_SCREEN_WIDTH") || "1552";
const BROWSER_SCREEN_HEIGHT = Deno.env.get("UPSTREAM_BROWSER_SCREEN_HEIGHT") || "970";
const BROWSER_VIEWPORT_WIDTH = Deno.env.get("UPSTREAM_BROWSER_VIEWPORT_WIDTH") || "1544";
const BROWSER_VIEWPORT_HEIGHT = Deno.env.get("UPSTREAM_BROWSER_VIEWPORT_HEIGHT") || "812";
const BROWSER_COLOR_DEPTH = Deno.env.get("UPSTREAM_BROWSER_COLOR_DEPTH") || "30";
const BROWSER_PIXEL_RATIO = Deno.env.get("UPSTREAM_BROWSER_PIXEL_RATIO") || "1.649999976158142";
let IMPORTED_BROWSER_REQUEST_PROFILE: Partial<BrowserRequestProfile> = {};
let IMPORTED_BROWSER_FINGERPRINT_PROFILE: Record<string, string> = {};

function getPreferredBrowserUserAgent(): string {
  return IMPORTED_BROWSER_REQUEST_PROFILE.userAgent || IMPORTED_BROWSER_FINGERPRINT_PROFILE.user_agent || BROWSER_UA;
}

function getPreferredBrowserAcceptLanguage(): string {
  return IMPORTED_BROWSER_REQUEST_PROFILE.acceptLanguage || IMPORTED_BROWSER_FINGERPRINT_PROFILE.language || BROWSER_LANGUAGE;
}

function normalizePrimaryLanguage(value: string): string {
  return value.split(",")[0]?.split(";")[0]?.trim() || value.trim();
}

function getPreferredBrowserLanguage(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.language ||
    normalizePrimaryLanguage(IMPORTED_BROWSER_REQUEST_PROFILE.acceptLanguage || BROWSER_LANGUAGE);
}

function getPreferredSecChUa(): string {
  return IMPORTED_BROWSER_REQUEST_PROFILE.secChUa || SEC_CH_UA;
}

function getPreferredSecChUaMobile(): string {
  return IMPORTED_BROWSER_REQUEST_PROFILE.secChUaMobile || SEC_CH_UA_MOB;
}

function getPreferredSecChUaPlatform(): string {
  return IMPORTED_BROWSER_REQUEST_PROFILE.secChUaPlatform || SEC_CH_UA_PLAT;
}

function getPreferredBrowserLanguages(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.languages || BROWSER_LANGUAGES;
}

function getPreferredBrowserTimezone(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.timezone || BROWSER_TIMEZONE;
}

function getPreferredBrowserTimezoneOffset(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.timezone_offset || BROWSER_TIMEZONE_OFFSET;
}

function getPreferredBrowserScreenWidth(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.screen_width || BROWSER_SCREEN_WIDTH;
}

function getPreferredBrowserScreenHeight(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.screen_height || BROWSER_SCREEN_HEIGHT;
}

function getPreferredBrowserViewportWidth(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.viewport_width || BROWSER_VIEWPORT_WIDTH;
}

function getPreferredBrowserViewportHeight(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.viewport_height || BROWSER_VIEWPORT_HEIGHT;
}

function getPreferredBrowserColorDepth(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.color_depth || BROWSER_COLOR_DEPTH;
}

function getPreferredBrowserPixelRatio(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.pixel_ratio || BROWSER_PIXEL_RATIO;
}

function getPreferredBrowserTitle(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.title || BROWSER_TITLE;
}

function getPreferredBrowserName(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.browser_name || BROWSER_NAME;
}

function getPreferredBrowserOsName(): string {
  return IMPORTED_BROWSER_FINGERPRINT_PROFILE.os_name || BROWSER_OS_NAME;
}
const MCP_FEATURES = [
  { server: "vibe-coding", status: "hidden", type: "mcp" },
  { server: "ppt-maker", status: "hidden", type: "mcp" },
  { server: "image-search", status: "hidden", type: "mcp" },
  { server: "deep-research", status: "hidden", type: "mcp" },
  { server: "tool_selector", status: "hidden", type: "tool_selector" },
];

const ANON_TOKEN_ENABLED = true;

/**
 * 环境变量配置
 */
const UPSTREAM_API_BASE =
  Deno.env.get("UPSTREAM_API_BASE") || "https://chat.z.ai";
const UPSTREAM_COMPLETION_VERSION =
  (Deno.env.get("UPSTREAM_COMPLETION_VERSION") || "2").trim().toLowerCase();
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const ZAI_TOKEN = Deno.env.get("ZAI_TOKEN") || "";

function resolveCompletionEndpoint(): string {
  const normalizedBase = UPSTREAM_API_BASE.replace(/\/+$/, "");

  if (UPSTREAM_COMPLETION_VERSION === "1") {
    return `${normalizedBase}/api/chat/completions`;
  }

  if (UPSTREAM_COMPLETION_VERSION === "2") {
    return `${normalizedBase}/api/v2/chat/completions`;
  }

  if (/^https?:\/\//.test(UPSTREAM_COMPLETION_VERSION)) {
    return UPSTREAM_COMPLETION_VERSION;
  }

  debugLog(
    "未知 UPSTREAM_COMPLETION_VERSION=%s，回退到 v2 endpoint",
    UPSTREAM_COMPLETION_VERSION,
  );
  return `${normalizedBase}/api/v2/chat/completions`;
}

const UPSTREAM_URL = resolveCompletionEndpoint();

/**
 * 支持的模型配置
 */
interface ModelConfig {
  id: string; // OpenAI API中的模型ID
  name: string; // 显示名称
  upstreamId: string; // Z.ai上游的模型ID
  capabilities: {
    vision: boolean;
    mcp: boolean;
    thinking: boolean;
  };
  defaultParams: {
    top_p: number;
    temperature: number;
    max_tokens?: number;
  };
}

const SUPPORTED_MODELS: ModelConfig[] = [
  {
    id: "0727-360B-API",
    name: "GLM-4.5",
    upstreamId: "0727-360B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-4.5v",
    name: "GLM-4.5V",
    upstreamId: "glm-4.5v",
    capabilities: {
      vision: true,
      mcp: false,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.6,
      temperature: 0.8,
    },
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    upstreamId: "GLM-4-6-API-V1",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-4.6v",
    name: "GLM-4.6V",
    upstreamId: "glm-4.6v",
    capabilities: {
      vision: true,
      mcp: false,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.6,
      temperature: 0.8,
    },
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "glm-5",
    name: "GLM-5",
    upstreamId: "glm-5",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "0727-106B-API",
    name: "GLM-4.5-Air",
    upstreamId: "0727-106B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "0808-360B-DR",
    name: "0808-360B-DR",
    upstreamId: "0808-360B-DR",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
];

// 默认模型
const DEFAULT_MODEL = SUPPORTED_MODELS[0];

// 根据模型ID获取配置
function getModelConfig(modelId: string): ModelConfig {
  // 标准化模型ID，处理Cherry Studio等客户端的大小写差异
  const normalizedModelId = normalizeModelId(modelId);
  const found = SUPPORTED_MODELS.find((m) => m.id === normalizedModelId);

  if (!found) {
    debugLog(
      "⚠️ 未找到模型配置: %s (标准化后: %s)，使用默认模型: %s",
      modelId,
      normalizedModelId,
      DEFAULT_MODEL.name
    );
  }

  return found || DEFAULT_MODEL;
}

/**
 * 标准化模型ID，处理不同客户端的命名差异
 * Cherry Studio等客户端可能使用不同的大小写格式
 */
function normalizeModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().trim();

  // 处理常见的模型ID映射
  const modelMappings: Record<string, string> = {
    "glm-4.5v": "glm-4.5v",
    "glm4.5v": "glm-4.5v",
    "glm_4.5v": "glm-4.5v",
    "gpt-4-vision-preview": "glm-4.5v", // 向后兼容
    "0727-360b-api": "0727-360B-API",
    "glm-4.5": "0727-360B-API",
    "glm4.5": "0727-360B-API",
    "glm_4.5": "0727-360B-API",
    "gpt-4": "0727-360B-API", // 向后兼容
    "glm-4.6": "glm-4.6",
    "glm4.6": "glm-4.6",
    "glm_4.6": "glm-4.6",
    "glm-4.7": "glm-4.7",
    "glm4.7": "glm-4.7",
    "glm_4.7": "glm-4.7",
    "glm-5": "glm-5",
    "glm5": "glm-5",
    "glm_5": "glm-5",
    "glm-5.0": "glm-5",
    "glm5.0": "glm-5",
    "glm_5.0": "glm-5",
  };

  const mapped = modelMappings[normalized];
  if (mapped) {
    debugLog("🔄 模型ID映射: %s → %s", modelId, mapped);
    return mapped;
  }

  return normalized;
}

/**
 * 处理和验证全方位多模态消息
 * 支持图像、视频、文档、音频等多种媒体类型
 */
function processMessages(
  messages: Message[],
  modelConfig: ModelConfig
): Message[] {
  const processedMessages: Message[] = [];

  for (const message of messages) {
    const processedMessage: Message = { ...message };

    // 检查是否为多模态消息
    if (Array.isArray(message.content)) {
      debugLog("检测到多模态消息，内容块数量: %d", message.content.length);

      // 统计各种媒体类型
      const mediaStats = {
        text: 0,
        images: 0,
        videos: 0,
        documents: 0,
        audios: 0,
        others: 0,
      };

      // 验证模型是否支持多模态
      if (!modelConfig.capabilities.vision) {
        debugLog(
          "警告: 模型 %s 不支持多模态，但收到了多模态消息",
          modelConfig.name
        );
        // 只保留文本内容
        const textContent = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        processedMessage.content = textContent;
      } else {
        // GLM-4.5V 支持全方位多模态，处理所有内容类型
        for (const block of message.content) {
          switch (block.type) {
            case "text":
              if (block.text) {
                mediaStats.text++;
                debugLog("📝 文本内容，长度: %d", block.text.length);
              }
              break;

            case "image_url":
              if (block.image_url?.url) {
                mediaStats.images++;
                const url = block.image_url.url;
                if (url.startsWith("data:image/")) {
                  const mimeMatch = url.match(/data:image\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🖼️ 图像数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 图像URL: %s", url);
                } else {
                  debugLog("⚠️ 未知图像格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "video_url":
              if (block.video_url?.url) {
                mediaStats.videos++;
                const url = block.video_url.url;
                if (url.startsWith("data:video/")) {
                  const mimeMatch = url.match(/data:video\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🎥 视频数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 视频URL: %s", url);
                } else {
                  debugLog("⚠️ 未知视频格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "document_url":
              if (block.document_url?.url) {
                mediaStats.documents++;
                const url = block.document_url.url;
                if (url.startsWith("data:application/")) {
                  const mimeMatch = url.match(/data:application\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "📄 文档数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 文档URL: %s", url);
                } else {
                  debugLog("⚠️ 未知文档格式: %s", url.substring(0, 50));
                }
              }
              break;

            case "audio_url":
              if (block.audio_url?.url) {
                mediaStats.audios++;
                const url = block.audio_url.url;
                if (url.startsWith("data:audio/")) {
                  const mimeMatch = url.match(/data:audio\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog(
                    "🎵 音频数据: %s格式, 大小: %d字符",
                    format,
                    url.length
                  );
                } else if (url.startsWith("http")) {
                  debugLog("🔗 音频URL: %s", url);
                } else {
                  debugLog("⚠️ 未知音频格式: %s", url.substring(0, 50));
                }
              }
              break;

            default:
              mediaStats.others++;
              debugLog("❓ 未知内容类型: %s", block.type);
          }
        }

        // 输出统计信息
        const totalMedia =
          mediaStats.images +
          mediaStats.videos +
          mediaStats.documents +
          mediaStats.audios;
        if (totalMedia > 0) {
          debugLog(
            "🎯 多模态内容统计: 文本(%d) 图像(%d) 视频(%d) 文档(%d) 音频(%d)",
            mediaStats.text,
            mediaStats.images,
            mediaStats.videos,
            mediaStats.documents,
            mediaStats.audios
          );
        }
      }
    } else if (typeof message.content === "string") {
      debugLog("📝 纯文本消息，长度: %d", message.content.length);
    }

    processedMessages.push(processedMessage);
  }

  return processedMessages;
}

const DEBUG_MODE = Deno.env.get("DEBUG_MODE") !== "false"; // 默认为true
const DEFAULT_STREAM = Deno.env.get("DEFAULT_STREAM") !== "false"; // 默认为true
const DASHBOARD_ENABLED = Deno.env.get("DASHBOARD_ENABLED") !== "false"; // 默认为true
const UPSTREAM_TRANSPORT_PREFERENCE =
  (Deno.env.get("UPSTREAM_TRANSPORT_PREFERENCE") || "auto").toLowerCase();
const UPSTREAM_HOST_RESOLVE_OVERRIDES =
  (Deno.env.get("UPSTREAM_HOST_RESOLVE_OVERRIDES") || "").trim();
const UPSTREAM_IMPERSONATE_BROWSER =
  (Deno.env.get("UPSTREAM_IMPERSONATE_BROWSER") || "chrome136").trim();
const UPSTREAM_PROXY_URL = Deno.env.get("UPSTREAM_PROXY_URL") || "";
const UPSTREAM_SYSTEM_PROXY_AUTO_DETECT =
  Deno.env.get("UPSTREAM_SYSTEM_PROXY_AUTO_DETECT") !== "false";
const AUTO_CAPTCHA_PURE_CODE_ENABLED =
  Deno.env.get("AUTO_CAPTCHA_PURE_CODE_ENABLED") === "true";
const AUTO_CAPTCHA_PURE_CODE_TIMEOUT_MS = Number(
  Deno.env.get("AUTO_CAPTCHA_PURE_CODE_TIMEOUT_MS") || "25000"
);
const AUTO_CAPTCHA_SESSION_MAX_AGE_MS = Number(
  Deno.env.get("AUTO_CAPTCHA_SESSION_MAX_AGE_MS") || "120000"
);
const AUTO_CAPTCHA_REUSE_ENABLED =
  Deno.env.get("AUTO_CAPTCHA_REUSE_ENABLED") === "true";
const AUTO_CAPTCHA_PURE_CODE_CLEAN_STALE_WORKERS =
  Deno.env.get("AUTO_CAPTCHA_PURE_CODE_CLEAN_STALE_WORKERS") !== "false";
const AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB = Math.max(
  256,
  Number(Deno.env.get("AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB") || "512"),
);
const UPSTREAM_EXTRA_COOKIE_HEADER =
  (Deno.env.get("UPSTREAM_EXTRA_COOKIE_HEADER") || "").trim();
const UPSTREAM_LOGGED_IN_COOKIE_HEADER =
  (Deno.env.get("UPSTREAM_LOGGED_IN_COOKIE_HEADER") || "").trim();
const UPSTREAM_BROWSER_COOKIE_CAPTURE_PATH =
  (Deno.env.get("UPSTREAM_BROWSER_COOKIE_CAPTURE_PATH") || "").trim();
const UPSTREAM_BROWSER_USER_NAME =
  (Deno.env.get("UPSTREAM_BROWSER_USER_NAME") || "").trim();
const AUTO_CAPTCHA_MODEL_REGEX = new RegExp(
  Deno.env.get("AUTO_CAPTCHA_MODEL_REGEX") ||
    "^(0727-360B-API|0808-360B-DR|glm-4(?:\\.5(?:-air|-flash|-x)?|\\.6|\\.7)?|glm-5(?:\\.0)?)$",
  "i"
);

/**
 * Token 池管理系统
 * 支持多个 Token 轮换使用，自动切换失败的 Token
 */
interface TokenInfo {
  token: string;
  isValid: boolean;
  lastUsed: number;
  failureCount: number;
  isAnonymous?: boolean;
}

class TokenPool {
  private tokens: TokenInfo[] = [];
  private currentIndex: number = 0;
  private anonymousToken: string | null = null;
  private anonymousTokenExpiry: number = 0;

  constructor() {
    this.initializeTokens();
  }

  /**
   * 初始化 Token 池
   */
  private initializeTokens(): void {
    // 从环境变量读取多个 Token，用逗号分隔
    const tokenEnv = Deno.env.get("ZAI_TOKENS");
    if (tokenEnv) {
      const tokenList = tokenEnv.split(",").map(t => t.trim()).filter(t => t.length > 0);
      this.tokens = tokenList.map(token => ({
        token,
        isValid: true,
        lastUsed: 0,
        failureCount: 0
      }));
      debugLog("Token 池已初始化，包含 %d 个 Token", this.tokens.length);
    } else if (ZAI_TOKEN) {
      // 兼容单个 Token 配置
      this.tokens = [{
        token: ZAI_TOKEN,
        isValid: true,
        lastUsed: 0,
        failureCount: 0
      }];
      debugLog("使用单个 Token 配置");
    } else {
      debugLog("⚠️ 未配置 Token，将使用匿名 Token");
    }
  }

  /**
   * 获取下一个可用 Token
   */
  async getToken(): Promise<string> {
    if (UPSTREAM_LOGGED_IN_COOKIE_HEADER) {
      return await this.getLoggedInCookieToken();
    }

    // 如果有配置的 Token，尝试使用
    if (this.tokens.length > 0) {
      const token = this.getNextValidToken();
      if (token) {
        token.lastUsed = Date.now();
        return token.token;
      }
    }

    // 降级到匿名 Token
    return await this.getAnonymousToken();
  }

  private async getLoggedInCookieToken(): Promise<string> {
    const session = await getLoggedInCookieSession();
    return session.authToken;
  }

  /**
   * 获取下一个有效的配置 Token
   */
  private getNextValidToken(): TokenInfo | null {
    const startIndex = this.currentIndex;

    do {
      const tokenInfo = this.tokens[this.currentIndex];
      if (tokenInfo.isValid && tokenInfo.failureCount < 3) {
        return tokenInfo;
      }
      this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    } while (this.currentIndex !== startIndex);

    return null; // 所有 Token 都不可用
  }

  /**
   * 切换到下一个 Token（当前 Token 失败时调用）
   */
  async switchToNext(): Promise<string | null> {
    if (this.tokens.length === 0) return null;

    // 标记当前 Token 为失败
    const currentToken = this.tokens[this.currentIndex];
    currentToken.failureCount++;
    if (currentToken.failureCount >= 3) {
      currentToken.isValid = false;
      debugLog("Token 已标记为无效: %s", currentToken.token.substring(0, 20));
    }

    // 切换到下一个
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
    const nextToken = this.tokens[this.currentIndex];

    if (nextToken && nextToken.isValid) {
      debugLog("切换到下一个 Token: %s", nextToken.token.substring(0, 20));
      nextToken.lastUsed = Date.now();
      return nextToken.token;
    }

    return null; // 所有配置 Token 都不可用
  }

  /**
   * 重置 Token 状态（成功调用后）
   */
  markSuccess(token: string): void {
    const tokenInfo = this.tokens.find(t => t.token === token);
    if (tokenInfo) {
      tokenInfo.failureCount = 0;
      tokenInfo.isValid = true;
    }
  }

  /**
   * 获取匿名 Token
   */
  private async getAnonymousToken(): Promise<string> {
    const now = Date.now();

    // 检查缓存是否有效
    if (this.anonymousToken && this.anonymousTokenExpiry > now) {
      return this.anonymousToken;
    }

    try {
      this.anonymousToken = await getAnonymousToken();
      this.anonymousTokenExpiry = now + (60 * 60 * 1000); // 1小时有效期
      debugLog("匿名 Token 已获取并缓存");
      return this.anonymousToken;
    } catch (error) {
      debugLog("获取匿名 Token 失败: %v", error);
      throw error;
    }
  }

  /**
   * 清除匿名 Token 缓存
   */
  clearAnonymousTokenCache(): void {
    this.anonymousToken = null;
    this.anonymousTokenExpiry = 0;
    debugLog("匿名 Token 缓存已清除");
  }

  registerImportedToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (this.tokens.some((item) => item.token === normalized)) {
      return;
    }
    this.tokens.unshift({
      token: normalized,
      isValid: true,
      lastUsed: 0,
      failureCount: 0,
    });
    debugLog("已注册浏览器捕获会话 Token: %s", maskToken(normalized));
  }

  /**
   * 获取 Token 池大小
   */
  getPoolSize(): number {
    return this.tokens.length;
  }

  /**
   * 检查是否为匿名 Token
   */
  isAnonymousToken(token: string): boolean {
    return this.anonymousToken === token || anonymousBootstrapState?.authToken === token;
  }
}

// 全局 Token 池实例
const tokenPool = new TokenPool();

interface CaptchaSessionState {
  captchaVerifyParam: string | null;
  token: string | null;
  source: string | null;
  updatedAt: number | null;
  useCount: number;
  lastWorkerAttemptAt: number | null;
  lastWorkerError: string | null;
  workerLastPayloadSource: string | null;
}

const captchaSessionState: CaptchaSessionState = {
  captchaVerifyParam: null,
  token: null,
  source: null,
  updatedAt: null,
  useCount: 0,
  lastWorkerAttemptAt: null,
  lastWorkerError: null,
  workerLastPayloadSource: null,
};

let pendingCaptchaFetches = new Map<string, Promise<Record<string, unknown> | null>>();
let cachedResolvedProxyUrlPromise: Promise<string | null> | null = null;

interface UpstreamChatSessionState {
  chatId: string;
  lastUserMessageId: string | null;
  lastAssistantMessageId: string | null;
  updatedAt: number;
}

const upstreamChatSessions = new Map<string, UpstreamChatSessionState>();

function getUpstreamChatSession(token: string): UpstreamChatSessionState | null {
  const session = upstreamChatSessions.get(token);
  if (!session) {
    return null;
  }
  if (Date.now() - session.updatedAt > 30 * 60 * 1000) {
    upstreamChatSessions.delete(token);
    return null;
  }
  return session;
}

function updateUpstreamChatSession(
  token: string,
  update: {
    chatId: string;
    lastUserMessageId?: string | null;
    lastAssistantMessageId?: string | null;
  },
): UpstreamChatSessionState {
  const current = upstreamChatSessions.get(token);
  const next: UpstreamChatSessionState = {
    chatId: update.chatId,
    lastUserMessageId: Object.prototype.hasOwnProperty.call(update, "lastUserMessageId")
      ? update.lastUserMessageId ?? null
      : current?.lastUserMessageId ?? null,
    lastAssistantMessageId: Object.prototype.hasOwnProperty.call(update, "lastAssistantMessageId")
      ? update.lastAssistantMessageId ?? null
      : current?.lastAssistantMessageId ?? null,
    updatedAt: Date.now(),
  };
  upstreamChatSessions.set(token, next);
  return next;
}

function getCaptchaSessionSnapshot() {
  return {
    has_captcha: !!captchaSessionState.captchaVerifyParam,
    has_token: !!captchaSessionState.token,
    source: captchaSessionState.source,
    updated_at: captchaSessionState.updatedAt,
    age_ms: captchaSessionState.updatedAt
      ? Date.now() - captchaSessionState.updatedAt
      : null,
    use_count: captchaSessionState.useCount,
    worker_last_attempt_at: captchaSessionState.lastWorkerAttemptAt,
    worker_last_error: captchaSessionState.lastWorkerError,
    worker_last_payload_source: captchaSessionState.workerLastPayloadSource,
    captcha_preview: captchaSessionState.captchaVerifyParam
      ? captchaSessionState.captchaVerifyParam.slice(0, 48)
      : null,
    token_preview: captchaSessionState.token
      ? captchaSessionState.token.slice(0, 24)
      : null,
  };
}

function isCaptchaSessionFresh(): boolean {
  if (!captchaSessionState.captchaVerifyParam || !captchaSessionState.updatedAt) {
    return false;
  }
  return Date.now() - captchaSessionState.updatedAt <= AUTO_CAPTCHA_SESSION_MAX_AGE_MS;
}

function hasReusableCaptchaVerifyParam(authToken: string): boolean {
  if (!AUTO_CAPTCHA_REUSE_ENABLED) {
    return false;
  }
  if (!isCaptchaSessionFresh()) {
    return false;
  }
  if (!captchaSessionState.captchaVerifyParam) {
    return false;
  }
  if (captchaSessionState.token && captchaSessionState.token !== authToken) {
    return false;
  }
  return captchaSessionState.useCount === 0;
}

function updateCaptchaSessionState(update: {
  captchaVerifyParam?: string | null;
  token?: string | null;
  source?: string | null;
  workerLastPayloadSource?: string | null;
  workerLastError?: string | null;
}) {
  if (Object.prototype.hasOwnProperty.call(update, "captchaVerifyParam")) {
    captchaSessionState.captchaVerifyParam = update.captchaVerifyParam ?? null;
    captchaSessionState.updatedAt = update.captchaVerifyParam ? Date.now() : null;
    captchaSessionState.useCount = update.captchaVerifyParam ? 0 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(update, "token")) {
    captchaSessionState.token = update.token ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(update, "source")) {
    captchaSessionState.source = update.source ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(update, "workerLastPayloadSource")) {
    captchaSessionState.workerLastPayloadSource = update.workerLastPayloadSource ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(update, "workerLastError")) {
    captchaSessionState.lastWorkerError = update.workerLastError ?? null;
  }
}

function markCaptchaVerifyParamConsumed(reason: string) {
  if (!captchaSessionState.captchaVerifyParam) {
    return;
  }
  captchaSessionState.useCount += 1;
  debugLog(
    "captcha_verify_param 已消费: reason=%s use_count=%d source=%s",
    reason,
    captchaSessionState.useCount,
    captchaSessionState.source || "",
  );
}

function invalidateCaptchaVerifyParam(reason: string) {
  if (!captchaSessionState.captchaVerifyParam && !captchaSessionState.updatedAt) {
    return;
  }
  debugLog(
    "丢弃缓存 captcha_verify_param: reason=%s source=%s age_ms=%s use_count=%d",
    reason,
    captchaSessionState.source || "",
    captchaSessionState.updatedAt ? String(Date.now() - captchaSessionState.updatedAt) : "n/a",
    captchaSessionState.useCount,
  );
  captchaSessionState.captchaVerifyParam = null;
  captchaSessionState.updatedAt = null;
  captchaSessionState.useCount = 0;
}

function isUpstreamCaptchaError(errObj: UpstreamError | null | undefined): boolean {
  if (!errObj) return false;
  const code = String(errObj.code ?? "");
  const errorCode = String(errObj.error_code ?? "");
  const captchaErrorType = String(errObj.captcha_error_type ?? "");
  const verifyCode = String(errObj.verify_code ?? "");
  const detail = String(errObj.detail ?? "");
  return (
    code === "FRONTEND_CAPTCHA_REQUIRED" ||
    errorCode === "FRONTEND_CAPTCHA_REQUIRED" ||
    captchaErrorType.length > 0 ||
    verifyCode.length > 0 ||
    detail.includes("人机验证") ||
    /captcha/i.test(detail)
  );
}

type WorkerJsonResponse = Record<string, unknown> & {
  ok?: boolean;
  request_id?: string | null;
  error?: string;
  payload?: Record<string, unknown> | null;
  worker?: Record<string, unknown>;
};

class HiddenPureCodeWorkerBridge {
  private process: Deno.ChildProcess | null = null;
  private processPid: number | null = null;
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: WorkerJsonResponse) => void;
      reject: (reason?: unknown) => void;
      timeoutId: number;
    }
  >();
  private stdoutLoop: Promise<void> | null = null;
  private stderrLoop: Promise<void> | null = null;
  private startupPromise: Promise<void> | null = null;
  private lastReadyPayload: Record<string, unknown> | null = null;
  private lastStdErrLine: string | null = null;
  private staleCleanupAttempted = false;

  private disposeProcess(reason = "manual-reset") {
    const oldPid = this.processPid;
    if (this.stdinWriter) {
      try {
        this.stdinWriter.releaseLock();
      } catch (_err) {
        // ignore
      }
    }
    if (this.process) {
      try {
        this.process.kill("SIGKILL");
      } catch (_err) {
        // ignore
      }
    }
    if (oldPid) {
      try {
        Deno.kill(oldPid, "SIGKILL");
      } catch (_err) {
        // ignore; process may already be gone
      }
    }
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`pure-code worker reset: ${reason}`));
      this.pending.delete(requestId);
    }
    this.process = null;
    this.processPid = null;
    this.stdinWriter = null;
    this.startupPromise = null;
  }

  private async readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) onLine(line);
        }
      }
      if (buffer.trim()) onLine(buffer);
    } finally {
      reader.releaseLock();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.stdinWriter) return;
    if (this.startupPromise) return await this.startupPromise;

    this.startupPromise = (async () => {
      if (!this.staleCleanupAttempted && AUTO_CAPTCHA_PURE_CODE_CLEAN_STALE_WORKERS) {
        this.staleCleanupAttempted = true;
        try {
          const cleanup = new Deno.Command("bash", {
            args: [
              "-lc",
              "pids=$(ps -eo pid=,cmd= | awk '/node tools\\/pure_code_captcha_worker\\.js/ && !/awk/ {print $1}'); if [ -n \"$pids\" ]; then echo \"$pids\" | xargs -r kill; fi",
            ],
            stdout: "null",
            stderr: "null",
          }).spawn();
          await cleanup.status;
          debugLog("pure-code worker 启动前已尝试清理残留进程");
        } catch (error) {
          debugLog("pure-code worker 残留进程清理失败: %s", String(error));
        }
      }

      const command = new Deno.Command("node", {
        args: [
          `--max-old-space-size=${AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB}`,
          "tools/pure_code_captcha_worker.js",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = command.spawn();
      this.process = child;
      this.processPid = child.pid;
      this.stdinWriter = child.stdin.getWriter();
      debugLog(
        "pure-code worker started: pid=%d max_old_space_mb=%d",
        child.pid,
        AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB,
      );

      this.stdoutLoop = this.readLines(child.stdout, (line) => {
        try {
          const payload = JSON.parse(line) as WorkerJsonResponse;
          if (payload.ready) {
            this.lastReadyPayload = payload;
            return;
          }
          const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
          if (requestId && this.pending.has(requestId)) {
            const pending = this.pending.get(requestId)!;
            clearTimeout(pending.timeoutId);
            this.pending.delete(requestId);
            pending.resolve(payload);
            return;
          }
          this.lastReadyPayload = payload;
        } catch (_err) {
          debugLog("pure-code worker stdout(非JSON): %s", line);
        }
      });

      this.stderrLoop = this.readLines(child.stderr, (line) => {
        this.lastStdErrLine = line;
        debugLog("pure-code worker stderr: %s", line);
      });

      child.status.then((status) => {
        const err = new Error(`pure-code worker exited: code=${status.code}`);
        for (const [requestId, pending] of this.pending.entries()) {
          clearTimeout(pending.timeoutId);
          pending.reject(err);
          this.pending.delete(requestId);
        }
        this.process = null;
        this.processPid = null;
        this.stdinWriter = null;
      }).catch((err) => {
        debugLog("pure-code worker status error: %v", err);
      });
    })();

    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  private async request(
    payload: Record<string, unknown>,
    timeoutMs = AUTO_CAPTCHA_PURE_CODE_TIMEOUT_MS,
  ): Promise<WorkerJsonResponse> {
    await this.ensureStarted();
    if (!this.stdinWriter) {
      throw new Error("pure-code worker stdin unavailable");
    }
    const requestId = String(payload.request_id || crypto.randomUUID());
    const finalPayload = { ...payload, request_id: requestId };
    const line = `${JSON.stringify(finalPayload)}\n`;

    return await new Promise<WorkerJsonResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        this.disposeProcess(`timeout:${requestId}`);
        reject(new Error(`pure-code worker request timeout: ${requestId}`));
      }, timeoutMs) as unknown as number;

      this.pending.set(requestId, { resolve, reject, timeoutId });
      this.stdinWriter!.write(new TextEncoder().encode(line)).catch((err) => {
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(err);
      });
    });
  }

  async fetchCaptchaPayload(
    token: string,
    options: Record<string, unknown> | null = null,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.request({
      action: "captcha",
      token,
      options,
    });
    if (!response.ok) {
      throw new Error(response.error || "pure-code worker returned not ok");
    }
    return response.payload || null;
  }

  async probe(includeRaw = false): Promise<WorkerJsonResponse> {
    return await this.request({
      action: "probe",
      include_raw: includeRaw,
    });
  }

  async warm(): Promise<WorkerJsonResponse> {
    return await this.request({ action: "warm" });
  }

  async status(): Promise<WorkerJsonResponse> {
    return await this.request({ action: "status" });
  }

  reset(reason = "manual") {
    this.disposeProcess(reason);
  }

  snapshot() {
    return {
      running: !!this.process,
      has_ready_payload: !!this.lastReadyPayload,
      last_stderr_line: this.lastStdErrLine,
      pending_requests: this.pending.size,
      ready_payload: this.lastReadyPayload,
    };
  }
}

const pureCodeWorkerBridge = new HiddenPureCodeWorkerBridge();

function shouldAttemptAutoCaptcha(modelId: string): boolean {
  return AUTO_CAPTCHA_PURE_CODE_ENABLED && AUTO_CAPTCHA_MODEL_REGEX.test(modelId);
}

function formatBrowserDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BROWSER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const tokenParts = token.split(".");
    if (tokenParts.length !== 3) {
      return null;
    }
    return JSON.parse(new TextDecoder().decode(decodeBase64(tokenParts[1])));
  } catch (_error) {
    return null;
  }
}

function getBrowserUserName(
  token: string,
  profile?: { name?: string | null; email?: string | null } | null,
): string {
  if (UPSTREAM_BROWSER_USER_NAME) {
    return UPSTREAM_BROWSER_USER_NAME;
  }
  const profileName = typeof profile?.name === "string" ? profile.name.trim() : "";
  if (profileName) {
    return profileName;
  }
  const importedProfileName = typeof IMPORTED_BROWSER_CAPTURE_STATE.profileName === "string"
    ? IMPORTED_BROWSER_CAPTURE_STATE.profileName.trim()
    : "";
  if (importedProfileName) {
    return importedProfileName;
  }
  const payload = decodeJwtPayload(token);
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  if (name) {
    return name;
  }
  const profileEmail = typeof profile?.email === "string" ? profile.email.trim() : "";
  if (profileEmail) {
    return profileEmail.split("@")[0] || profileEmail;
  }
  const email = typeof payload?.email === "string" ? payload.email.trim() : "";
  if (email) {
    return email.split("@")[0] || email;
  }
  return `Guest-${Date.now()}`;
}

function formatBrowserWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: BROWSER_TIMEZONE,
  }).format(date);
}

async function tryAttachCaptchaVerifyParam(
  upstreamReq: UpstreamRequest,
  authToken: string,
  modelId: string,
): Promise<void> {
  const shouldAttempt = shouldAttemptAutoCaptcha(modelId);
  debugLog(
    "captcha attach 检查: model=%s shouldAttempt=%s hasExisting=%s",
    modelId,
    String(shouldAttempt),
    String(!!upstreamReq.captcha_verify_param),
  );
  if (upstreamReq.captcha_verify_param) {
    return;
  }

  if (hasReusableCaptchaVerifyParam(authToken)) {
    upstreamReq.captcha_verify_param = captchaSessionState.captchaVerifyParam!;
    markCaptchaVerifyParamConsumed("reuse");
    debugLog("复用缓存 captcha_verify_param: source=%s", captchaSessionState.source);
    return;
  }

  if (!shouldAttempt) {
    return;
  }

  try {
    const payload = await getFreshCaptchaPayload(authToken, upstreamReq.chat_id || "");
    const captchaVerifyParam = typeof payload?.captcha_verify_param === "string"
      ? payload.captcha_verify_param
      : null;
    const payloadSource = typeof payload?.source === "string" ? payload.source : null;
    if (!captchaVerifyParam) {
      debugLog("pure-code worker 未返回可用 captcha_verify_param (source=%s)", payloadSource);
      return;
    }
    if (
      payloadSource !== "pure-code-worker-live-verify" &&
      payloadSource !== "pure-code-worker-compact-live-replay"
    ) {
      debugLog("忽略非真实 live 验证来源的 captcha_verify_param: source=%s", payloadSource);
      return;
    }
    upstreamReq.captcha_verify_param = captchaVerifyParam;
    updateCaptchaSessionState({
      captchaVerifyParam,
      token: authToken,
      source: "pure-code-worker",
      workerLastPayloadSource: payloadSource,
      workerLastError: null,
    });
    markCaptchaVerifyParamConsumed("fresh");
    debugLog("已注入 pure-code captcha_verify_param: %s", captchaVerifyParam.slice(0, 32));
  } catch (error) {
    const message = String(error && (error as Error).stack || error);
    updateCaptchaSessionState({
      workerLastError: message,
    });
    debugLog("pure-code worker 获取 captcha 失败: %s", message);
  }
}

async function getFreshCaptchaPayload(
  authToken: string,
  refererChatID = "",
): Promise<Record<string, unknown> | null> {
  const dedupeKey = `${authToken || "anonymous"}:${refererChatID}`;
  const pending = pendingCaptchaFetches.get(dedupeKey);
  if (pending) {
    return await pending;
  }

  const job = (async () => {
    captchaSessionState.lastWorkerAttemptAt = Date.now();
    let lastError: unknown = null;

    let sessionCookieHeader = "";
    try {
      const session = await upstreamSessionBootstrap.ensureSession(authToken, refererChatID);
      sessionCookieHeader = session.cookieHeader || "";
      debugLog(
        "captcha worker session 已准备: refererChatID=%s cookie_keys=%s",
        refererChatID,
        sessionCookieHeader ? listCookieKeysFromHeader(sessionCookieHeader).join(",") : "",
      );
    } catch (sessionError) {
      debugLog("captcha 前置 session bootstrap 失败: %v", sessionError);
    }

    const workerOptions: Record<string, unknown> = {
      mutateInitAliyunCaptchaConfig: true,
      initialAliyunCaptchaConfig: {
        region: "sgp",
        prefix: "no8xfe",
      },
      requestUrlRewriteMap: {
        "https://no8xfe.captcha-open.aliyuncs.com/": "https://no8xfe.captcha-open-southeast.aliyuncs.com/",
        "https://upload.captcha-open.aliyuncs.com/": "https://upload.captcha-open-southeast.aliyuncs.com/",
      },
      locationHref: refererChatID ? `${ORIGIN_BASE}/c/${refererChatID}` : ORIGIN_BASE,
      referrer: refererChatID ? `${ORIGIN_BASE}/c/${refererChatID}` : `${ORIGIN_BASE}/`,
      localStorageSeed: {
        token: authToken,
      },
      navigatorOverrides: {
        userAgent: getPreferredBrowserUserAgent(),
        appVersion: getPreferredBrowserUserAgent().replace(/^Mozilla\//, ""),
        platform: BROWSER_NAVIGATOR_PLATFORM,
        language: "en-US",
        webdriver: false,
        maxTouchPoints: 0,
      },
      navigatorLanguages: ["en-US", "en"],
      screenOverrides: {
        width: Number(getPreferredBrowserScreenWidth()),
        height: Number(getPreferredBrowserScreenHeight()),
        availWidth: Number(getPreferredBrowserScreenWidth()),
        availHeight: Number(getPreferredBrowserScreenHeight()),
        colorDepth: Number(getPreferredBrowserColorDepth()),
        pixelDepth: Number(getPreferredBrowserColorDepth()),
      },
      autoInitLanguage: "en",
      autoInitConfig: {
        language: "en",
        upLang: true,
      },
      requestHeaders: {
        "Accept": "*/*",
        "User-Agent": getPreferredBrowserUserAgent(),
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Priority": "u=1, i",
        "Referer": "",
        "Sec-Ch-Ua": getPreferredSecChUa(),
        "Sec-Ch-Ua-Mobile": getPreferredSecChUaMobile(),
        "Sec-Ch-Ua-Platform": getPreferredSecChUaPlatform(),
      },
    };
    if (sessionCookieHeader) {
      workerOptions.documentCookie = sessionCookieHeader;
      workerOptions.cookieSeed = cookieHeaderToObject(sessionCookieHeader);
    }
    if (IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID) {
      workerOptions.fallbackCertifyId = IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID;
    }
    debugLog(
      "captcha worker options: hasCookie=%s fallbackCertifyId=%s ua=%s lang=%s tz=%s viewport=%sx%s",
      String(!!sessionCookieHeader),
      IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID || "",
      getPreferredBrowserUserAgent(),
      getPreferredBrowserLanguage(),
      getPreferredBrowserTimezone(),
      getPreferredBrowserViewportWidth(),
      getPreferredBrowserViewportHeight(),
    );

    for (let attempt = 1; attempt <= 2; attempt++) {
      let shouldResetWorker = false;
      try {
        const payload = await pureCodeWorkerBridge.fetchCaptchaPayload(authToken, workerOptions);
        const captchaVerifyParam = typeof payload?.captcha_verify_param === "string"
          ? payload.captcha_verify_param
          : null;
        if (captchaVerifyParam) {
          return payload;
        }
        lastError = new Error(`empty captcha payload on attempt ${attempt}`);
        debugLog("pure-code worker 未返回 captcha_verify_param，准备重试: attempt=%d", attempt);
      } catch (error) {
        lastError = error;
        shouldResetWorker = true;
        debugLog("pure-code worker 获取 captcha 失败，准备重试: attempt=%d error=%s", attempt, String(error));
      }

      if (attempt === 1 && shouldResetWorker) {
        pureCodeWorkerBridge.reset("captcha-retry");
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  })();

  pendingCaptchaFetches.set(dedupeKey, job);
  try {
    return await job;
  } finally {
    pendingCaptchaFetches.delete(dedupeKey);
  }
}

/**
 * 全局状态变量
 */

let stats: RequestStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  lastRequestTime: new Date(),
  averageResponseTime: 0,
};

let liveRequests: LiveRequest[] = [];

/**
 * 图像处理工具类
 */
class ImageProcessor {
  /**
   * 检测消息中是否包含图像内容
   */
  static hasImageContent(messages: Message[]): boolean {
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "image_url" && part.image_url?.url) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * 上传图像到 Z.AI 服务器
   */
  static async uploadImage(imageUrl: string, token: string): Promise<UploadedFile | null> {
    try {
      debugLog("开始上传图像: %s", imageUrl.substring(0, 50) + "...");

      // 处理 base64 图像数据
      let imageData: Uint8Array;
      let filename: string;
      let mimeType: string;

      if (imageUrl.startsWith("data:image/")) {
        // 解析 base64 图像
        const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) {
          throw new Error("Invalid base64 image format");
        }

        mimeType = `image/${matches[1]}`;
        filename = `image.${matches[1]}`;
        const base64Data = matches[2];
        imageData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      } else if (imageUrl.startsWith("http")) {
        // 下载远程图像
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to download image: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "image/jpeg";
        const extension = contentType.split("/")[1] || "jpg";
        filename = `image.${extension}`;

        const buffer = await response.arrayBuffer();
        imageData = new Uint8Array(buffer);
        mimeType = contentType;
      } else {
        throw new Error("Unsupported image URL format");
      }

      // 创建 FormData
      const formData = new FormData();
      const arrayBuffer = imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: mimeType });
      formData.append("file", blob, filename);

      // 上传到 Z.AI
      const uploadResponse = await fetch("https://chat.z.ai/api/files", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Origin": ORIGIN_BASE,
          "Referer": `${ORIGIN_BASE}/`,
        },
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      const uploadResult = await uploadResponse.json() as any;
      debugLog("图像上传成功: %s", uploadResult.id);

      return {
        id: uploadResult.id,
        filename: uploadResult.filename || filename,
        size: imageData.length,
        type: mimeType,
        url: uploadResult.url,
      };
    } catch (error) {
      debugLog("图像上传失败: %v", error);
      return null;
    }
  }

  /**
   * 处理消息中的图像内容，返回处理后的消息和上传的文件列表
   */
  static async processImages(
    messages: Message[],
    token: string,
    isVisionModel: boolean = false
  ): Promise<{ processedMessages: Message[], uploadedFiles: UploadedFile[], uploadedFilesMap: Map<string, UploadedFile> }> {
    const processedMessages: Message[] = [];
    const uploadedFiles: UploadedFile[] = [];
    const uploadedFilesMap = new Map<string, UploadedFile>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const processedMsg: Message = { ...msg };

      if (msg.role === "user" && Array.isArray(msg.content)) {
        const newContent: any[] = [];

        for (const part of msg.content) {
          if (part.type === "image_url" && part.image_url?.url) {
            const imageUrl = part.image_url.url;

            // 上传图像
            const uploadedFile = await this.uploadImage(imageUrl, token);
            if (uploadedFile) {
              if (isVisionModel) {
                // GLM-4.5V: 保留在消息中，但转换 URL 格式
                const newUrl = `${uploadedFile.id}_${uploadedFile.filename}`;
                newContent.push({
                  type: "image_url",
                  image_url: { url: newUrl }
                });
                uploadedFilesMap.set(imageUrl, uploadedFile);
                debugLog("GLM-4.5V 图像 URL 已转换: %s -> %s", imageUrl.substring(0, 50), newUrl);
              } else {
                // 非视觉模型: 添加到文件列表，从消息中移除
                uploadedFiles.push(uploadedFile);
                debugLog("图像已添加到文件列表: %s", uploadedFile.id);
              }
            }
          } else if (part.type === "text") {
            newContent.push(part);
          }
        }

        // 如果只有文本内容，转换为字符串格式
        if (newContent.length === 1 && newContent[0].type === "text") {
          processedMsg.content = newContent[0].text;
        } else if (newContent.length > 0) {
          processedMsg.content = newContent;
        } else {
          processedMsg.content = "";
        }
      }

      processedMessages.push(processedMsg);
    }

    return {
      processedMessages,
      uploadedFiles,
      uploadedFilesMap
    };
  }

  /**
   * 提取最后一条用户消息的文本内容
   */
  static extractLastUserContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          return content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text" && part.text) {
              return part.text;
            }
          }
        }
      }
    }
    return "";
  }
}

/**
 * 工具函数
 */

function debugLog(format: string, ...args: unknown[]): void {
  if (DEBUG_MODE) {
    console.log(`[DEBUG] ${format}`, ...args);
  }
}

function recordRequestStats(
  startTime: number,
  path: string,
  status: number
): void {
  const duration = Date.now() - startTime;

  stats.totalRequests++;
  stats.lastRequestTime = new Date();

  if (status >= 200 && status < 300) {
    stats.successfulRequests++;
  } else {
    stats.failedRequests++;
  }

  // 更新平均响应时间
  if (stats.totalRequests > 0) {
    const totalDuration =
      stats.averageResponseTime * (stats.totalRequests - 1) + duration;
    stats.averageResponseTime = totalDuration / stats.totalRequests;
  } else {
    stats.averageResponseTime = duration;
  }
}

function addLiveRequest(
  method: string,
  path: string,
  status: number,
  duration: number,
  userAgent: string,
  model?: string
): void {
  const request: LiveRequest = {
    id: Date.now().toString(),
    timestamp: new Date(),
    method,
    path,
    status,
    duration,
    userAgent,
    model,
  };

  liveRequests.push(request);

  // 只保留最近的100条请求
  if (liveRequests.length > 100) {
    liveRequests = liveRequests.slice(1);
  }
}

function getLiveRequestsData(): string {
  try {
    // 确保liveRequests是数组
    if (!Array.isArray(liveRequests)) {
      debugLog("liveRequests不是数组，重置为空数组");
      liveRequests = [];
    }

    // 确保返回的数据格式与前端期望的一致
    const requestData = liveRequests.map((req) => ({
      id: req.id || "",
      timestamp: req.timestamp || new Date(),
      method: req.method || "",
      path: req.path || "",
      status: req.status || 0,
      duration: req.duration || 0,
      user_agent: req.userAgent || "",
    }));

    return JSON.stringify(requestData);
  } catch (error) {
    debugLog("获取实时请求数据失败: %v", error);
    return JSON.stringify([]);
  }
}

function getStatsData(): string {
  try {
    // 确保stats对象存在
    if (!stats) {
      debugLog("stats对象不存在，使用默认值");
      stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        lastRequestTime: new Date(),
        averageResponseTime: 0,
      };
    }

    // 确保返回的数据格式与前端期望的一致
    const statsData = {
      totalRequests: stats.totalRequests || 0,
      successfulRequests: stats.successfulRequests || 0,
      failedRequests: stats.failedRequests || 0,
      averageResponseTime: stats.averageResponseTime || 0,
    };

    return JSON.stringify(statsData);
  } catch (error) {
    debugLog("获取统计数据失败: %v", error);
    return JSON.stringify({
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
    });
  }
}

function getClientIP(request: Request): string {
  // 检查X-Forwarded-For头
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const ips = xff.split(",");
    if (ips.length > 0) {
      return ips[0].trim();
    }
  }

  // 检查X-Real-IP头
  const xri = request.headers.get("X-Real-IP");
  if (xri) {
    return xri;
  }

  // 对于Deno Deploy，我们无法直接获取RemoteAddr，返回一个默认值
  return "unknown";
}

function setCORSHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Credentials", "true");
}

function validateApiKey(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const apiKey = authHeader.substring(7);
  return apiKey === DEFAULT_KEY;
}

function mergeSetCookieHeader(
  existingCookieHeader: string,
  setCookieHeader: string | null,
): string {
  const jar = new Map<string, string>();
  for (const part of existingCookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (!setCookieHeader) {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const rawCookies = setCookieHeader
    .split(/,(?=[^;]+=[^;]+)/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const rawCookie of rawCookies) {
    const pair = rawCookie.split(";", 1)[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 24) return token;
  return `${token.slice(0, 12)}...${token.slice(-12)}`;
}

function summarizeCookieHeader(cookieHeader: string): string {
  if (!cookieHeader) return "";
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split("=", 1)[0])
    .join(",");
}

function mergeCookieHeaderValue(
  existingCookieHeader: string,
  cookieHeader: string | null | undefined,
): string {
  const jar = new Map<string, string>();
  for (const part of existingCookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (!cookieHeader) {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  for (const part of cookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeCookieHeaders(...cookieHeaders: Array<string | null | undefined>): string {
  let merged = "";
  for (const cookieHeader of cookieHeaders) {
    if (!cookieHeader) continue;
    merged = mergeCookieHeaderValue(merged, cookieHeader);
  }
  return merged;
}

function cookieHeaderToObject(cookieHeader: string): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!cookieHeader) return jar;
  for (const part of cookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1);
    if (!key) continue;
    jar[key] = value;
  }
  return jar;
}

function listCookieKeysFromHeader(cookieHeader: string): string[] {
  return Object.keys(cookieHeaderToObject(cookieHeader));
}

const IMPORTED_BROWSER_COOKIE_ALLOWLIST = new Set([
  "acw_tc",
  "cdn_sec_tc",
  "token",
  "_c_WBKFRo",
  "_nb_ioWEgULi",
  "ssxmod_itna",
  "ssxmod_itna2",
  "_ga",
  "_ga_Z8QTHYBHP3",
  "_gcl_au",
]);

const STRICT_IMPORTED_BROWSER_COOKIE_ALLOWLIST =
  (Deno.env.get("UPSTREAM_BROWSER_COOKIE_STRICT_ALLOWLIST") || "").trim().toLowerCase() === "true";

interface BrowserCaptureState {
  cookieHeader: string;
  token: string;
  profileId?: string;
  profileEmail?: string;
  profileName?: string;
  profileRole?: string;
  requestProfile?: Partial<BrowserRequestProfile>;
  fingerprintProfile?: Record<string, string>;
}

function sanitizeCapturedCertifyId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined" || isRedactedCaptureValue(trimmed)) {
    return "";
  }
  return trimmed;
}

function pickLatestCertifyIdFromCaptureRecord(input: unknown): string {
  const seen: string[] = [];

  const collectFromPlainObject = (record: Record<string, unknown>) => {
    for (const key of ["CertifyId", "certifyId", "UserCertifyId", "userCertifyId", "cid", "cId"]) {
      const value = sanitizeCapturedCertifyId(record[key]);
      if (value) seen.push(value);
    }
  };

  const collectFromRequestLike = (record: Record<string, unknown>) => {
    const postData = typeof record.postData === "string"
      ? record.postData
      : typeof record.body === "string"
      ? record.body
      : "";
    if (!postData || !postData.includes("=")) return;
    try {
      const params = new URLSearchParams(postData);
      for (const key of ["CertifyId", "certifyId", "UserCertifyId", "userCertifyId", "cid", "cId"]) {
        const value = sanitizeCapturedCertifyId(params.get(key));
        if (value) seen.push(value);
      }
      const captchaVerifyParam = params.get("CaptchaVerifyParam");
      if (captchaVerifyParam) {
        try {
          collectFromPlainObject(JSON.parse(captchaVerifyParam) as Record<string, unknown>);
        } catch {
          // ignore malformed embedded captcha payloads
        }
      }
    } catch {
      // ignore malformed form payloads
    }
  };

  const collectFromJsonBody = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    try {
      walk(JSON.parse(trimmed));
    } catch {
      // ignore malformed embedded json
    }
  };

  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    collectFromPlainObject(record);
    collectFromRequestLike(record);
    if (typeof record.responseBody === "string") collectFromJsonBody(record.responseBody);
    if (typeof record.body === "string" && record.type === "response_body") collectFromJsonBody(record.body);
    const response = record.response && typeof record.response === "object"
      ? record.response as Record<string, unknown>
      : null;
    if (response) {
      collectFromPlainObject(response);
      const content = response.content && typeof response.content === "object"
        ? response.content as Record<string, unknown>
        : null;
      if (typeof content?.text === "string") collectFromJsonBody(content.text);
    }
    const request = record.request && typeof record.request === "object"
      ? record.request as Record<string, unknown>
      : null;
    if (request) {
      collectFromPlainObject(request);
      collectFromRequestLike(request);
      if (typeof request.postData === "object" && request.postData) {
        const postDataRecord = request.postData as Record<string, unknown>;
        if (typeof postDataRecord.text === "string") {
          collectFromRequestLike({ postData: postDataRecord.text });
        }
      }
    }
    if (Array.isArray(record.requestDetails)) {
      for (const item of record.requestDetails) walk(item);
    }
    const logRecord = record.log && typeof record.log === "object"
      ? record.log as Record<string, unknown>
      : null;
    if (Array.isArray(logRecord?.entries)) {
      for (const entry of logRecord.entries as unknown[]) walk(entry);
    }
  };

  walk(input);
  return seen.length > 0 ? seen[seen.length - 1] : "";
}

interface BrowserRequestProfile {
  userAgent: string;
  acceptLanguage: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
}

function isRedactedCaptureValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/^\[(redacted|masked)\]$/i.test(normalized)) return true;
  if (normalized.includes("[REDACTED]") || normalized.includes("[TRUNCATED]")) return true;
  return false;
}

function filterCookieHeaderByAllowlist(cookieHeader: string): string {
  if (!cookieHeader) return "";
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    if (STRICT_IMPORTED_BROWSER_COOKIE_ALLOWLIST && !IMPORTED_BROWSER_COOKIE_ALLOWLIST.has(key)) {
      continue;
    }
    jar.set(key, part.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractTokenFromCookieHeader(cookieHeader: string): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";").map((item) => item.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== "token") continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

function extractCookieHeaderFromUnknownCapture(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const directCookie = typeof record.cookie === "string" ? record.cookie : "";
  if (directCookie && !isRedactedCaptureValue(directCookie) && directCookie.includes("=")) {
    return directCookie;
  }
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  if (
    state && typeof state.cookie === "string" && state.cookie &&
    !isRedactedCaptureValue(state.cookie) &&
    state.cookie.includes("=")
  ) {
    return state.cookie;
  }
  const headers = record.headers && typeof record.headers === "object"
    ? record.headers as Record<string, unknown>
    : null;
  if (headers) {
    const normalizedHeaders = headersToObject(headers);
    const fromHeaders = typeof normalizedHeaders.Cookie === "string"
      ? normalizedHeaders.Cookie
      : typeof normalizedHeaders.cookie === "string"
      ? normalizedHeaders.cookie
      : "";
    if (fromHeaders && !isRedactedCaptureValue(fromHeaders) && fromHeaders.includes("=")) {
      return fromHeaders;
    }
  }
  const requestHeaders = record.requestHeaders && typeof record.requestHeaders === "object"
    ? record.requestHeaders as Record<string, unknown>
    : null;
  if (requestHeaders) {
    const normalizedHeaders = headersToObject(requestHeaders);
    const fromRequestHeaders = typeof normalizedHeaders.Cookie === "string"
      ? normalizedHeaders.Cookie
      : typeof normalizedHeaders.cookie === "string"
      ? normalizedHeaders.cookie
      : "";
    if (fromRequestHeaders && !isRedactedCaptureValue(fromRequestHeaders) && fromRequestHeaders.includes("=")) {
      return fromRequestHeaders;
    }
  }
  const requestRecord = record.request && typeof record.request === "object"
    ? record.request as Record<string, unknown>
    : null;
  if (requestRecord) {
    const normalizedHeaders = headersToObject(requestRecord.headers);
    const fromRequestHeaders = typeof normalizedHeaders.Cookie === "string"
      ? normalizedHeaders.Cookie
      : typeof normalizedHeaders.cookie === "string"
      ? normalizedHeaders.cookie
      : "";
    if (fromRequestHeaders && !isRedactedCaptureValue(fromRequestHeaders) && fromRequestHeaders.includes("=")) {
      return fromRequestHeaders;
    }
  }
  return "";
}

function headersToObject(input: unknown): Record<string, string> {
  if (!input) return {};
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const value = typeof row.value === "string" ? row.value : "";
      if (!name || !value) continue;
      out[name] = value;
    }
    return out;
  }
  if (typeof input === "object") {
    return input as Record<string, string>;
  }
  return {};
}

function extractTokenFromUnknownCapture(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const directToken = typeof record.token === "string" ? record.token.trim() : "";
  if (directToken && !isRedactedCaptureValue(directToken)) {
    return directToken;
  }
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  if (
    state && typeof state.localStorageToken === "string" && state.localStorageToken.trim() &&
    !isRedactedCaptureValue(state.localStorageToken)
  ) {
    return state.localStorageToken.trim();
  }
  if (state && typeof state.token === "string" && state.token.trim() && !isRedactedCaptureValue(state.token)) {
    return state.token.trim();
  }
  const requestHeaders = record.requestHeaders && typeof record.requestHeaders === "object"
    ? record.requestHeaders as Record<string, unknown>
    : null;
  if (requestHeaders) {
    const normalizedHeaders = headersToObject(requestHeaders);
    const authHeader = typeof normalizedHeaders.Authorization === "string"
      ? normalizedHeaders.Authorization
      : typeof normalizedHeaders.authorization === "string"
      ? normalizedHeaders.authorization
      : "";
    if (!isRedactedCaptureValue(authHeader) && authHeader.toLowerCase().startsWith("bearer ")) {
      return authHeader.slice(7).trim();
    }
    const cookieHeader = typeof normalizedHeaders.Cookie === "string"
      ? normalizedHeaders.Cookie
      : typeof normalizedHeaders.cookie === "string"
      ? normalizedHeaders.cookie
      : "";
    const tokenFromCookie = extractTokenFromCookieHeader(cookieHeader);
    if (tokenFromCookie) {
      return tokenFromCookie;
    }
  }
  const headers = record.headers && typeof record.headers === "object"
    ? record.headers as Record<string, unknown>
    : null;
  if (headers) {
    const normalizedHeaders = headersToObject(headers);
    const authHeader = typeof normalizedHeaders.Authorization === "string"
      ? normalizedHeaders.Authorization
      : typeof normalizedHeaders.authorization === "string"
      ? normalizedHeaders.authorization
      : "";
    if (!isRedactedCaptureValue(authHeader) && authHeader.toLowerCase().startsWith("bearer ")) {
      return authHeader.slice(7).trim();
    }
  }
  const requestRecord = record.request && typeof record.request === "object"
    ? record.request as Record<string, unknown>
    : null;
  if (requestRecord) {
    const normalizedHeaders = headersToObject(requestRecord.headers);
    const authHeader = typeof normalizedHeaders.Authorization === "string"
      ? normalizedHeaders.Authorization
      : typeof normalizedHeaders.authorization === "string"
      ? normalizedHeaders.authorization
      : "";
    if (!isRedactedCaptureValue(authHeader) && authHeader.toLowerCase().startsWith("bearer ")) {
      return authHeader.slice(7).trim();
    }
  }
  return extractTokenFromCookieHeader(extractCookieHeaderFromUnknownCapture(record));
}

function extractProfileFromUnknownCapture(input: unknown): Partial<BrowserCaptureState> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  const localStorageToken = state && typeof state.localStorageToken === "string" &&
      !isRedactedCaptureValue(state.localStorageToken)
    ? state.localStorageToken.trim()
    : "";
  const pageTitle = state && typeof state.title === "string" && !isRedactedCaptureValue(state.title)
    ? state.title.trim()
    : "";
  const pageHref = state && typeof state.href === "string" && !isRedactedCaptureValue(state.href)
    ? state.href.trim()
    : "";
  const stateProfile: Partial<BrowserCaptureState> = localStorageToken || pageTitle || pageHref
    ? {
      ...(localStorageToken ? { token: localStorageToken } : {}),
      ...(pageTitle ? { profileName: pageTitle } : {}),
      ...(pageHref ? { profileEmail: pageHref } : {}),
    }
    : {};
  const responseRecord = record.response && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : null;
  const responseContent = responseRecord?.content && typeof responseRecord.content === "object"
    ? responseRecord.content as Record<string, unknown>
    : null;
  const responseBody = typeof record.responseBody === "string"
    ? record.responseBody.trim()
    : typeof record.responseBodySummary === "string"
    ? record.responseBodySummary.trim()
    : typeof responseContent?.text === "string"
    ? responseContent.text.trim()
    : "";
  if (!responseBody || !responseBody.startsWith("{")) {
    return {};
  }
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const token = typeof parsed.token === "string" && !isRedactedCaptureValue(parsed.token)
      ? parsed.token
      : "";
    if (!token) {
      return stateProfile;
    }
    return mergeBrowserCaptureStates(stateProfile, {
      token,
      profileId: typeof parsed.id === "string" ? parsed.id : "",
      profileEmail: typeof parsed.email === "string" ? parsed.email : "",
      profileName: typeof parsed.name === "string" ? parsed.name : "",
      profileRole: typeof parsed.role === "string" ? parsed.role : "",
    });
  } catch {
    return stateProfile;
  }
}

function extractRequestProfileFromHeaders(headers: Record<string, string>): Partial<BrowserRequestProfile> {
  const userAgent = typeof headers["User-Agent"] === "string"
    ? headers["User-Agent"]
    : typeof headers["user-agent"] === "string"
    ? headers["user-agent"]
    : "";
  const acceptLanguage = typeof headers["Accept-Language"] === "string"
    ? headers["Accept-Language"]
    : typeof headers["accept-language"] === "string"
    ? headers["accept-language"]
    : "";
  const secChUa = typeof headers["Sec-Ch-Ua"] === "string"
    ? headers["Sec-Ch-Ua"]
    : typeof headers["sec-ch-ua"] === "string"
    ? headers["sec-ch-ua"]
    : "";
  const secChUaMobile = typeof headers["Sec-Ch-Ua-Mobile"] === "string"
    ? headers["Sec-Ch-Ua-Mobile"]
    : typeof headers["sec-ch-ua-mobile"] === "string"
    ? headers["sec-ch-ua-mobile"]
    : "";
  const secChUaPlatform = typeof headers["Sec-Ch-Ua-Platform"] === "string"
    ? headers["Sec-Ch-Ua-Platform"]
    : typeof headers["sec-ch-ua-platform"] === "string"
    ? headers["sec-ch-ua-platform"]
    : "";
  return {
    ...(userAgent && !isRedactedCaptureValue(userAgent) ? { userAgent } : {}),
    ...(acceptLanguage && !isRedactedCaptureValue(acceptLanguage) ? { acceptLanguage } : {}),
    ...(secChUa && !isRedactedCaptureValue(secChUa) ? { secChUa } : {}),
    ...(secChUaMobile && !isRedactedCaptureValue(secChUaMobile) ? { secChUaMobile } : {}),
    ...(secChUaPlatform && !isRedactedCaptureValue(secChUaPlatform) ? { secChUaPlatform } : {}),
  };
}

function extractFingerprintProfileFromUnknownCapture(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  const stateHref = state && typeof state.href === "string" && !isRedactedCaptureValue(state.href)
    ? state.href.trim()
    : "";
  const stateTitle = state && typeof state.title === "string" && !isRedactedCaptureValue(state.title)
    ? state.title.trim()
    : "";
  const fromPageState: Record<string, string> = {};
  if (stateHref) {
    fromPageState.current_url = stateHref;
    try {
      const pageUrl = new URL(stateHref);
      fromPageState.pathname = pageUrl.pathname;
      fromPageState.referrer = pageUrl.search;
    } catch {
      // ignore malformed page URLs in captures
    }
  }
  if (stateTitle) {
    fromPageState.title = stateTitle;
  }
  const requestRecord = record.request && typeof record.request === "object"
    ? record.request as Record<string, unknown>
    : null;
  const rawUrl = typeof record.url === "string"
    ? record.url
    : typeof requestRecord?.url === "string"
    ? requestRecord.url
    : "";
  if (!rawUrl || !rawUrl.includes("/api/v2/chat/completions")) {
    return fromPageState;
  }
  try {
    const url = new URL(rawUrl);
    const keys = [
      "user_agent",
      "language",
      "languages",
      "timezone",
      "screen_width",
      "screen_height",
      "viewport_height",
      "viewport_width",
      "color_depth",
      "pixel_ratio",
      "timezone_offset",
      "title",
      "browser_name",
      "os_name",
      "current_url",
      "pathname",
      "referrer",
    ];
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = url.searchParams.get(key);
      if (!value || isRedactedCaptureValue(value)) continue;
      out[key] = value;
    }
    return { ...fromPageState, ...out };
  } catch {
    return fromPageState;
  }
}

function mergeBrowserCaptureStates(...states: Array<Partial<BrowserCaptureState> | null | undefined>): BrowserCaptureState {
  const merged: BrowserCaptureState = {
    cookieHeader: "",
    token: "",
    profileId: "",
    profileEmail: "",
    profileName: "",
    profileRole: "",
    requestProfile: {},
    fingerprintProfile: {},
  };
  for (const state of states) {
    if (!state) continue;
    if (typeof state.cookieHeader === "string" && state.cookieHeader) {
      merged.cookieHeader = mergeCookieHeaders(merged.cookieHeader, state.cookieHeader);
    }
    if (typeof state.token === "string" && state.token) {
      merged.token = state.token;
    }
    if (typeof state.profileId === "string" && state.profileId) {
      merged.profileId = state.profileId;
    }
    if (typeof state.profileEmail === "string" && state.profileEmail) {
      merged.profileEmail = state.profileEmail;
    }
    if (typeof state.profileName === "string" && state.profileName) {
      merged.profileName = state.profileName;
    }
    if (typeof state.profileRole === "string" && state.profileRole) {
      merged.profileRole = state.profileRole;
    }
    if (state.requestProfile && typeof state.requestProfile === "object") {
      merged.requestProfile = { ...merged.requestProfile, ...state.requestProfile };
    }
    if (state.fingerprintProfile && typeof state.fingerprintProfile === "object") {
      merged.fingerprintProfile = { ...merged.fingerprintProfile, ...state.fingerprintProfile };
    }
  }
  merged.cookieHeader = filterCookieHeaderByAllowlist(merged.cookieHeader);
  if (!merged.token) {
    merged.token = extractTokenFromCookieHeader(merged.cookieHeader);
  }
  return merged;
}

function extractBrowserCaptureStateFromUnknownCapture(input: unknown): BrowserCaptureState {
  if (!input || typeof input !== "object") {
    return { cookieHeader: "", token: "" };
  }
  const record = input as Record<string, unknown>;
  const direct = mergeBrowserCaptureStates({
    cookieHeader: extractCookieHeaderFromUnknownCapture(record),
    token: extractTokenFromUnknownCapture(record),
    requestProfile: extractRequestProfileFromHeaders(headersToObject(record.requestHeaders || record.headers)),
    fingerprintProfile: extractFingerprintProfileFromUnknownCapture(record),
  }, extractProfileFromUnknownCapture(record));
  const requestDetails = Array.isArray(record.requestDetails) ? record.requestDetails : [];
  const harEntries = Array.isArray((record.log && typeof record.log === "object"
    ? (record.log as Record<string, unknown>).entries
    : null))
    ? ((record.log as Record<string, unknown>).entries as unknown[])
    : [];
  const nested = requestDetails.map((item) =>
    mergeBrowserCaptureStates({
      cookieHeader: extractCookieHeaderFromUnknownCapture(item),
      token: extractTokenFromUnknownCapture(item),
      requestProfile: extractRequestProfileFromHeaders(headersToObject(
        (item && typeof item === "object" ? (item as Record<string, unknown>).requestHeaders : null) ||
        (item && typeof item === "object" ? (item as Record<string, unknown>).headers : null) ||
        ((item && typeof item === "object" && (item as Record<string, unknown>).request &&
          typeof (item as Record<string, unknown>).request === "object")
          ? ((item as Record<string, unknown>).request as Record<string, unknown>).headers
          : null),
      )),
      fingerprintProfile: extractFingerprintProfileFromUnknownCapture(item),
    }, extractProfileFromUnknownCapture(item))
  );
  const harStates = harEntries.map((item) =>
    mergeBrowserCaptureStates({
      cookieHeader: extractCookieHeaderFromUnknownCapture(item),
      token: extractTokenFromUnknownCapture(item),
      requestProfile: extractRequestProfileFromHeaders(headersToObject(
        (item && typeof item === "object" && (item as Record<string, unknown>).request &&
          typeof (item as Record<string, unknown>).request === "object")
          ? ((item as Record<string, unknown>).request as Record<string, unknown>).headers
          : null,
      )),
      fingerprintProfile: extractFingerprintProfileFromUnknownCapture(item),
    }, extractProfileFromUnknownCapture(item))
  );
  return mergeBrowserCaptureStates(direct, ...nested, ...harStates);
}

async function loadBrowserCaptureState(path: string): Promise<BrowserCaptureState> {
  if (!path) return { cookieHeader: "", token: "" };
  const capturePaths = await expandBrowserCapturePaths(path);
  const mergedStates: BrowserCaptureState[] = [];
  for (const capturePath of capturePaths) {
    try {
      const raw = await Deno.readTextFile(capturePath);
      const candidates: BrowserCaptureState[] = [];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              candidates.push(extractBrowserCaptureStateFromUnknownCapture(item));
            }
          } else {
            candidates.push(extractBrowserCaptureStateFromUnknownCapture(parsed));
          }
        } catch {
          // Some capture files are JSONL that start with "{" but contain multiple JSON objects.
          for (const line of trimmed.split(/\r?\n/)) {
            const text = line.trim();
            if (!text.startsWith("{")) continue;
            try {
              const parsed = JSON.parse(text);
              candidates.push(extractBrowserCaptureStateFromUnknownCapture(parsed));
            } catch {
              // ignore malformed jsonl line
            }
          }
        }
      } else {
        for (const line of trimmed.split(/\r?\n/)) {
          const text = line.trim();
          if (!text.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(text);
            candidates.push(extractBrowserCaptureStateFromUnknownCapture(parsed));
          } catch {
            // ignore malformed jsonl line
          }
        }
      }
      const merged = mergeBrowserCaptureStates(...candidates);
      mergedStates.push(merged);
      if (merged.cookieHeader || merged.token) {
        debugLog(
          "已加载浏览器捕获会话: path=%s keys=%s token=%s profile=%s",
          capturePath,
          summarizeCookieHeader(merged.cookieHeader),
          maskToken(merged.token),
          merged.profileName || merged.profileEmail || "",
        );
      } else {
        debugLog("浏览器捕获文件未提取到可用会话: path=%s", capturePath);
      }
    } catch (error) {
      debugLog("加载浏览器捕获会话失败: path=%s error=%s", capturePath, String(error));
    }
  }
  const finalState = mergeBrowserCaptureStates(...mergedStates);
  if (!finalState.cookieHeader && !finalState.token) {
    return { cookieHeader: "", token: "" };
  }
  return finalState;
}

async function loadLatestBrowserCaptureCertifyId(path: string): Promise<string> {
  if (!path) return "";
  const capturePaths = await expandBrowserCapturePaths(path);
  let latestCertifyId = "";
  for (const capturePath of capturePaths) {
    try {
      const raw = await Deno.readTextFile(capturePath);
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const records: unknown[] = [];
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            records.push(...parsed);
          } else {
            records.push(parsed);
          }
        } catch {
          for (const line of trimmed.split(/\r?\n/)) {
            const text = line.trim();
            if (!text.startsWith("{")) continue;
            try {
              records.push(JSON.parse(text));
            } catch {
              // ignore malformed jsonl line
            }
          }
        }
      } else {
        for (const line of trimmed.split(/\r?\n/)) {
          const text = line.trim();
          if (!text.startsWith("{")) continue;
          try {
            records.push(JSON.parse(text));
          } catch {
            // ignore malformed jsonl line
          }
        }
      }
      for (const record of records) {
        const certifyId = pickLatestCertifyIdFromCaptureRecord(record);
        if (certifyId) latestCertifyId = certifyId;
      }
      if (latestCertifyId) {
        debugLog("已从浏览器捕获提取最新 CertifyId: path=%s certifyId=%s", capturePath, latestCertifyId);
      }
    } catch (error) {
      debugLog("提取浏览器捕获 CertifyId 失败: path=%s error=%s", capturePath, String(error));
    }
  }
  return latestCertifyId;
}

async function expandBrowserCapturePaths(pathSpec: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const parts = pathSpec
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const rawPath of parts) {
    await pushBrowserCapturePath(rawPath, out, seen);
    if (rawPath.endsWith(".har")) {
      await pushBrowserCapturePath(rawPath.slice(0, -4) + ".trace", out, seen);
    } else if (rawPath.endsWith(".trace")) {
      await pushBrowserCapturePath(rawPath.slice(0, -6) + ".har", out, seen);
    }
  }
  return out;
}

async function pushBrowserCapturePath(
  path: string,
  out: string[],
  seen: Set<string>,
): Promise<void> {
  if (!path || seen.has(path)) return;
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return;
    seen.add(path);
    out.push(path);
  } catch {
    // ignore missing sibling capture files
  }
}

async function hydrateBrowserCaptureStateViaAuths(
  state: BrowserCaptureState,
): Promise<BrowserCaptureState> {
  if (!state?.cookieHeader) {
    return state;
  }
  if (state.token && state.cookieHeader) {
    return state;
  }
  try {
    const headers = await SmartHeaderGenerator.generateHeaders("");
    const response = await fetchWithCurlFallback(`${ORIGIN_BASE}/api/v1/auths/`, {
      method: "GET",
      headers: {
        ...headers,
        Accept: "*/*",
        Cookie: state.cookieHeader,
      },
    }, "浏览器捕获会话补全 /api/v1/auths/");
    if (!response.ok) {
      debugLog(
        "浏览器捕获会话补全失败: /api/v1/auths/ status=%d cookies=%s",
        response.status,
        summarizeCookieHeader(state.cookieHeader),
      );
      return state;
    }
    const parsed = (await response.json()) as {
      token?: string;
      id?: string;
      email?: string;
      name?: string;
      role?: string;
    };
    const mergedCookieHeader = mergeCookieHeaders(
      state.cookieHeader,
      mergeSetCookieHeader("", response.headers.get("set-cookie")),
      parsed?.token ? `token=${parsed.token}` : "",
    );
    const hydrated = mergeBrowserCaptureStates(state, {
      cookieHeader: mergedCookieHeader,
      token: parsed?.token || "",
      profileId: parsed?.id || "",
      profileEmail: parsed?.email || "",
      profileName: parsed?.name || "",
      profileRole: parsed?.role || "",
    });
    if (hydrated.token && hydrated.token !== state.token) {
      debugLog(
        "浏览器捕获会话已通过 /api/v1/auths/ 补全: token=%s profile=%s cookies=%s",
        maskToken(hydrated.token),
        hydrated.profileName || hydrated.profileEmail || "",
        summarizeCookieHeader(hydrated.cookieHeader),
      );
    }
    return hydrated;
  } catch (error) {
    debugLog("浏览器捕获会话补全异常: %s", String(error));
    return state;
  }
}

const IMPORTED_BROWSER_CAPTURE_STATE = await hydrateBrowserCaptureStateViaAuths(
  await loadBrowserCaptureState(UPSTREAM_BROWSER_COOKIE_CAPTURE_PATH),
);
const IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID = await loadLatestBrowserCaptureCertifyId(
  UPSTREAM_BROWSER_COOKIE_CAPTURE_PATH,
);
IMPORTED_BROWSER_REQUEST_PROFILE = {
  ...(IMPORTED_BROWSER_CAPTURE_STATE.requestProfile || {}),
};
IMPORTED_BROWSER_FINGERPRINT_PROFILE = {
  ...(IMPORTED_BROWSER_CAPTURE_STATE.fingerprintProfile || {}),
};
if (
  Object.keys(IMPORTED_BROWSER_REQUEST_PROFILE).length > 0 ||
  Object.keys(IMPORTED_BROWSER_FINGERPRINT_PROFILE).length > 0
) {
  debugLog(
    "已导入浏览器画像: ua=%s lang=%s tz=%s viewport=%sx%s",
    IMPORTED_BROWSER_REQUEST_PROFILE.userAgent || IMPORTED_BROWSER_FINGERPRINT_PROFILE.user_agent || "",
    IMPORTED_BROWSER_REQUEST_PROFILE.acceptLanguage || IMPORTED_BROWSER_FINGERPRINT_PROFILE.language || "",
    IMPORTED_BROWSER_FINGERPRINT_PROFILE.timezone || "",
    IMPORTED_BROWSER_FINGERPRINT_PROFILE.viewport_width || "",
    IMPORTED_BROWSER_FINGERPRINT_PROFILE.viewport_height || "",
  );
}
if (IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID) {
  debugLog("已导入浏览器捕获最新 CertifyId: %s", IMPORTED_BROWSER_CAPTURE_LATEST_CERTIFY_ID);
}
type UpstreamSessionMode = "anonymous_guest" | "logged_in_cookie" | "configured_token";

interface UpstreamBootstrapSession {
  mode: UpstreamSessionMode;
  cookieHeader: string;
  authToken: string;
  returnedAuthToken?: string;
  profileId?: string;
  profileEmail?: string;
  profileName?: string;
  profileRole?: string;
  requestProfile?: Partial<BrowserRequestProfile>;
  fingerprintProfile?: Record<string, string>;
  updatedAt: number;
  warmedUpAt?: number;
}

let anonymousBootstrapState: UpstreamBootstrapSession | null = null;
let loggedInCookieBootstrapState: UpstreamBootstrapSession | null = null;

function isGuestRole(role: string | null | undefined): boolean {
  return String(role || "").trim().toLowerCase() === "guest";
}

function buildImportedSessionProfiles(): Pick<UpstreamBootstrapSession, "requestProfile" | "fingerprintProfile"> {
  return {
    requestProfile: { ...IMPORTED_BROWSER_REQUEST_PROFILE },
    fingerprintProfile: { ...IMPORTED_BROWSER_FINGERPRINT_PROFILE },
  };
}

function buildImportedCaptureBootstrapSession(
  mode: UpstreamSessionMode,
  authTokenOverride = "",
  roleFallback = "",
): UpstreamBootstrapSession | null {
  if (!IMPORTED_BROWSER_CAPTURE_STATE.cookieHeader && !IMPORTED_BROWSER_CAPTURE_STATE.token) {
    return null;
  }
  const importedToken = (IMPORTED_BROWSER_CAPTURE_STATE.token || "").trim();
  const authToken = (authTokenOverride || importedToken).trim();
  if (!authToken) {
    return null;
  }
  const returnedAuthToken = importedToken || authToken;
  return {
    mode,
    cookieHeader: mergeCookieHeaders(
      IMPORTED_BROWSER_CAPTURE_STATE.cookieHeader || "",
      UPSTREAM_EXTRA_COOKIE_HEADER,
      returnedAuthToken ? `token=${returnedAuthToken}` : "",
    ),
    authToken,
    returnedAuthToken,
    profileId: IMPORTED_BROWSER_CAPTURE_STATE.profileId || "",
    profileEmail: IMPORTED_BROWSER_CAPTURE_STATE.profileEmail || "",
    profileName: IMPORTED_BROWSER_CAPTURE_STATE.profileName || "",
    profileRole: IMPORTED_BROWSER_CAPTURE_STATE.profileRole || roleFallback,
    ...buildImportedSessionProfiles(),
    updatedAt: Date.now(),
  };
}

function buildUpstreamBootstrapSession(
  mode: UpstreamSessionMode,
  authToken: string,
  cookieHeader: string,
  parsed: {
    token?: string;
    id?: string;
    email?: string;
    name?: string;
    role?: string;
  },
): UpstreamBootstrapSession {
  const returnedAuthToken = parsed.token || authToken;
  return {
    mode,
    cookieHeader: mergeCookieHeaders(cookieHeader, returnedAuthToken ? `token=${returnedAuthToken}` : ""),
    authToken,
    returnedAuthToken,
    profileId: parsed.id || "",
    profileEmail: parsed.email || "",
    profileName: parsed.name || "",
    profileRole: parsed.role || "",
    ...buildImportedSessionProfiles(),
    updatedAt: Date.now(),
  };
}

function findBootstrapSessionByToken(token: string): UpstreamBootstrapSession | null {
  const candidates = [loggedInCookieBootstrapState, anonymousBootstrapState];
  for (const session of candidates) {
    if (!session) continue;
    if (session.authToken === token || session.returnedAuthToken === token) {
      return session;
    }
  }
  return null;
}

async function bootstrapAnonymousSession(): Promise<UpstreamBootstrapSession> {
  if (anonymousBootstrapState && (Date.now() - anonymousBootstrapState.updatedAt) <= 25 * 60 * 1000) {
    return anonymousBootstrapState;
  }

  const importedAnonymousSession = buildImportedCaptureBootstrapSession(
    "anonymous_guest",
    IMPORTED_BROWSER_CAPTURE_STATE.token || "",
    "guest",
  );
  const headers = await SmartHeaderGenerator.generateHeaders("");
  let cookieHeader = mergeCookieHeaders(
    importedAnonymousSession?.cookieHeader,
    UPSTREAM_EXTRA_COOKIE_HEADER,
  );
  if (importedAnonymousSession) {
    debugLog(
      "匿名 bootstrap 使用导入 capture 作为种子: token=%s cookies=%s profile=%s",
      maskToken(importedAnonymousSession.authToken),
      summarizeCookieHeader(importedAnonymousSession.cookieHeader),
      importedAnonymousSession.profileName || importedAnonymousSession.profileEmail || "",
    );
  }

  try {
    const pageResponse = await fetch(`${ORIGIN_BASE}/`, {
      method: "GET",
      headers: {
        ...headers,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    cookieHeader = mergeCookieHeaders(
      cookieHeader,
      mergeSetCookieHeader("", pageResponse.headers.get("set-cookie")),
    );
    debugLog(
      "匿名 bootstrap: GET / -> %d cookies=%s",
      pageResponse.status,
      summarizeCookieHeader(cookieHeader),
    );
  } catch (error) {
    debugLog("匿名 bootstrap: GET / 失败: %s", String(error));
  }

  const authResponse = await fetchWithCurlFallback(`${ORIGIN_BASE}/api/v1/auths/`, {
    method: "GET",
    headers: {
      ...headers,
      Accept: "*/*",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  }, "匿名 bootstrap /api/v1/auths/");
  if (!authResponse.ok) {
    throw new Error(`anonymous auth bootstrap failed: ${authResponse.status}`);
  }
  cookieHeader = mergeCookieHeaders(
    cookieHeader,
    mergeSetCookieHeader("", authResponse.headers.get("set-cookie")),
  );

  const parsed = (await authResponse.json()) as {
    token?: string;
    id?: string;
    email?: string;
    name?: string;
    role?: string;
  };
  if (!parsed?.token) {
    if (importedAnonymousSession?.authToken) {
      anonymousBootstrapState = importedAnonymousSession;
      debugLog("匿名 bootstrap 未拿到新 token，回退导入 capture token");
      return anonymousBootstrapState;
    }
    throw new Error("Anonymous token is empty");
  }
  if (!isGuestRole(parsed.role)) {
    throw new Error(`Anonymous auth bootstrap returned non-guest role: ${parsed.role || "unknown"}`);
  }

  anonymousBootstrapState = buildUpstreamBootstrapSession(
    "anonymous_guest",
    parsed.token,
    cookieHeader,
    parsed,
  );
  debugLog(
    "匿名 bootstrap 完成: token=%s cookies=%s profile=%s",
    maskToken(parsed.token),
    summarizeCookieHeader(anonymousBootstrapState.cookieHeader),
    parsed.name || parsed.email || "",
  );
  return anonymousBootstrapState;
}

async function bootstrapLoggedInCookieSession(): Promise<UpstreamBootstrapSession> {
  if (!UPSTREAM_LOGGED_IN_COOKIE_HEADER) {
    throw new Error("UPSTREAM_LOGGED_IN_COOKIE_HEADER is empty");
  }
  if (loggedInCookieBootstrapState && (Date.now() - loggedInCookieBootstrapState.updatedAt) <= 25 * 60 * 1000) {
    return loggedInCookieBootstrapState;
  }

  const headers = await SmartHeaderGenerator.generateHeaders("");
  let cookieHeader = mergeCookieHeaders(
    UPSTREAM_LOGGED_IN_COOKIE_HEADER,
    UPSTREAM_EXTRA_COOKIE_HEADER,
  );
  const response = await fetchWithCurlFallback(`${ORIGIN_BASE}/api/v1/auths/`, {
    method: "GET",
    headers: {
      ...headers,
      Accept: "*/*",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  }, "登录 bootstrap /api/v1/auths/");
  if (!response.ok) {
    throw new Error(`logged-in cookie auth bootstrap failed: ${response.status}`);
  }
  cookieHeader = mergeCookieHeaders(
    cookieHeader,
    mergeSetCookieHeader("", response.headers.get("set-cookie")),
  );
  const parsed = (await response.json()) as {
    token?: string;
    id?: string;
    email?: string;
    name?: string;
    role?: string;
  };
  if (!parsed?.token) {
    throw new Error("Logged-in cookie bootstrap returned empty token");
  }
  if (isGuestRole(parsed.role)) {
    throw new Error("Logged-in cookie bootstrap returned guest role");
  }
  loggedInCookieBootstrapState = buildUpstreamBootstrapSession(
    "logged_in_cookie",
    parsed.token,
    cookieHeader,
    parsed,
  );
  debugLog(
    "登录 cookie bootstrap 完成: token=%s profile=%s role=%s cookies=%s",
    maskToken(parsed.token),
    parsed.name || parsed.email || "",
    parsed.role || "",
    summarizeCookieHeader(loggedInCookieBootstrapState.cookieHeader),
  );
  return loggedInCookieBootstrapState;
}

async function getLoggedInCookieSession(): Promise<UpstreamBootstrapSession> {
  return await bootstrapLoggedInCookieSession();
}

interface UpstreamChatBootstrapResult {
  id?: string;
  meta?: {
    workspace_id?: string;
  };
  chat?: {
    id?: string;
    history?: {
      messages?: Record<string, UpstreamChatHistoryNode>;
      currentId?: string | null;
    };
  };
  message_version?: number;
  type?: string;
}

class UpstreamSessionBootstrap {
  private sessions = new Map<string, UpstreamBootstrapSession>();
  private pending = new Map<string, Promise<UpstreamBootstrapSession>>();
  private readonly maxAgeMs = 25 * 60 * 1000;
  private readonly warmupMaxAgeMs = 5 * 60 * 1000;

  private mergeResponseCookies(token: string, response: Response): void {
    const cached = this.sessions.get(token);
    if (!cached) return;
    cached.cookieHeader = mergeSetCookieHeader(
      cached.cookieHeader,
      response.headers.get("set-cookie"),
    );
    cached.updatedAt = Date.now();
    if (cached.authToken && cached.authToken !== token) {
      this.sessions.set(cached.authToken, cached);
    }
  }

  private isFresh(session: UpstreamBootstrapSession | undefined): boolean {
    return !!session && (Date.now() - session.updatedAt) <= this.maxAgeMs;
  }

  private isWarm(session: UpstreamBootstrapSession | undefined): boolean {
    return !!session?.warmedUpAt && (Date.now() - session.warmedUpAt) <= this.warmupMaxAgeMs;
  }

  private async warmup(session: UpstreamBootstrapSession): Promise<void> {
    if (this.isWarm(session)) {
      return;
    }
    const headers = await SmartHeaderGenerator.generateHeaders("");
    let mergedCookieHeader = mergeCookieHeaders(
      session.cookieHeader,
      UPSTREAM_EXTRA_COOKIE_HEADER,
    );
    const baseHeaders = {
      ...headers,
      Accept: "*/*",
      Authorization: `Bearer ${session.authToken}`,
    };
    const steps: Array<{ method: "GET" | "POST"; endpoint: string; body?: string }> = [
      { method: "GET", endpoint: `${ORIGIN_BASE}/api/config` },
      { method: "GET", endpoint: `${ORIGIN_BASE}/api/models` },
      {
        method: "POST",
        endpoint: `${ORIGIN_BASE}/api/v1/users/user/settings/update`,
        body: JSON.stringify({ ui: { timezone: getPreferredBrowserTimezone() } }),
      },
      { method: "GET", endpoint: `${ORIGIN_BASE}/api/v1/scene-cfg/` },
      { method: "GET", endpoint: `${ORIGIN_BASE}/api/v1/users/user/settings` },
    ];
    for (const step of steps) {
      try {
        const requestHeaders = {
          ...baseHeaders,
          ...(step.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(mergedCookieHeader ? { Cookie: mergedCookieHeader } : {}),
        };
        const response = await fetch(step.endpoint, {
          method: step.method,
          headers: requestHeaders,
          ...(step.body ? { body: step.body } : {}),
        });
        this.mergeWarmupCookies(session, response.headers.get("set-cookie"));
        mergedCookieHeader = mergeCookieHeaders(
          session.cookieHeader,
          UPSTREAM_EXTRA_COOKIE_HEADER,
        );
        debugLog(
          "上游 warmup: %s %s -> %d cookies=%s",
          step.method,
          step.endpoint.replace(ORIGIN_BASE, ""),
          response.status,
          summarizeCookieHeader(mergedCookieHeader),
        );
      } catch (error) {
        debugLog(
          "上游 warmup 失败: %s %s -> %s",
          step.method,
          step.endpoint.replace(ORIGIN_BASE, ""),
          String(error),
        );
      }
    }
    session.warmedUpAt = Date.now();
  }

  private mergeWarmupCookies(session: UpstreamBootstrapSession, setCookieHeader: string | null): void {
    session.cookieHeader = mergeSetCookieHeader(session.cookieHeader, setCookieHeader);
    session.updatedAt = Date.now();
  }

  invalidate(token: string): void {
    const cached = this.sessions.get(token);
    if (cached?.authToken && cached.authToken !== token) {
      this.sessions.delete(cached.authToken);
      this.pending.delete(cached.authToken);
    }
    this.sessions.delete(token);
    this.pending.delete(token);
  }

  async ensureSession(token: string, refererChatID = ""): Promise<UpstreamBootstrapSession> {
    const seeded = findBootstrapSessionByToken(token);
    const cached = this.sessions.get(token) || seeded || undefined;
    if (this.isFresh(cached)) {
      if (cached) {
        this.sessions.set(token, cached);
        if (cached.authToken && cached.authToken !== token) {
          this.sessions.set(cached.authToken, cached);
        }
        if (!this.isWarm(cached)) {
          await this.warmup(cached);
        }
      }
      return cached!;
    }
    const pending = this.pending.get(token);
    if (pending) {
      return await pending;
    }
    const job = this.bootstrap(token, refererChatID);
    this.pending.set(token, job);
    try {
      const session = await job;
      this.sessions.set(token, session);
      if (session.authToken && session.authToken !== token) {
        this.sessions.set(session.authToken, session);
      }
      return session;
    } finally {
      this.pending.delete(token);
    }
  }

  private async bootstrap(token: string, refererChatID = ""): Promise<UpstreamBootstrapSession> {
    const headers = await SmartHeaderGenerator.generateHeaders(refererChatID);
    const seeded = findBootstrapSessionByToken(token);
    const bootstrapCookieHeader = mergeCookieHeaders(
      seeded?.cookieHeader,
      UPSTREAM_EXTRA_COOKIE_HEADER,
    );
    const response = await fetchWithCurlFallback(`${ORIGIN_BASE}/api/v1/auths/`, {
      method: "GET",
      headers: {
        ...headers,
        Accept: "*/*",
        Authorization: `Bearer ${token}`,
        ...(bootstrapCookieHeader ? { Cookie: bootstrapCookieHeader } : {}),
      },
    }, "上游 session bootstrap /api/v1/auths/");
    if (!response.ok) {
      throw new Error(`upstream auth bootstrap failed: ${response.status}`);
    }
    let cookieHeader = mergeCookieHeaders(
      bootstrapCookieHeader,
      mergeSetCookieHeader("", response.headers.get("set-cookie")),
    );
    const bodyText = await response.text();
    let returnedAuthToken = token;
    let profileId = "";
    let profileEmail = "";
    let profileName = "";
    let profileRole = "";
    try {
      const parsed = JSON.parse(bodyText) as {
        token?: string;
        id?: string;
        email?: string;
        name?: string;
        role?: string;
      };
      if (typeof parsed?.token === "string" && parsed.token) {
        returnedAuthToken = parsed.token;
      }
      if (typeof parsed?.id === "string" && parsed.id) {
        profileId = parsed.id;
      }
      if (typeof parsed?.email === "string" && parsed.email) {
        profileEmail = parsed.email;
      }
      if (typeof parsed?.name === "string" && parsed.name) {
        profileName = parsed.name;
      }
      if (typeof parsed?.role === "string" && parsed.role) {
        profileRole = parsed.role;
      }
    } catch {
      // Ignore parse failure and keep using the original token.
    }
    const session = {
      mode: seeded?.mode || "configured_token",
      cookieHeader: mergeCookieHeaders(cookieHeader, `token=${returnedAuthToken}`),
      // 真实前端后续请求继续使用 localStorage 原始 token，而不是 /auths 返回的新 token。
      authToken: token,
      returnedAuthToken,
      profileId,
      profileEmail,
      profileName,
      profileRole,
      requestProfile: seeded?.requestProfile || buildImportedSessionProfiles().requestProfile,
      fingerprintProfile: seeded?.fingerprintProfile || buildImportedSessionProfiles().fingerprintProfile,
      updatedAt: Date.now(),
    };
    debugLog(
      "上游 session bootstrap 完成: has_cookie=%s, token_refreshed=%s, profile_name=%s, cookie_preview=%s",
      cookieHeader ? "true" : "false",
      returnedAuthToken !== token ? "true" : "false",
      profileName || "",
      cookieHeader ? cookieHeader.slice(0, 80) : "",
    );
    await this.warmup(session);
    return session;
  }

  async createChat(
    token: string,
    payload: UpstreamChatBootstrapPayload,
    refererChatID = "",
  ): Promise<UpstreamChatBootstrapResult> {
    const session = await this.ensureSession(token, refererChatID);
    const headers = await SmartHeaderGenerator.generateHeaders(refererChatID);
    const mergedCookieHeader = mergeCookieHeaders(
      session.cookieHeader,
      UPSTREAM_EXTRA_COOKIE_HEADER,
    );
    const response = await fetchWithCurlFallback(`${ORIGIN_BASE}/api/v1/chats/new`, {
      method: "POST",
      headers: {
        ...headers,
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.authToken}`,
        ...(mergedCookieHeader ? { Cookie: mergedCookieHeader } : {}),
      },
      body: JSON.stringify({ chat: payload }),
    }, "上游 chats/new");
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`upstream chats/new failed: ${response.status} ${bodyText.slice(0, 400)}`);
    }
    this.mergeResponseCookies(token, response);
    const parsed = JSON.parse(bodyText) as UpstreamChatBootstrapResult;
    debugLog(
      "上游 chats/new 完成: chat_id=%s message_version=%s",
      parsed?.id || parsed?.chat?.id || "",
      parsed?.message_version ?? "",
    );
    return parsed;
  }
}

const upstreamSessionBootstrap = new UpstreamSessionBootstrap();

async function getAnonymousToken(): Promise<string> {
  try {
    const session = await bootstrapAnonymousSession();
    return session.authToken;
  } catch (error) {
    debugLog("获取匿名token失败: %v", error);
    throw error;
  }
}

/**
 * 生成Z.ai API请求签名
 * @param e "requestId,request_id,timestamp,timestamp,user_id,user_id"
 * @param t 用户最新消息
 * @param timestamp 时间戳 (毫秒)
 * @returns { signature: string, timestamp: number }
 */
async function generateSignature(
  e: string,
  t: string,
  timestamp: number
): Promise<{ signature: string; timestamp: string }> {
  const timestampStr = String(timestamp);

  // 1. 对消息内容进行Base64编码
  const bodyEncoded = new TextEncoder().encode(t);
  const bodyBase64 = btoa(String.fromCharCode(...bodyEncoded));

  // 2. 构造待签名字符串
  const stringToSign = `${e}|${bodyBase64}|${timestampStr}`;

  // 3. 计算5分钟时间窗口
  const timeWindow = Math.floor(timestamp / (5 * 60 * 1000));

  // 4. 获取签名密钥
  const secretEnv = Deno.env.get("ZAI_SIGNING_SECRET");
  let rootKey: Uint8Array;

  if (secretEnv) {
    // 从环境变量读取密钥
    if (/^[0-9a-fA-F]+$/.test(secretEnv) && secretEnv.length % 2 === 0) {
      // HEX 格式
      rootKey = new Uint8Array(secretEnv.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    } else {
      // UTF-8 格式
      rootKey = new TextEncoder().encode(secretEnv);
    }
    debugLog("使用环境变量密钥: %s", secretEnv.substring(0, 10) + "...");
  } else {
    // 使用新的默认密钥（与 Python 版本一致）
    const defaultKeyHex = "6b65792d40404040292929282928283929292d787878782626262525252525";
    rootKey = new Uint8Array(defaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    debugLog("使用默认密钥");
  }

  // 5. 第一层 HMAC，生成中间密钥
  const rootKeyBuffer = rootKey.buffer.slice(rootKey.byteOffset, rootKey.byteOffset + rootKey.byteLength) as ArrayBuffer;
  const firstHmacKey = await crypto.subtle.importKey(
    "raw",
    rootKeyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const firstSignatureBuffer = await crypto.subtle.sign(
    "HMAC",
    firstHmacKey,
    new TextEncoder().encode(String(timeWindow))
  );
  const intermediateKey = Array.from(new Uint8Array(firstSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 5. 第二层 HMAC，生成最终签名
  const secondKeyMaterial = new TextEncoder().encode(intermediateKey);
  const secondHmacKey = await crypto.subtle.importKey(
    "raw",
    secondKeyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const finalSignatureBuffer = await crypto.subtle.sign(
    "HMAC",
    secondHmacKey,
    new TextEncoder().encode(stringToSign)
  );
  const signature = Array.from(new Uint8Array(finalSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  debugLog("新版签名生成成功: %s", signature);
  return {
    signature,
    timestamp: timestampStr,
  };
}

function parseHeaderBlock(raw: string): Headers {
  const headers = new Headers();
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const lastBlock = blocks[blocks.length - 1] || "";
  for (const line of lastBlock.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    headers.append(key, value);
  }
  return headers;
}

function extractLastHttpHeaderBlock(raw: string): string {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].startsWith("HTTP/")) {
      return blocks[i];
    }
  }
  return blocks[blocks.length - 1] || "";
}

async function runCurlCommand(args: string[], stdinText?: string): Promise<void> {
  const proxyUrl = await resolveUpstreamProxyUrl();
  const baseArgs = ["--compressed", ...args];
  const finalArgs = proxyUrl ? ["--proxy", proxyUrl, ...baseArgs] : baseArgs;
  const child = new Deno.Command("curl", {
    args: finalArgs,
    stdin: stdinText != null ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdinText != null) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    writer.releaseLock();
    await child.stdin.close();
  }
  const [status, stderrBytes] = await Promise.all([child.status, child.stderr.getReader().read()]);
  if (!status.success) {
    const stderrText = stderrBytes.value ? new TextDecoder().decode(stderrBytes.value) : "";
    throw new Error(`curl failed (${status.code}): ${stderrText}`);
  }
}

async function readCommandStdout(command: string, args: string[]): Promise<string> {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const [status, stdoutChunk] = await Promise.all([
    child.status,
    child.stdout.getReader().read(),
  ]);
  if (!status.success) {
    throw new Error(`${command} failed: ${status.code}`);
  }
  return stdoutChunk.value ? new TextDecoder().decode(stdoutChunk.value).trim() : "";
}

function parseHostResolveOverrides(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const host = part.slice(0, idx).trim().toLowerCase();
    const ip = part.slice(idx + 1).trim();
    if (host && ip) {
      out[host] = ip;
    }
  }
  return out;
}

const HOST_RESOLVE_OVERRIDES = parseHostResolveOverrides(UPSTREAM_HOST_RESOLVE_OVERRIDES);

function getCurlResolveArgsForUrl(targetUrl: string): string[] {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.trim().toLowerCase();
    const ip = HOST_RESOLVE_OVERRIDES[host];
    if (!ip) return [];
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return ["--resolve", `${parsed.hostname}:${port}:${ip}`];
  } catch {
    return [];
  }
}

function hasCurlResolveOverride(targetUrl: string): boolean {
  return getCurlResolveArgsForUrl(targetUrl).length > 0;
}

async function detectSystemProxyUrl(): Promise<string | null> {
  if (!UPSTREAM_SYSTEM_PROXY_AUTO_DETECT) {
    return null;
  }

  try {
    const mode = await readCommandStdout("gsettings", [
      "get",
      "org.gnome.system.proxy",
      "mode",
    ]);
    if (!mode.includes("manual")) {
      return null;
    }

    const httpHost = (await readCommandStdout("gsettings", [
      "get",
      "org.gnome.system.proxy.http",
      "host",
    ])).replaceAll("'", "").trim();
    const httpPort = (await readCommandStdout("gsettings", [
      "get",
      "org.gnome.system.proxy.http",
      "port",
    ])).trim();
    if (httpHost && httpPort && httpPort !== "0") {
      return `http://${httpHost}:${httpPort}`;
    }

    const socksHost = (await readCommandStdout("gsettings", [
      "get",
      "org.gnome.system.proxy.socks",
      "host",
    ])).replaceAll("'", "").trim();
    const socksPort = (await readCommandStdout("gsettings", [
      "get",
      "org.gnome.system.proxy.socks",
      "port",
    ])).trim();
    if (socksHost && socksPort && socksPort !== "0") {
      return `socks5h://${socksHost}:${socksPort}`;
    }
  } catch (error) {
    debugLog("系统代理探测失败: %v", error);
  }

  return null;
}

function detectEnvProxyUrl(): string | null {
  const candidates = [
    Deno.env.get("HTTPS_PROXY"),
    Deno.env.get("https_proxy"),
    Deno.env.get("ALL_PROXY"),
    Deno.env.get("all_proxy"),
    Deno.env.get("HTTP_PROXY"),
    Deno.env.get("http_proxy"),
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }
  return null;
}

async function resolveUpstreamProxyUrl(): Promise<string | null> {
  if (cachedResolvedProxyUrlPromise) {
    return cachedResolvedProxyUrlPromise;
  }

  cachedResolvedProxyUrlPromise = (async () => {
    if (UPSTREAM_PROXY_URL.trim()) {
      return UPSTREAM_PROXY_URL.trim();
    }
    const systemProxyUrl = await detectSystemProxyUrl();
    if (systemProxyUrl) {
      return systemProxyUrl;
    }
    const envProxyUrl = detectEnvProxyUrl();
    if (envProxyUrl) {
      return envProxyUrl;
    }
    return null;
  })();

  const proxyUrl = await cachedResolvedProxyUrlPromise;
  if (proxyUrl) {
    debugLog("上游代理已启用: %s", proxyUrl);
  } else {
    debugLog("上游代理未启用");
  }
  return proxyUrl;
}

function shouldFallbackToCurlForFetchError(error: unknown): boolean {
  const text = String(error && (error as Error).stack || error).toLowerCase();
  return (
    text.includes("unsuccessful tunnel") ||
    text.includes("proxy") ||
    text.includes("client error (connect)") ||
    text.includes("httpconnect") ||
    text.includes("tunnel")
  );
}

async function callSimpleCurlRequest(
  fullURL: string,
  init: RequestInit,
): Promise<Response> {
  const headerFile = await Deno.makeTempFile({ suffix: ".headers.txt" });
  const bodyFile = await Deno.makeTempFile({ suffix: ".body.txt" });
  try {
    const method = String(init.method || "GET").toUpperCase();
    const finalHeaders = headersToObject(init.headers || {});
    const args = [
      "-sS",
      "-L",
      "-D",
      headerFile,
      "-o",
      bodyFile,
      "-X",
      method,
      ...getCurlResolveArgsForUrl(fullURL),
      fullURL,
    ];
    for (const [key, value] of Object.entries(finalHeaders)) {
      args.push("-H", `${key}: ${value}`);
    }

    let stdinText: string | undefined = undefined;
    if (init.body != null) {
      if (typeof init.body === "string") {
        stdinText = init.body;
      } else if (init.body instanceof Uint8Array) {
        stdinText = new TextDecoder().decode(init.body);
      } else {
        stdinText = String(init.body);
      }
      args.push("--data-binary", "@-");
    }

    await runCurlCommand(args, stdinText);

    const headerRaw = await Deno.readTextFile(headerFile);
    const bodyText = await Deno.readTextFile(bodyFile);
    const lastHeaderBlock = extractLastHttpHeaderBlock(headerRaw);
    const headers = parseHeaderBlock(lastHeaderBlock);
    const statusLine = lastHeaderBlock.split(/\r?\n/)[0] || "HTTP/1.1 502";
    const status = Number(statusLine.split(" ")[1] || "502");
    return new Response(bodyText, {
      status,
      headers,
    });
  } finally {
    await Promise.all([
      Deno.remove(headerFile).catch(() => undefined),
      Deno.remove(bodyFile).catch(() => undefined),
    ]);
  }
}

async function fetchWithCurlFallback(
  fullURL: string,
  init: RequestInit,
  logLabel: string,
): Promise<Response> {
  const proxyUrl = await resolveUpstreamProxyUrl();
  if (proxyUrl) {
    debugLog("%s 检测到代理，直接使用 curl 请求: %s", logLabel, proxyUrl);
    return await callSimpleCurlRequest(fullURL, init);
  }
  try {
    return await fetch(fullURL, init);
  } catch (error) {
    if (!shouldFallbackToCurlForFetchError(error)) {
      throw error;
    }
    debugLog("%s fetch 失败，尝试 curl 回退: %s", logLabel, String(error));
    return await callSimpleCurlRequest(fullURL, init);
  }
}

async function callUpstreamWithCurl(
  fullURL: string,
  finalHeaders: Record<string, string>,
  authToken: string,
  reqBody: string,
): Promise<Response> {
  const cookieJar = await Deno.makeTempFile({ suffix: ".cookies.txt" });
  const headerFile = await Deno.makeTempFile({ suffix: ".headers.txt" });
  const bodyFile = await Deno.makeTempFile({ suffix: ".body.txt" });
  try {
    const authArgs = [
      "-sS",
      "-L",
      "-c",
      cookieJar,
      ...getCurlResolveArgsForUrl(`${ORIGIN_BASE}/api/v1/auths/`),
      `${ORIGIN_BASE}/api/v1/auths/`,
      "-H",
      `User-Agent: ${getPreferredBrowserUserAgent()}`,
      "-H",
      "Accept: */*",
      "-H",
      `Accept-Language: ${getPreferredBrowserAcceptLanguage()}`,
      "-H",
      `X-FE-Version: ${X_FE_VERSION}`,
      "-H",
      `sec-ch-ua: ${getPreferredSecChUa()}`,
      "-H",
      `sec-ch-ua-mobile: ${getPreferredSecChUaMobile()}`,
      "-H",
      `sec-ch-ua-platform: ${getPreferredSecChUaPlatform()}`,
      "-H",
      `Origin: ${ORIGIN_BASE}`,
      "-H",
      `Referer: ${ORIGIN_BASE}/`,
      "-H",
      `Authorization: Bearer ${authToken}`,
      "-o",
      "/dev/null",
    ];
    await runCurlCommand(authArgs).catch((error) => {
      debugLog("curl auth bootstrap 失败: %s", String(error));
    });

    const chatArgs = [
      "-sS",
      "-D",
      headerFile,
      "-o",
      bodyFile,
      "-b",
      cookieJar,
      "-X",
      "POST",
      ...getCurlResolveArgsForUrl(fullURL),
      fullURL,
    ];
    for (const [key, value] of Object.entries(finalHeaders)) {
      chatArgs.push("-H", `${key}: ${value}`);
    }
    chatArgs.push("--data-binary", "@-");
    await runCurlCommand(chatArgs, reqBody);

    const headerRaw = await Deno.readTextFile(headerFile);
    const bodyText = await Deno.readTextFile(bodyFile);
    const lastHeaderBlock = extractLastHttpHeaderBlock(headerRaw);
    const headers = parseHeaderBlock(lastHeaderBlock);
    const statusLine = lastHeaderBlock
      .split(/\r?\n/)[0] || "HTTP/1.1 502";
    const status = Number(statusLine.split(" ")[1] || "502");
    return new Response(bodyText, {
      status,
      headers,
    });
  } finally {
    await Promise.all([
      Deno.remove(cookieJar).catch(() => undefined),
      Deno.remove(headerFile).catch(() => undefined),
      Deno.remove(bodyFile).catch(() => undefined),
    ]);
  }
}

async function callUpstreamWithImpersonatedClient(
  fullURL: string,
  finalHeaders: Record<string, string>,
  authToken: string,
  reqBody: string,
): Promise<Response> {
  const proxyUrl = await resolveUpstreamProxyUrl();
  const authHeaders: Record<string, string> = {
    "User-Agent": getPreferredBrowserUserAgent(),
    "Accept": "*/*",
    "Accept-Language": getPreferredBrowserAcceptLanguage(),
    "X-FE-Version": X_FE_VERSION,
    "sec-ch-ua": getPreferredSecChUa(),
    "sec-ch-ua-mobile": getPreferredSecChUaMobile(),
    "sec-ch-ua-platform": getPreferredSecChUaPlatform(),
    "Origin": ORIGIN_BASE,
    "Referer": `${ORIGIN_BASE}/`,
    "Authorization": `Bearer ${authToken}`,
  };
  const scriptPayload = {
    proxy_url: proxyUrl,
    auth_url: `${ORIGIN_BASE}/api/v1/auths/`,
    target_url: fullURL,
    auth_headers: authHeaders,
    final_headers: finalHeaders,
    body: reqBody,
    impersonate: UPSTREAM_IMPERSONATE_BROWSER,
  };

  const child = new Deno.Command("python", {
    args: ["tools/upstream_impersonated_request.py"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(scriptPayload)));
  writer.releaseLock();
  await child.stdin.close();

  const [status, stdoutChunk, stderrChunk] = await Promise.all([
    child.status,
    child.stdout.getReader().read(),
    child.stderr.getReader().read(),
  ]);

  const stdoutText = stdoutChunk.value ? new TextDecoder().decode(stdoutChunk.value) : "";
  const stderrText = stderrChunk.value ? new TextDecoder().decode(stderrChunk.value) : "";
  if (!status.success) {
    throw new Error(`impersonated client failed (${status.code}): ${stderrText || stdoutText}`);
  }

  let parsed: {
    status?: number;
    reason?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  try {
    parsed = JSON.parse(stdoutText);
  } catch (error) {
    throw new Error(`impersonated client parse failed: ${String(error)} stdout=${stdoutText.slice(0, 500)}`);
  }

  return new Response(parsed.body || "", {
    status: parsed.status || 502,
    statusText: parsed.reason || "",
    headers: new Headers(parsed.headers || {}),
  });
}

async function callUpstreamWithHeaders(
  upstreamReq: UpstreamRequest,
  refererChatID: string,
  authToken: string
): Promise<Response> {
  try {
    debugLog("调用上游API: %s", UPSTREAM_URL);

    // 1. 解码JWT获取user_id（多字段支持，与 Python 版本一致）
    let userId = "unknown";
    try {
      const tokenParts = authToken.split(".");
      if (tokenParts.length === 3) {
        const payload = JSON.parse(
          new TextDecoder().decode(decodeBase64(tokenParts[1]))
        );

        // 尝试多个可能的 user_id 字段（与 Python 版本一致）
        for (const key of ["id", "user_id", "uid", "sub"]) {
          const val = payload[key];
          if (typeof val === "string" || typeof val === "number") {
            const strVal = String(val);
            if (strVal.length > 0) {
              userId = strVal;
              debugLog("从JWT解析到 user_id: %s (字段: %s)", userId, key);
              break;
            }
          }
        }
      }
    } catch (e) {
      debugLog("解析JWT失败: %v", e);
    }

    // 2. 准备签名所需参数
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const lastMessageContent = ImageProcessor.extractLastUserContent(upstreamReq.messages);

    if (!lastMessageContent) {
      throw new Error("无法获取用于签名的用户消息内容");
    }

    const e = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;

    // 3. 生成新签名
    const { signature } = await generateSignature(
      e,
      lastMessageContent,
      timestamp
    );
    debugLog("生成新版签名: %s", signature);

    const reqBody = JSON.stringify(upstreamReq);
    debugLog("上游请求体: %s", reqBody);

    // 4. 生成智能浏览器头部
    const smartHeaders = await SmartHeaderGenerator.generateHeaders(refererChatID);
    let sessionCookieHeader = "";
    try {
      const session = await upstreamSessionBootstrap.ensureSession(authToken, refererChatID);
      sessionCookieHeader = session.cookieHeader || "";
    } catch (sessionError) {
      debugLog("上游 session bootstrap 失败: %v", sessionError);
    }
    const mergedSessionCookieHeader = mergeCookieHeaders(
      sessionCookieHeader,
      UPSTREAM_EXTRA_COOKIE_HEADER,
    );

    // 5. 生成完整的浏览器指纹参数
    const fingerprintParams = BrowserFingerprintGenerator.generateFingerprintParams(
      timestamp,
      requestId,
      authToken,
      refererChatID
    );

    // 6. 构建完整的URL参数
    const allParams = {
      ...fingerprintParams,
      signature_timestamp: timestamp.toString(),
    };

    const params = new URLSearchParams(allParams);
    const fullURL = `${UPSTREAM_URL}?${params.toString()}`;
    const queryToken = params.get("token") || "";

    // 7. 合并头部
    const finalHeaders: Record<string, string> = {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "*/*",
      "Content-Type": "application/json",
      "Accept-Language": smartHeaders["Accept-Language"] || getPreferredBrowserAcceptLanguage(),
      "Origin": ORIGIN_BASE,
      "Referer": "",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Ch-Ua": getPreferredSecChUa(),
      "Sec-Ch-Ua-Mobile": getPreferredSecChUaMobile(),
      "Sec-Ch-Ua-Platform": getPreferredSecChUaPlatform(),
      "User-Agent": getPreferredBrowserUserAgent(),
      "X-FE-Version": X_FE_VERSION,
      "X-Region": BROWSER_REGION,
      "X-Signature": signature,
      ...(mergedSessionCookieHeader ? { "Cookie": mergedSessionCookieHeader } : {}),
    };

    debugLog(
      "上游请求关键头: referer=%s origin=%s x-fe-version=%s x-region=%s sec-fetch-site=%s ua=%s",
      finalHeaders["Referer"] || "",
      finalHeaders["Origin"] || "",
      finalHeaders["X-FE-Version"] || "",
      finalHeaders["X-Region"] || "",
      finalHeaders["Sec-Fetch-Site"] || "",
      finalHeaders["User-Agent"] || "",
    );
    debugLog(
      "上游会话态: auth=%s query_token=%s cookie_keys=%s",
      maskToken(authToken),
      maskToken(queryToken),
      summarizeCookieHeader(mergedSessionCookieHeader),
    );
    debugLog("上游请求 URL: %s", fullURL);

    const transportPreference = ["auto", "fetch", "curl", "impersonate"].includes(UPSTREAM_TRANSPORT_PREFERENCE)
      ? UPSTREAM_TRANSPORT_PREFERENCE
      : "auto";
    let response: Response;
    if (transportPreference === "curl") {
      debugLog("上游传输模式: curl");
      response = await callUpstreamWithCurl(fullURL, finalHeaders, authToken, reqBody);
      debugLog("curl transport 上游响应状态: %d %s", response.status, response.statusText);
    } else if (transportPreference === "impersonate") {
      debugLog("上游传输模式: impersonate");
      response = await callUpstreamWithImpersonatedClient(fullURL, finalHeaders, authToken, reqBody);
      debugLog("impersonated transport 上游响应状态: %d %s", response.status, response.statusText);
    } else {
      if (hasCurlResolveOverride(fullURL)) {
        debugLog("上游传输模式: auto(检测到 --resolve 覆盖，优先 curl)");
        response = await callUpstreamWithCurl(fullURL, finalHeaders, authToken, reqBody);
        debugLog("curl transport 上游响应状态: %d %s", response.status, response.statusText);
      } else {
      if (transportPreference !== "fetch") {
        debugLog("上游传输模式: auto(fetch 优先)");
      } else {
        debugLog("上游传输模式: fetch");
      }
      response = await fetch(fullURL, {
        method: "POST",
        headers: finalHeaders,
        body: reqBody,
      });

      debugLog("上游响应状态: %d %s", response.status, response.statusText);
      if (transportPreference === "auto" && (response.status === 404 || response.status === 405)) {
        debugLog("检测到 Deno fetch 上游异常状态，切换 impersonated transport 重试: %d", response.status);
        response = await callUpstreamWithImpersonatedClient(fullURL, finalHeaders, authToken, reqBody);
        debugLog("impersonated transport 上游响应状态: %d %s", response.status, response.statusText);
        if (response.status === 404 || response.status === 405) {
          debugLog("impersonated transport 仍异常，切换 curl transport 重试: %d", response.status);
          response = await callUpstreamWithCurl(fullURL, finalHeaders, authToken, reqBody);
          debugLog("curl transport 上游响应状态: %d %s", response.status, response.statusText);
        }
      }
      }
    }
    if (response.status === 401 || response.status === 403 || response.status === 405) {
      upstreamSessionBootstrap.invalidate(authToken);
    }

    // 8. 成功时标记 Token 为有效
    tokenPool.markSuccess(authToken);

    return response;
  } catch (error) {
    debugLog("调用上游失败: %v", error);
    try {
      debugLog("尝试直接使用 impersonated transport 兜底");
      const timestamp = Date.now();
      const requestId = crypto.randomUUID();
      const lastMessageContent = ImageProcessor.extractLastUserContent(upstreamReq.messages);
      if (!lastMessageContent) {
        throw error;
      }
      let userId = "unknown";
      try {
        const tokenParts = authToken.split(".");
        if (tokenParts.length === 3) {
          const payload = JSON.parse(
            new TextDecoder().decode(decodeBase64(tokenParts[1]))
          );
          for (const key of ["id", "user_id", "uid", "sub"]) {
            const val = payload[key];
            if (typeof val === "string" || typeof val === "number") {
              const strVal = String(val);
              if (strVal.length > 0) {
                userId = strVal;
                break;
              }
            }
          }
        }
      } catch (_innerErr) {
        // ignore
      }
      const e = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;
      const { signature } = await generateSignature(e, lastMessageContent, timestamp);
      const smartHeaders = await SmartHeaderGenerator.generateHeaders(refererChatID);
      const fingerprintParams = BrowserFingerprintGenerator.generateFingerprintParams(
        timestamp,
        requestId,
        authToken,
        refererChatID
      );
      const fullURL = `${UPSTREAM_URL}?${new URLSearchParams({
        ...fingerprintParams,
        signature_timestamp: timestamp.toString(),
      }).toString()}`;
      const finalHeaders = {
        ...smartHeaders,
        "Authorization": `Bearer ${authToken}`,
        "X-Signature": signature,
        "Accept": "application/json, text/event-stream",
      };
      const reqBody = JSON.stringify(upstreamReq);
      try {
        return await callUpstreamWithImpersonatedClient(fullURL, finalHeaders, authToken, reqBody);
      } catch (impersonatedError) {
        debugLog("impersonated transport 兜底失败: %v", impersonatedError);
      }
      return await callUpstreamWithCurl(fullURL, finalHeaders, authToken, reqBody);
    } catch (curlError) {
      debugLog("curl transport 兜底失败: %v", curlError);
    }

    // 失败时尝试切换 Token
    try {
      const newToken = await tokenPool.switchToNext();
      if (newToken) {
        debugLog("切换到新 Token 重试: %s", newToken.substring(0, 20));
        // 递归重试一次，避免无限循环
        return callUpstreamWithHeaders(upstreamReq, refererChatID, newToken);
      }
    } catch (retryError) {
      debugLog("Token 切换重试失败: %v", retryError);
    }

    throw error;
  }
}

function transformThinking(content: string): string {
  // 去 <summary>…</summary>
  let result = content.replace(/<summary>.*?<\/summary>/gs, "");
  // 清理残留自定义标签，如 </thinking>、<Full> 等
  result = result.replace(/<\/thinking>/g, "");
  result = result.replace(/<Full>/g, "");
  result = result.replace(/<\/Full>/g, "");
  result = result.trim();

  switch (THINK_TAGS_MODE as "strip" | "think" | "raw") {
    case "think":
      result = result.replace(/<details[^>]*>/g, "<thinking>");
      result = result.replace(/<\/details>/g, "</thinking>");
      break;
    case "strip":
      result = result.replace(/<details[^>]*>/g, "");
      result = result.replace(/<\/details>/g, "");
      break;
  }

  // 处理每行前缀 "> "（包括起始位置）
  result = result.replace(/^> /, "");
  result = result.replace(/\n> /g, "\n");
  return result.trim();
}

async function processUpstreamStream(
  body: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  modelName: string
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.substring(6);
          if (dataStr === "") continue;

          debugLog("收到SSE数据: %s", dataStr);

          try {
            const upstreamData = JSON.parse(dataStr) as UpstreamData;

            // 错误检测
            if (
              upstreamData.error ||
              upstreamData.data.error ||
              (upstreamData.data.inner && upstreamData.data.inner.error)
            ) {
              const errObj =
                upstreamData.error ||
                upstreamData.data.error ||
                (upstreamData.data.inner && upstreamData.data.inner.error);
              debugLog(
                "上游错误: code=%d, detail=%s",
                errObj?.code,
                errObj?.detail
              );
              if (isUpstreamCaptchaError(errObj)) {
                invalidateCaptchaVerifyParam(
                  `upstream-stream-error:${
                    errObj?.verify_code || errObj?.captcha_error_type || errObj?.error_code || errObj?.code || "unknown"
                  }`,
                );
              }

              // 分析错误类型，特别是多模态相关错误
              const errorDetail = (errObj?.detail || "").toLowerCase();
              if (
                errorDetail.includes("something went wrong") ||
                errorDetail.includes("try again later")
              ) {
                debugLog("🚨 Z.ai 服务器错误分析:");
                debugLog("   📋 错误详情: %s", errObj?.detail);
                debugLog("   🖼️  可能原因: 图片处理失败");
                debugLog("   💡 建议解决方案:");
                debugLog("      1. 使用更小的图片 (< 500KB)");
                debugLog("      2. 尝试不同的图片格式 (JPEG 而不是 PNG)");
                debugLog("      3. 稍后重试 (可能是服务器负载问题)");
                debugLog("      4. 检查图片是否损坏");
              }

              const upstreamMessage = errObj?.detail || "Upstream stream error";
              const errorChunk = {
                error: {
                  message: upstreamMessage,
                  type: "upstream_stream_error",
                  code: errObj?.error_code || errObj?.code || "UPSTREAM_STREAM_ERROR",
                  captcha_error_type: errObj?.captcha_error_type,
                  verify_code: errObj?.verify_code,
                },
              };
              await writer.write(
                encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)
              );
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              return;
            }

            debugLog(
              "解析成功 - 类型: %s, 阶段: %s, 内容长度: %d, 完成: %v",
              upstreamData.type,
              upstreamData.data.phase,
              upstreamData.data.delta_content
                ? upstreamData.data.delta_content.length
                : 0,
              upstreamData.data.done
            );

            // 处理内容
            if (
              upstreamData.data.delta_content &&
              upstreamData.data.delta_content !== ""
            ) {
              let out = upstreamData.data.delta_content;
              if (upstreamData.data.phase === "thinking") {
                out = transformThinking(out);
              }

              if (out !== "") {
                debugLog("发送内容(%s): %s", upstreamData.data.phase, out);

                const chunk: OpenAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: out },
                    },
                  ],
                };

                await writer.write(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
            }

            // 检查是否结束
            if (upstreamData.data.done || upstreamData.data.phase === "done") {
              debugLog("检测到流结束信号");

              // 发送结束chunk
              const endChunk: OpenAIResponse = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };

              await writer.write(
                encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`)
              );
              await writer.write(encoder.encode("data: [DONE]\n\n"));
              return;
            }
          } catch (error) {
            debugLog("SSE数据解析失败: %v", error);
          }
        }
      }
    }
  } finally {
    writer.close();
  }
}

function getUpstreamErrorFromChunk(upstreamData: UpstreamData): UpstreamError | null {
  return (
    upstreamData.error ||
    upstreamData.data.data?.error ||
    upstreamData.data.error ||
    (upstreamData.data.inner && upstreamData.data.inner.error) ||
    null
  );
}

// 收集完整响应（用于非流式响应）
async function collectFullResponse(
  body: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.substring(6);
          if (dataStr === "") continue;

          try {
            const upstreamData = JSON.parse(dataStr) as UpstreamData;
            const errObj = getUpstreamErrorFromChunk(upstreamData);
            if (errObj) {
              throw new Error(`UPSTREAM_SSE_ERROR:${JSON.stringify(errObj)}`);
            }

            if (upstreamData.data.delta_content !== "") {
              let out = upstreamData.data.delta_content;
              if (upstreamData.data.phase === "thinking") {
                out = transformThinking(out);
              }

              if (out !== "") {
                fullContent += out;
              }
            }

            // 检查是否结束
            if (upstreamData.data.done || upstreamData.data.phase === "done") {
              debugLog("检测到完成信号，停止收集");
              return fullContent;
            }
          } catch (error) {
            // 忽略解析错误
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent;
}

function collectFullResponseFromText(rawText: string): string {
  let fullContent = "";
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const dataStr = line.substring(6).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    const upstreamData = JSON.parse(dataStr) as UpstreamData;
    const errObj = getUpstreamErrorFromChunk(upstreamData);
    if (errObj) {
      throw new Error(`UPSTREAM_SSE_ERROR:${JSON.stringify(errObj)}`);
    }
    const delta = upstreamData.data.delta_content;
    if (delta) {
      fullContent += upstreamData.data.phase === "thinking"
        ? transformThinking(delta)
        : delta;
    }
    if (upstreamData.data.done || upstreamData.data.phase === "done") {
      return fullContent;
    }
  }
  return fullContent;
}

/**
 * HTTP服务器和路由处理
 */

function getIndexHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZtoApi - Next-Gen AI Gateway</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #13131a;
            --bg-card: rgba(19, 19, 26, 0.8);
            --bg-card-hover: rgba(19, 19, 26, 0.95);
            --accent-cyan: #00fff5;
            --accent-purple: #b94fff;
            --accent-pink: #ff00aa;
            --accent-green: #00ff88;
            --text-primary: #ffffff;
            --text-secondary: #a0a0c0;
            --text-muted: #6b7280;
            --border-glow: rgba(0, 255, 245, 0.3);
            --border-subtle: rgba(255, 255, 255, 0.1);
            --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
        }

        [data-theme="light"] {
            --bg-primary: #f8f9fc;
            --bg-secondary: #ffffff;
            --bg-card: rgba(255, 255, 255, 0.9);
            --bg-card-hover: rgba(255, 255, 255, 0.98);
            --text-primary: #1a1a2e;
            --text-secondary: #4b5563;
            --text-muted: #9ca3af;
            --border-glow: rgba(0, 255, 245, 0.15);
            --border-subtle: rgba(0, 0, 0, 0.06);
            --shadow-glow: 0 10px 30px rgba(185, 79, 255, 0.1);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow-x: hidden;
            min-height: 100vh;
            transition: background 0.5s ease, color 0.5s ease;
        }

        /* Animated Particle Background */
        .particles {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
            opacity: 0.3;
            transition: opacity 0.5s ease;
        }

        [data-theme="light"] .particles {
            opacity: 0.15;
        }

        .particle {
            position: absolute;
            width: 2px;
            height: 2px;
            background: var(--accent-cyan);
            border-radius: 50%;
            animation: float 15s infinite;
            box-shadow: 0 0 10px var(--accent-cyan);
        }

        [data-theme="light"] .particle {
            box-shadow: 0 0 8px var(--accent-cyan);
        }

        @keyframes float {
            0%, 100% {
                transform: translateY(100vh) scale(0);
                opacity: 0;
            }
            10% {
                opacity: 1;
            }
            90% {
                transform: translateY(-10vh) scale(1);
            }
        }

        .container {
            position: relative;
            z-index: 1;
            max-width: 1400px;
            margin: 0 auto;
            padding: 60px 40px;
        }

        /* Top Bar with Controls */
        .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 50px;
            animation: fadeInUp 0.8s ease-out;
        }

        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }

        .control-btn {
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: 50px;
            padding: 10px 18px;
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .control-btn:hover {
            background: var(--bg-card);
            border-color: var(--border-glow);
            color: var(--text-primary);
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
        }

        .control-btn.active {
            background: var(--accent-cyan);
            color: var(--bg-primary);
            border-color: var(--accent-cyan);
        }

        [data-theme="light"] .control-btn.active {
            background: var(--accent-purple);
            color: #ffffff;
        }

        .control-icon {
            font-size: 1.1rem;
        }

        /* Header Section */
        .hero {
            text-align: center;
            margin-bottom: 80px;
            animation: fadeInUp 1s ease-out;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .brand {
            display: inline-block;
            font-family: 'JetBrains Mono', monospace;
            font-size: 1rem;
            font-weight: 700;
            letter-spacing: 4px;
            margin-bottom: 20px;
            padding: 12px 24px;
            background: linear-gradient(135deg, var(--accent-purple), var(--accent-pink));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: glow 3s ease-in-out infinite alternate;
        }

        @keyframes glow {
            from {
                filter: drop-shadow(0 0 8px var(--accent-purple));
            }
            to {
                filter: drop-shadow(0 0 16px var(--accent-cyan));
            }
        }

        [data-theme="light"] .brand {
            background: linear-gradient(135deg, #8b5cf6, #06b6d4);
        }

        h1 {
            font-size: clamp(3rem, 8vw, 6rem);
            font-weight: 700;
            line-height: 1.1;
            margin-bottom: 20px;
            background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -2px;
        }

        [data-theme="light"] h1 {
            background: linear-gradient(135deg, #1a1a2e 0%, #0066ff 50%, #8b5cf6 100%);
        }

        .subtitle {
            font-size: 1.25rem;
            color: var(--text-secondary);
            font-weight: 300;
            margin-bottom: 30px;
            letter-spacing: 1px;
        }

        .model-counter {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 10px 20px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-glow);
            border-radius: 50px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9rem;
        }

        [data-theme="light"] .model-counter {
            border-color: var(--border-subtle);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .counter {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--accent-cyan);
        }

        [data-theme="light"] .counter {
            color: #0066ff;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--accent-green);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: 0.5;
                transform: scale(1.2);
            }
        }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 30px;
            margin-bottom: 60px;
            animation: fadeInUp 1s ease-out 0.2s both;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 30px;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        [data-theme="light"] .stat-card {
            border-color: var(--border-subtle);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, var(--accent-cyan) 0%, transparent 70%);
            opacity: 0;
            transition: opacity 0.4s;
            pointer-events: none;
        }

        [data-theme="light"] .stat-card::before {
            background: radial-gradient(circle, #0066ff 0%, transparent 70%);
        }

        .stat-card:hover::before {
            opacity: 0.1;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        [data-theme="light"] .stat-card:hover {
            box-shadow: 0 15px 30px rgba(0, 102, 255, 0.15);
        }

        .stat-number {
            font-size: 3rem;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        [data-theme="light"] .stat-number {
            background: linear-gradient(135deg, #0066ff, #8b5cf6);
        }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        /* Links Section */
        .links-section {
            margin-bottom: 60px;
        }

        .section-title {
            font-size: 0.85rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 3px;
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .section-title::after {
            content: '';
            flex: 1;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--border-glow), transparent);
        }

        .links-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 25px;
        }

        .link-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 35px;
            position: relative;
            overflow: hidden;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            text-decoration: none;
            color: var(--text-primary);
            display: block;
        }

        [data-theme="light"] .link-card {
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .link-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(0, 255, 245, 0.1), transparent);
            transition: left 0.5s;
        }

        [data-theme="light"] .link-card::before {
            background: linear-gradient(90deg, transparent, rgba(0, 102, 255, 0.15), transparent);
        }

        .link-card:hover::before {
            left: 100%;
        }

        .link-card:hover {
            transform: translateY(-5px);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        [data-theme="light"] .link-card:hover {
            box-shadow: 0 15px 30px rgba(0, 102, 255, 0.2);
        }

        .link-icon {
            font-size: 2.5rem;
            margin-bottom: 15px;
            display: block;
        }

        .link-title {
            font-size: 1.3rem;
            font-weight: 700;
            margin-bottom: 10px;
            letter-spacing: -0.5px;
        }

        .link-desc {
            font-size: 0.95rem;
            color: var(--text-secondary);
            line-height: 1.6;
            margin-bottom: 20px;
        }

        .link-arrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--accent-cyan);
            transition: gap 0.3s;
        }

        [data-theme="light"] .link-arrow {
            color: #0066ff;
        }

        .link-card:hover .link-arrow {
            gap: 12px;
        }

        /* Highlight Card (Quick Test) */
        .link-card.highlight {
            background: linear-gradient(135deg, rgba(185, 79, 255, 0.15), rgba(185, 79, 255, 0.05));
            border-color: rgba(255, 0, 170, 0.3);
        }

        [data-theme="light"] .link-card.highlight {
            background: linear-gradient(135deg, rgba(255, 0, 170, 0.2), rgba(255, 0, 170, 0.08));
            border-color: rgba(255, 0, 170, 0.4);
        }

        /* Features Section */
        .features-section {
            position: relative;
        }

        .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }

        .feature-item {
            padding: 25px;
            border-radius: 12px;
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            transition: all 0.3s ease;
        }

        [data-theme="light"] .feature-item {
            background: rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
        }

        .feature-item:hover {
            background: var(--bg-card-hover);
            border-color: var(--border-glow);
        }

        [data-theme="light"] .feature-item:hover {
            box-shadow: 0 8px 16px rgba(0, 102, 255, 0.12);
        }

        .feature-icon {
            font-size: 1.8rem;
            margin-bottom: 12px;
            display: block;
        }

        .feature-title {
            font-size: 1.1rem;
            font-weight: 500;
            margin-bottom: 8px;
        }

        .feature-desc {
            font-size: 0.9rem;
            color: var(--text-secondary);
            line-height: 1.5;
        }

        /* Footer */
        footer {
            text-align: center;
            padding: 40px 0;
            border-top: 1px solid var(--border-subtle);
            margin-top: 80px;
        }

        .footer-text {
            color: var(--text-secondary);
            font-size: 0.9rem;
            letter-spacing: 1px;
        }

        .footer-link {
            color: var(--accent-purple);
            text-decoration: none;
            font-weight: 500;
            transition: color 0.3s;
        }

        [data-theme="light"] .footer-link {
            color: #8b5cf6;
        }

        .footer-link:hover {
            color: var(--accent-cyan);
        }

        [data-theme="light"] .footer-link:hover {
            color: #0066ff;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container {
                padding: 40px 20px;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            h1 {
                font-size: 2.5rem;
            }

            .controls {
                gap: 8px;
            }

            .control-btn {
                padding: 8px 14px;
                font-size: 0.8rem;
            }

            .control-btn span {
                display: none;
            }
        }
    </style>
</head>
<body>
    <!-- Animated Particles Background -->
    <div class="particles" id="particles"></div>

    <div class="container">
        <!-- Hero Section -->
        <div class="hero">
            <div class="brand">ZtoApi</div>
            <h1>AI GATEWAY</h1>
            <div class="subtitle">
                OpenAI 兼容的下一代 GLM 模型代理服务
            </div>
            <div class="model-counter">
                <span class="status-dot"></span>
                <span class="counter">8</span>
                <span>个 AI 模型在线</span>
            </div>
        </div>

        <!-- Stats Section -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number">v2.1</div>
                <div class="stat-label">API 版本</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">100%</div>
                <div class="stat-label">OpenAI 兼容</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">&lt;50ms</div>
                <div class="stat-label">平均延迟</div>
            </div>
        </div>

        <!-- Quick Links -->
        <div class="links-section">
            <div class="section-title">快速访问</div>
            <div class="links-grid">
                <a href="/v1/models" class="link-card">
                    <span class="link-icon">🤖</span>
                    <div class="link-title">模型列表</div>
                    <div class="link-desc">探索全部8个GLM系列AI模型及其能力</div>
                    <span class="link-arrow">查看模型 →</span>
                </a>

                <a href="/docs" class="link-card">
                    <span class="link-icon">📚</span>
                    <div class="link-title">API 文档</div>
                    <div class="link-desc">完整的集成指南、代码示例和最佳实践</div>
                    <span class="link-arrow">阅读文档 →</span>
                </a>

                <a href="/deno-deploy" class="link-card">
                    <span class="link-icon">Deno</span>
                    <div class="link-title">Deno Deploy 部署</div>
                    <div class="link-desc">部署步骤、环境变量与常见问题</div>
                    <span class="link-arrow">查看指南 →</span>
                </a>

                <a href="/dashboard" class="link-card">
                    <span class="link-icon">📊</span>
                    <div class="link-title">监控看板</div>
                    <div class="link-desc">实时API调用统计、性能指标和错误追踪</div>
                    <span class="link-arrow">打开看板 →</span>
                </a>

                <a href="/v1/chat/completions" class="link-card highlight">
                    <span class="link-icon">⚡</span>
                    <div class="link-title">快速测试</div>
                    <div class="link-desc">直接在浏览器中体验AI对话能力</div>
                    <span class="link-arrow" style="color: var(--accent-pink);">立即试用 →</span>
                </a>
            </div>
        </div>

        <!-- Features Section -->
        <div class="features-section">
            <div class="section-title">核心能力</div>
            <div class="features-grid">
                <div class="feature-item">
                    <span class="feature-icon">🔄</span>
                    <div class="feature-title">Token 池管理</div>
                    <div class="feature-desc">多Token轮换，自动故障切换，99.9%可用性</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🌊</span>
                    <div class="feature-title">SSE 流式传输</div>
                    <div class="feature-desc">实时逐token输出，毫秒级首字节响应</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🔐</span>
                    <div class="feature-title">双层HMAC签名</div>
                    <div class="feature-desc">企业级安全，时间窗口验证，密钥可配置</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🎯</span>
                    <div class="feature-title">全方位多模态</div>
                    <div class="feature-desc">图像、视频、文档、音频，GLM-4.5V/4.6V支持</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🧠</span>
                    <div class="feature-title">智能思考展示</div>
                    <div class="feature-desc">完整展现AI推理过程，支持GLM-4.6/4.7/5系列</div>
                </div>

                <div class="feature-item">
                    <span class="feature-icon">🔍</span>
                    <div class="feature-title">MCP 工具调用</div>
                    <div class="feature-desc">深度搜索、编程助手、PPT生成等高级功能</div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <footer>
            <div class="footer-text">
                Powered by <a href="https://deno.land" class="footer-link">Deno</a> &
                <a href="https://chat.z.ai" class="footer-link">Z.ai GLM</a> •
                v2.1 Enterprise Edition
            </div>
        </footer>
    </div>

    <script>
        // Initialize
        function init() {
            generateParticles();
            animateCounter();
            animateSubtitle();
            observeScrollReveal();
        }

        // Generate floating particles
        function generateParticles() {
            const particlesContainer = document.getElementById('particles');
            if (!particlesContainer) return;
            particlesContainer.innerHTML = '';
            const particleCount = 30;

            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 15 + 's';
                particle.style.animationDuration = (10 + Math.random() * 10) + 's';
                particlesContainer.appendChild(particle);
            }
        }

        // Typing effect for subtitle
        function animateSubtitle() {
            const subtitle = document.querySelector('.subtitle');
            if (!subtitle) return;
            const text = subtitle.textContent;
            subtitle.textContent = '';
            let i = 0;

            function typeWriter() {
                if (i < text.length) {
                    subtitle.textContent += text.charAt(i);
                    i++;
                    setTimeout(typeWriter, 50);
                }
            }

            setTimeout(typeWriter, 500);
        }

        // Counter animation
        function animateCounter() {
            const counter = document.querySelector('.counter');
            if (!counter) return;
            let count = 0;
            const target = 8;

            function animate() {
                if (count < target) {
                    count++;
                    counter.textContent = count;
                    setTimeout(animate, 100);
                }
            }

            setTimeout(animate, 1000);
        }

        // Scroll reveal animation
        function observeScrollReveal() {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.style.opacity = '1';
                        entry.target.style.transform = 'translateY(0)';
                    }
                });
            }, { threshold: 0.1 });

            document.querySelectorAll('.feature-item').forEach(item => {
                item.style.opacity = '0';
                item.style.transform = 'translateY(20px)';
                item.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
                observer.observe(item);
            });
        }

        // Start everything
        init();

    </script>
</body>
</html>`;
}

async function handleIndex(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getIndexHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

async function handleOptions(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  return new Response("Not Found", { status: 404, headers });
}

async function handleInternalSessionState(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  const authHeader = request.headers.get("Authorization");
  if (!validateApiKey(authHeader)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers,
    });
  }

  if (request.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      state: getCaptchaSessionSnapshot(),
    }), { status: 200, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }

  const body = await request.json().catch(() => ({}));
  const captchaVerifyParam = typeof body?.captcha_verify_param === "string"
    ? body.captcha_verify_param.trim()
    : null;
  const token = typeof body?.token === "string" ? body.token.trim() : null;
  const source = typeof body?.source === "string" ? body.source.trim() : "manual";

  if (captchaVerifyParam) {
    updateCaptchaSessionState({
      captchaVerifyParam,
      token,
      source,
    });
  } else if (token) {
    updateCaptchaSessionState({
      token,
      source,
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    state: getCaptchaSessionSnapshot(),
  }), { status: 200, headers });
}

async function handleInternalPureCodeWorker(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  const authHeader = request.headers.get("Authorization");
  if (!validateApiKey(authHeader)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers,
    });
  }

  try {
    if (request.method === "GET") {
      const status = await pureCodeWorkerBridge.status().catch(() => null);
      return new Response(JSON.stringify({
        ok: true,
        enabled: AUTO_CAPTCHA_PURE_CODE_ENABLED,
        bridge: pureCodeWorkerBridge.snapshot(),
        worker: status,
        session: getCaptchaSessionSnapshot(),
      }), { status: 200, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
        status: 405,
        headers,
      });
    }

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "status";

    if (action === "warm") {
      const result = await pureCodeWorkerBridge.warm();
      return new Response(JSON.stringify({ ok: true, action, result }), {
        status: 200,
        headers,
      });
    }

    if (action === "probe") {
      const result = await pureCodeWorkerBridge.probe(!!body?.include_raw);
      return new Response(JSON.stringify({ ok: true, action, result }), {
        status: 200,
        headers,
      });
    }

    if (action === "captcha") {
      const token = typeof body?.token === "string" ? body.token : "";
      const payload = await pureCodeWorkerBridge.fetchCaptchaPayload(token);
      if (typeof payload?.captcha_verify_param === "string") {
        updateCaptchaSessionState({
          captchaVerifyParam: payload.captcha_verify_param,
          token,
          source: "internal-pure-code-worker",
          workerLastPayloadSource: typeof payload?.source === "string" ? payload.source : null,
          workerLastError: null,
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        action,
        payload,
        session: getCaptchaSessionSnapshot(),
      }), { status: 200, headers });
    }

    const result = await pureCodeWorkerBridge.status();
    return new Response(JSON.stringify({ ok: true, action: "status", result }), {
      status: 200,
      headers,
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(error && (error as Error).stack || error),
      bridge: pureCodeWorkerBridge.snapshot(),
    }), { status: 500, headers });
  }
}

async function handleModels(request: Request): Promise<Response> {
  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 支持的模型
  const models = SUPPORTED_MODELS.map((model) => ({
    id: model.name,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "z.ai",
  }));

  const response: ModelsResponse = {
    object: "list",
    data: models,
  };

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(response), {
    status: 200,
    headers,
  });
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const path = url.pathname;
  const userAgent = request.headers.get("User-Agent") || "";

  debugLog("收到chat completions请求");
  debugLog("🌐 User-Agent: %s", userAgent);

  // Cherry Studio 检测
  const isCherryStudio =
    userAgent.toLowerCase().includes("cherry") ||
    userAgent.toLowerCase().includes("studio");
  if (isCherryStudio) {
    debugLog(
      "🍒 检测到 Cherry Studio 客户端版本: %s",
      userAgent.match(/CherryStudio\/([^\s]+)/)?.[1] || "unknown"
    );
  }

  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 验证API Key
  const authHeader = request.headers.get("Authorization");
  if (!validateApiKey(authHeader)) {
    debugLog("缺少或无效的Authorization头");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest(request.method, path, 401, duration, userAgent);
    return new Response("Missing or invalid Authorization header", {
      status: 401,
      headers,
    });
  }

  debugLog("API key验证通过");

  // 读取请求体
  let body: string;
  try {
    body = await request.text();
    debugLog("📥 收到请求体长度: %d 字符", body.length);

    // 为Cherry Studio调试：记录原始请求体（截取前1000字符避免日志过长）
    const bodyPreview =
      body.length > 1000 ? body.substring(0, 1000) + "..." : body;
    debugLog("📄 请求体预览: %s", bodyPreview);
  } catch (error) {
    debugLog("读取请求体失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Failed to read request body", {
      status: 400,
      headers,
    });
  }

  // 解析请求
  let req: OpenAIRequest;
  try {
    req = JSON.parse(body) as OpenAIRequest;
    debugLog("✅ JSON解析成功");
  } catch (error) {
    debugLog("JSON解析失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Invalid JSON", {
      status: 400,
      headers,
    });
  }

  // 如果客户端没有明确指定stream参数，使用默认值
  if (!body.includes('"stream"')) {
    req.stream = DEFAULT_STREAM;
    debugLog("客户端未指定stream参数，使用默认值: %v", DEFAULT_STREAM);
  }

  // 获取模型配置
  const modelConfig = getModelConfig(req.model);
  debugLog(
    "请求解析成功 - 模型: %s (%s), 流式: %v, 消息数: %d",
    req.model,
    modelConfig.name,
    req.stream,
    req.messages.length
  );

  // Cherry Studio 调试：详细检查每条消息
  debugLog("🔍 Cherry Studio 调试 - 检查原始消息:");
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    debugLog("  消息[%d] role: %s", i, msg.role);

    if (typeof msg.content === "string") {
      debugLog(
        "  消息[%d] content: 字符串类型, 长度: %d",
        i,
        msg.content.length
      );
      if (msg.content.length === 0) {
        debugLog("  ⚠️  消息[%d] 内容为空字符串!", i);
      } else {
        debugLog("  消息[%d] 内容预览: %s", i, msg.content.substring(0, 100));
      }
    } else if (Array.isArray(msg.content)) {
      debugLog("  消息[%d] content: 数组类型, 块数: %d", i, msg.content.length);
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        debugLog("    块[%d] type: %s", j, block.type);
        if (block.type === "text" && block.text) {
          debugLog("    块[%d] text: %s", j, block.text.substring(0, 50));
        } else if (block.type === "image_url" && block.image_url?.url) {
          debugLog(
            "    块[%d] image_url: %s格式, 长度: %d",
            j,
            block.image_url.url.startsWith("data:") ? "base64" : "url",
            block.image_url.url.length
          );
        }
      }
    } else {
      debugLog("  ⚠️  消息[%d] content 类型异常: %s", i, typeof msg.content);
    }
  }

  // 检测模型高级能力
  const capabilities = ModelCapabilityDetector.detectCapabilities(
    req.model,
    req.reasoning
  );
  debugLog("模型能力检测: 思考=%s, 搜索=%s, 高级搜索=%s, 视觉=%s, MCP=%s",
    capabilities.thinking, capabilities.search, capabilities.advancedSearch,
    capabilities.vision, capabilities.mcp);

  // 处理和验证消息（特别是多模态内容）
  const processedMessages = processMessages(req.messages, modelConfig);
  debugLog("消息处理完成，处理后消息数: %d", processedMessages.length);

  // 使用 Token 池获取 token
  let authToken: string;
  try {
    authToken = await tokenPool.getToken();
    debugLog("Token 获取成功: %s...", authToken.substring(0, 10));
  } catch (error) {
    debugLog("Token 获取失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 500);
    addLiveRequest(request.method, path, 500, duration, userAgent);
    return new Response("Failed to get authentication token", {
      status: 500,
      headers,
    });
  }

  // 检查是否包含多模态内容并使用新的图像处理器
  const hasMultimodal = ImageProcessor.hasImageContent(req.messages);
  let finalMessages = processedMessages;
  let uploadedFiles: UploadedFile[] = [];

  if (hasMultimodal) {
    debugLog("🎯 检测到图像内容，开始处理，模型: %s", modelConfig.name);

    // 检查匿名 Token 限制
    if (tokenPool.isAnonymousToken(authToken)) {
      debugLog("❌ 匿名 Token 不支持图像处理功能");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 400);
      addLiveRequest(request.method, path, 400, duration, userAgent);
      return new Response("匿名Token不支持图像处理功能，请配置ZAI_TOKEN环境变量", {
        status: 400,
        headers,
      });
    }

    if (!capabilities.vision) {
      debugLog("❌ 严重错误: 模型不支持多模态，但收到了图像内容！");
      debugLog(
        "💡 Cherry Studio用户请检查: 确认选择了 'glm-4.5v' 而不是 'GLM-4.5'"
      );
      debugLog(
        "🔧 模型映射状态: %s → %s (vision: %s)",
        req.model,
        modelConfig.upstreamId,
        capabilities.vision
      );
    } else {
      debugLog("✅ 使用高级图像处理器处理图像内容");

      try {
        // 使用新的图像处理器
        const imageProcessResult = await ImageProcessor.processImages(
          req.messages,
          authToken,
          capabilities.vision
        );

        finalMessages = imageProcessResult.processedMessages;
        uploadedFiles = imageProcessResult.uploadedFiles;

        debugLog("图像处理完成: 处理后消息数=%d, 上传文件数=%d",
          finalMessages.length, uploadedFiles.length);

      } catch (error) {
        debugLog("图像处理失败: %v", error);
        const duration = Date.now() - startTime;
        recordRequestStats(startTime, path, 500);
        addLiveRequest(request.method, path, 500, duration, userAgent);
        return new Response("图像处理失败", {
          status: 500,
          headers,
        });
      }
    }
  } else if (capabilities.vision && modelConfig.id === "glm-4.5v") {
    debugLog("ℹ️ 使用GLM-4.5V模型但未检测到图像数据，仅处理文本内容");
  }

  // 提取用户最后消息内容（用于签名和补齐消息树）
  const lastUserContent = ImageProcessor.extractLastUserContent(req.messages);

  // 按前端消息树关系构造 chat context：
  // 1. 先把已有消息串成 history；
  // 2. 再为当前回复创建 assistant placeholder；
  // 3. /chat/completions 的 id 指向 assistant placeholder，
  //    current_user_message_* 指向它的父 user 节点及 user 的父节点。
  const existingChatSession = getUpstreamChatSession(authToken);
  const historyNodes: Record<string, UpstreamChatHistoryNode> = {};
  let previousHistoryNodeId: string | null = existingChatSession?.lastAssistantMessageId || null;
  let currentUserMessageID: string | null = null;
  let currentUserMessageParentID: string | null = null;
  for (const message of finalMessages) {
    const nodeId = crypto.randomUUID();
    historyNodes[nodeId] = {
      id: nodeId,
      parentId: previousHistoryNodeId,
      childrenIds: [],
      role: message.role,
      content: message.content,
      timestamp: Math.floor(Date.now() / 1000),
      ...(message.role === "user" ? { models: [modelConfig.upstreamId] } : {}),
    };
    if (previousHistoryNodeId && historyNodes[previousHistoryNodeId]) {
      historyNodes[previousHistoryNodeId].childrenIds.push(nodeId);
    }
    if (message.role === "user") {
      currentUserMessageID = nodeId;
      currentUserMessageParentID = previousHistoryNodeId;
    }
    previousHistoryNodeId = nodeId;
  }
  if (!currentUserMessageID) {
    currentUserMessageID = crypto.randomUUID();
    historyNodes[currentUserMessageID] = {
      id: currentUserMessageID,
      parentId: previousHistoryNodeId,
      childrenIds: [],
      role: "user",
      content: lastUserContent,
      timestamp: Math.floor(Date.now() / 1000),
      models: [modelConfig.upstreamId],
    };
    if (previousHistoryNodeId && historyNodes[previousHistoryNodeId]) {
      historyNodes[previousHistoryNodeId].childrenIds.push(currentUserMessageID);
    }
    currentUserMessageParentID = previousHistoryNodeId;
    previousHistoryNodeId = currentUserMessageID;
  }

  const assistantPlaceholderID = crypto.randomUUID();
  if (currentUserMessageID && historyNodes[currentUserMessageID]) {
    currentUserMessageParentID = historyNodes[currentUserMessageID].parentId;
  }

  const bootstrapHistoryMessages: Record<string, UpstreamChatHistoryNode> = {};
  if (currentUserMessageID && historyNodes[currentUserMessageID]) {
    bootstrapHistoryMessages[currentUserMessageID] = {
      ...historyNodes[currentUserMessageID],
      childrenIds: [],
    };
  }

  const bootstrapPayload: UpstreamChatBootstrapPayload = {
    id: "",
    title: "New Chat",
    models: [modelConfig.upstreamId],
    params: {},
    history: {
      messages: bootstrapHistoryMessages,
      currentId: currentUserMessageID,
    },
    tags: [],
    flags: [],
    features: MCP_FEATURES,
    enable_thinking: true,
    auto_web_search: false,
    message_version: 1,
    extra: {},
    timestamp: Date.now(),
    type: "default",
  };
  const upstreamSession = await upstreamSessionBootstrap.ensureSession(authToken, "");
  const upstreamAuthToken = upstreamSession.authToken || authToken;
  const browserUserName = getBrowserUserName(upstreamAuthToken, {
    name: upstreamSession.profileName,
    email: upstreamSession.profileEmail,
  });
  let chatID: string = existingChatSession?.chatId || crypto.randomUUID();
  if (!existingChatSession) {
    try {
      const bootstrapChat = await upstreamSessionBootstrap.createChat(
        authToken,
        bootstrapPayload,
        "",
      );
      chatID = bootstrapChat.id || bootstrapChat.chat?.id || chatID;
      updateUpstreamChatSession(authToken, {
        chatId: chatID,
        lastUserMessageId: currentUserMessageID,
        lastAssistantMessageId: assistantPlaceholderID,
      });
    } catch (bootstrapError) {
      debugLog("上游 chats/new bootstrap 失败，回退本地 chat_id: %v", bootstrapError);
      updateUpstreamChatSession(authToken, {
        chatId: chatID,
        lastUserMessageId: currentUserMessageID,
        lastAssistantMessageId: assistantPlaceholderID,
      });
    }
  } else {
    updateUpstreamChatSession(authToken, {
      chatId: chatID,
      lastUserMessageId: currentUserMessageID,
      lastAssistantMessageId: assistantPlaceholderID,
    });
  }
  const now = new Date();
  const currentDateTime = formatBrowserDateTime(now);

  // 记录工具信息
  if (req.tools && req.tools.length > 0) {
    debugLog("🔧 检测到工具定义: 数量=%d, 工具名=[%s]",
      req.tools.length,
      req.tools.map(t => t.function.name).join(", ")
    );
  } else {
    debugLog("🔧 未检测到工具定义");
  }

  const requestFeatures: Record<string, unknown> = {
    image_generation: false,
    web_search: false,
    auto_web_search: false,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: false,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: true,
  };

  // 构造上游请求，尽量贴近浏览器成功样本
  const upstreamReq: UpstreamRequest = {
    // 与客户端请求保持一致，避免把非流式请求误发成流式。
    stream: req.stream === true,
    chat_id: chatID,
    id: assistantPlaceholderID,
    current_user_message_id: currentUserMessageID,
    current_user_message_parent_id: currentUserMessageParentID,
    model: modelConfig.upstreamId,
    messages: finalMessages,
    params: {},
    extra: {},
    features: requestFeatures,
    background_tasks: {
      title_generation: true,
      tags_generation: true,
    },
    variables: {
      "{{USER_NAME}}": browserUserName,
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": currentDateTime,
      "{{CURRENT_DATE}}": currentDateTime.slice(0, 10),
      "{{CURRENT_TIME}}": currentDateTime.slice(11),
      "{{CURRENT_WEEKDAY}}": formatBrowserWeekday(now),
      "{{CURRENT_TIMEZONE}}": getPreferredBrowserTimezone(),
      "{{USER_LANGUAGE}}": getPreferredBrowserLanguage(),
    },
    // 添加文件列表（如果有上传的图像）
    ...(uploadedFiles.length > 0 && !capabilities.vision ? { files: uploadedFiles } : {}),
    // 添加签名提示
    signature_prompt: lastUserContent,
  };

  if (req.tools && req.tools.length > 0) {
    upstreamReq.tool_servers = req.tools.map((tool) => tool.function.name);
  }

  await tryAttachCaptchaVerifyParam(
    upstreamReq,
    upstreamAuthToken,
    modelConfig.id,
  );

  // 调用上游API
  try {
    if (req.stream) {
      return await handleStreamResponse(
        upstreamReq,
        chatID,
        upstreamAuthToken,
        startTime,
        path,
        userAgent,
        req,
        modelConfig
      );
    } else {
      return await handleNonStreamResponse(
        upstreamReq,
        chatID,
        upstreamAuthToken,
        startTime,
        path,
        userAgent,
        req,
        modelConfig
      );
    }
  } catch (error) {
    debugLog("调用上游失败: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest(request.method, path, 502, duration, userAgent);
    return new Response("Failed to call upstream", {
      status: 502,
      headers,
    });
  }
}

async function handleStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  userAgent: string,
  req: OpenAIRequest,
  modelConfig: ModelConfig
): Promise<Response> {
  debugLog("开始处理流式响应 (chat_id=%s)", chatID);

  try {
    const response = await callUpstreamWithHeaders(
      upstreamReq,
      chatID,
      authToken
    );

    if (!response.ok) {
      debugLog("上游返回错误状态: %d", response.status);
      const upstreamErrorText = await response.text();
      const upstreamContentType = response.headers.get("content-type") || "text/plain; charset=utf-8";
      debugLog("上游流式错误响应体预览: %s", upstreamErrorText.slice(0, 2000));
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response(upstreamErrorText || "Upstream error", {
        status: 502,
        headers: {
          "Content-Type": upstreamContentType,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }

    if (!response.body) {
      debugLog("上游响应体为空");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream response body is empty", { status: 502 });
    }

    // 创建可读流
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 发送第一个chunk（role）
    const firstChunk: OpenAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
        },
      ],
    };

    // 写入第一个chunk
    writer.write(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));

    // 处理上游SSE流
    processUpstreamStream(response.body, writer, encoder, req.model).catch(
      (error) => {
        debugLog("处理上游流时出错: %v", error);
      }
    );

    // 记录成功请求统计
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 200);
    addLiveRequest("POST", path, 200, duration, userAgent, modelConfig.name);

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    debugLog("处理流式响应时出错: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest("POST", path, 502, duration, userAgent);
    return new Response("Failed to process stream response", { status: 502 });
  }
}

async function handleNonStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  userAgent: string,
  req: OpenAIRequest,
  modelConfig: ModelConfig
): Promise<Response> {
  debugLog("开始处理非流式响应 (chat_id=%s)", chatID);

  try {
    const response = await callUpstreamWithHeaders(
      upstreamReq,
      chatID,
      authToken
    );

    if (!response.ok) {
      debugLog("上游返回错误状态: %d", response.status);
      const upstreamErrorText = await response.text();
      debugLog("上游错误响应体预览: %s", upstreamErrorText.slice(0, 2000));
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response(upstreamErrorText || "Upstream error", {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }

    if (!response.body) {
      debugLog("上游响应体为空");
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 502);
      addLiveRequest("POST", path, 502, duration, userAgent);
      return new Response("Upstream response body is empty", { status: 502 });
    }

    // 收集完整响应
    const rawUpstreamText = await response.text();
    const finalContent = collectFullResponseFromText(rawUpstreamText);
    debugLog("上游非流式原始响应预览: %s", rawUpstreamText.slice(0, 2000));
    debugLog("内容收集完成，最终长度: %d", finalContent.length);

    // 构造完整响应
    const openAIResponse: OpenAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalContent,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    // 记录成功请求统计
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 200);
    addLiveRequest("POST", path, 200, duration, userAgent, modelConfig.name);

    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    const message = String(error && (error as Error).message || error);
    if (message.startsWith("UPSTREAM_SSE_ERROR:")) {
      const detail = message.slice("UPSTREAM_SSE_ERROR:".length);
      try {
        const errObj = JSON.parse(detail) as UpstreamError;
        if (isUpstreamCaptchaError(errObj)) {
          const retryAttempted = upstreamReq.extra?.__captcha_retry_attempted === true;
          if (!retryAttempted) {
            debugLog(
              "非流式响应命中 CAPTCHA 错误，尝试获取 captcha_verify_param 后重试一次: code=%s verify_code=%s captcha_error_type=%s",
              String(errObj.error_code || errObj.code || ""),
              String(errObj.verify_code || ""),
              String(errObj.captcha_error_type || ""),
            );
            if (!upstreamReq.extra) {
              upstreamReq.extra = {};
            }
            upstreamReq.extra.__captcha_retry_attempted = true;
            await tryAttachCaptchaVerifyParam(
              upstreamReq,
              authToken,
              modelConfig.id,
            );
            if (upstreamReq.captcha_verify_param) {
              debugLog("已在 CAPTCHA 错误后补注入 captcha_verify_param，开始重试非流式请求");
              return await handleNonStreamResponse(
                upstreamReq,
                chatID,
                authToken,
                startTime,
                path,
                userAgent,
                req,
                modelConfig,
              );
            }
            debugLog("CAPTCHA 错误后重试前仍未拿到 captcha_verify_param");
          }
          invalidateCaptchaVerifyParam(
            `upstream-nonstream-error:${
              errObj.verify_code || errObj.captcha_error_type || errObj.error_code || errObj.code || "unknown"
            }`,
          );
        }
      } catch {
        // ignore parse failure
      }
      return new Response(detail, {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }
    debugLog("处理非流式响应时出错: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502);
    addLiveRequest("POST", path, 502, duration, userAgent);
    return new Response("Failed to process non-stream response", {
      status: 502,
    });
  }
}

/**
 * 生成 Dashboard 监控页面HTML模板
 * 提供实时API调用监控和统计信息展示
 * @returns string 完整的HTML页面内容
 */
function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API调用看板</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #13131a;
            --bg-card: rgba(19, 19, 26, 0.8);
            --bg-card-hover: rgba(19, 19, 26, 0.95);
            --accent-cyan: #00fff5;
            --accent-purple: #b94fff;
            --accent-pink: #ff00aa;
            --accent-green: #00ff88;
            --text-primary: #ffffff;
            --text-secondary: #a0a0c0;
            --text-muted: #6b7280;
            --border-glow: rgba(0, 255, 245, 0.3);
            --border-subtle: rgba(255, 255, 255, 0.1);
            --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow-x: hidden;
            min-height: 100vh;
            transition: background 0.5s ease, color 0.5s ease;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 60px 40px;
        }

        h1 {
            font-size: clamp(2.5rem, 5vw, 4rem);
            font-weight: 700;
            line-height: 1.1;
            margin-bottom: 40px;
            text-align: center;
            background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -2px;
        }
        .stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 30px;
            margin-bottom: 60px;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, var(--accent-cyan) 0%, transparent 70%);
            opacity: 0;
            transition: opacity 0.4s;
            pointer-events: none;
        }

        .stat-card:hover::before {
            opacity: 0.1;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            border-color: var(--border-glow);
            box-shadow: var(--shadow-glow);
        }

        .stat-value {
            font-size: 3rem;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .chart-container {
            margin-top: 30px;
            height: 350px;
            background: var(--bg-card);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            padding: 25px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }

        .chart-container h2 {
            color: var(--accent-cyan);
            font-size: 1.2rem;
            margin-bottom: 20px;
        }

        .requests-container {
            margin-top: 60px;
        }

        .requests-container h2 {
            color: var(--text-primary);
            font-size: 1.8rem;
            margin-bottom: 25px;
        }

        .requests-table {
            width: 100%;
            border-collapse: collapse;
            background: var(--bg-card);
            border-radius: 12px;
            overflow: hidden;
        }

        .requests-table th {
            background: var(--bg-secondary);
            color: var(--accent-cyan);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-size: 0.85rem;
        }

        .requests-table th, .requests-table td {
            padding: 16px 12px;
            text-align: left;
            border-bottom: 1px solid var(--border-subtle);
        }

        .requests-table tr:hover {
            background: var(--bg-card-hover);
        }

        .status-success {
            color: var(--accent-green);
            font-weight: 600;
        }

        .status-error {
            color: var(--accent-pink);
            font-weight: 600;
        }

        .pagination-container {
            display: flex;
            justify-content: center;
            align-items: center;
            margin-top: 30px;
            gap: 15px;
        }

        .pagination-container button {
            padding: 10px 20px;
            background: var(--accent-cyan);
            color: var(--bg-primary);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .pagination-container button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(0, 255, 245, 0.3);
        }

        .pagination-container button:disabled {
            background: var(--bg-secondary);
            color: var(--text-muted);
            cursor: not-allowed;
            opacity: 0.5;
        }

        #page-info {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .refresh-info {
            text-align: center;
            margin-top: 40px;
            padding: 20px;
            color: var(--text-muted);
            font-size: 0.9rem;
            border-top: 1px solid var(--border-subtle);
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container {
                padding: 40px 20px;
            }

            .stats-container {
                grid-template-columns: 1fr;
            }

            h1 {
                font-size: 2.5rem;
            }

            .requests-table {
                font-size: 0.85rem;
            }

            .pagination-container {
                gap: 8px;
            }

            .pagination-container button {
                padding: 8px 14px;
                font-size: 0.85rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>API 调用看板</h1>
        
        <div class="stats-container">
            <div class="stat-card">
                <div class="stat-value" id="total-requests">0</div>
                <div class="stat-label">总请求数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="successful-requests">0</div>
                <div class="stat-label">成功请求</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="failed-requests">0</div>
                <div class="stat-label">失败请求</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="avg-response-time">0s</div>
                <div class="stat-label">平均响应时间</div>
            </div>
        </div>
        
        <div class="chart-container">
            <h2>请求统计图表</h2>
            <canvas id="requestsChart"></canvas>
        </div>
        
        <div class="requests-container">
            <h2>实时请求</h2>
            <table class="requests-table">
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>模型</th>
                        <th>方法</th>
                        <th>状态</th>
                        <th>耗时</th>
                        <th>User Agent</th>
                    </tr>
                </thead>
                <tbody id="requests-tbody">
                    <!-- 请求记录将通过JavaScript动态添加 -->
                </tbody>
            </table>
            <div class="pagination-container">
                <button id="prev-page" disabled>上一页</button>
                <span id="page-info">第 1 页，共 1 页</span>
                <button id="next-page" disabled>下一页</button>
            </div>
        </div>
        
        <div class="refresh-info">
            数据每5秒自动刷新一次
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
        // 全局变量
        let allRequests = [];
        let currentPage = 1;
        const itemsPerPage = 10;
        let requestsChart = null;
        
        // 更新统计数据
        function updateStats() {
            fetch('/dashboard/stats')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('total-requests').textContent = data.totalRequests || 0;
                    document.getElementById('successful-requests').textContent = data.successfulRequests || 0;
                    document.getElementById('failed-requests').textContent = data.failedRequests || 0;
                    document.getElementById('avg-response-time').textContent = ((data.averageResponseTime || 0) / 1000).toFixed(2) + 's';
                })
                .catch(error => console.error('Error fetching stats:', error));
        }
        
        // 更新请求列表
        function updateRequests() {
            fetch('/dashboard/requests')
                .then(response => response.json())
                .then(data => {
                    // 检查数据是否为数组
                    if (!Array.isArray(data)) {
                        console.error('返回的数据不是数组:', data);
                        return;
                    }
                    
                    // 保存所有请求数据
                    allRequests = data;
                    
                    // 按时间倒序排列
                    allRequests.sort((a, b) => {
                        const timeA = new Date(a.timestamp);
                        const timeB = new Date(b.timestamp);
                        return timeB - timeA;
                    });
                    
                    // 更新表格
                    updateTable();
                    
                    // 更新图表
                    updateChart();
                    
                    // 更新分页信息
                    updatePagination();
                })
                .catch(error => console.error('Error fetching requests:', error));
        }
        
        // 更新表格显示
        function updateTable() {
            const tbody = document.getElementById('requests-tbody');
            tbody.innerHTML = '';
            
            // 计算当前页的数据范围
            const startIndex = (currentPage - 1) * itemsPerPage;
            const endIndex = startIndex + itemsPerPage;
            const currentRequests = allRequests.slice(startIndex, endIndex);
            
            currentRequests.forEach(request => {
                const row = document.createElement('tr');
                
                // 格式化时间 - 检查时间戳是否有效
                let timeStr = "Invalid Date";
                if (request.timestamp) {
                    try {
                        const time = new Date(request.timestamp);
                        if (!isNaN(time.getTime())) {
                            timeStr = time.toLocaleTimeString();
                        }
                    } catch (e) {
                        console.error("时间格式化错误:", e);
                    }
                }
                
                // 判断模型名称
                let modelName = "GLM-4.5";
                if (request.path && request.path.includes('glm-4.5v')) {
                    modelName = "GLM-4.5V";
                } else if (request.model) {
                    modelName = request.model;
                }
                
                // 状态样式
                const statusClass = request.status >= 200 && request.status < 300 ? 'status-success' : 'status-error';
                const status = request.status || "undefined";
                
                // 截断 User Agent，避免过长
                let userAgent = request.user_agent || "undefined";
                if (userAgent.length > 30) {
                    userAgent = userAgent.substring(0, 30) + "...";
                }
                
                row.innerHTML = "<td>" + timeStr + "</td>" + "<td>" + modelName + "</td>" + "<td>" + (request.method || "undefined") + "</td>" + "<td class='" + statusClass + "'>" + status + "</td>" + "<td>" + ((request.duration / 1000).toFixed(2) || "undefined") + "s</td>" + "<td title='" + (request.user_agent || "") + "'>" + userAgent + "</td>";
                
                tbody.appendChild(row);
            });
        }
        
        // 更新分页信息
        function updatePagination() {
            const totalPages = Math.ceil(allRequests.length / itemsPerPage);
            document.getElementById('page-info').textContent = "第 " + currentPage + " 页，共 " + totalPages + " 页";
            
            document.getElementById('prev-page').disabled = currentPage <= 1;
            document.getElementById('next-page').disabled = currentPage >= totalPages;
        }
        
        // 更新图表
        function updateChart() {
            const ctx = document.getElementById('requestsChart').getContext('2d');
            
            // 准备图表数据 - 最近20条请求的响应时间
            const chartData = allRequests.slice(0, 20).reverse();
            const labels = chartData.map(req => {
                const time = new Date(req.timestamp);
                return time.toLocaleTimeString();
            });
            const responseTimes = chartData.map(req => req.duration);
            
            // 如果图表已存在，先销毁
            if (requestsChart) {
                requestsChart.destroy();
            }
            
            // 创建新图表
            requestsChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: '响应时间 (s)',
                        data: responseTimes.map(time => time / 1000),
                        borderColor: '#00fff5',
                        backgroundColor: 'rgba(0, 255, 245, 0.1)',
                        tension: 0.1,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#a0a0c0',
                                font: {
                                    family: 'JetBrains Mono'
                                }
                            },
                            title: {
                                display: true,
                                text: '响应时间 (s)',
                                color: '#00fff5',
                                font: {
                                    family: 'Space Grotesk',
                                    weight: '500'
                                }
                            }
                        },
                        x: {
                            grid: {
                                color: 'rgba(255, 255, 255, 0.05)',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#a0a0c0',
                                font: {
                                    family: 'JetBrains Mono'
                                }
                            },
                            title: {
                                display: true,
                                text: '时间',
                                color: '#00fff5',
                                font: {
                                    family: 'Space Grotesk',
                                    weight: '500'
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: '最近20条请求的响应时间趋势',
                            color: '#ffffff',
                            font: {
                                family: 'Space Grotesk',
                                size: 14,
                                weight: '700'
                            },
                            padding: {
                                bottom: 20
                            }
                        }
                    }
                }
            });
        }
        
        // 分页按钮事件
        document.getElementById('prev-page').addEventListener('click', function() {
            if (currentPage > 1) {
                currentPage--;
                updateTable();
                updatePagination();
            }
        });
        
        document.getElementById('next-page').addEventListener('click', function() {
            const totalPages = Math.ceil(allRequests.length / itemsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                updateTable();
                updatePagination();
            }
        });
        
        // 初始加载
        updateStats();
        updateRequests();
        
        // 定时刷新
        setInterval(updateStats, 5000);
        setInterval(updateRequests, 5000);
    </script>
</body>
</html>`;
}

/**
 * 处理 Dashboard 监控页面请求
 * 返回实时监控面板的HTML页面
 * @param request HTTP请求对象
 * @returns Promise<Response> HTML响应
 */
async function handleDashboard(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getDashboardHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// 处理Dashboard统计数据
async function handleDashboardStats(_request: Request): Promise<Response> {
  return new Response(getStatsData(), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function handleDashboardRequests(_request: Request): Promise<Response> {
  return new Response(getLiveRequestsData(), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getDocsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZtoApi 文档</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
<style>
    :root {
        --bg-primary: #0a0a0f;
        --bg-secondary: #13131a;
        --bg-card: rgba(19, 19, 26, 0.8);
        --bg-card-hover: rgba(19, 19, 26, 0.95);
        --accent-cyan: #00fff5;
        --accent-purple: #b94fff;
        --accent-pink: #ff00aa;
        --accent-green: #00ff88;
        --text-primary: #ffffff;
        --text-secondary: #a0a0c0;
        --text-muted: #6b7280;
        --border-glow: rgba(0, 255, 245, 0.3);
        --border-subtle: rgba(255, 255, 255, 0.1);
        --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
    }

    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        line-height: 1.7;
        padding: 40px 20px;
        min-height: 100vh;
    }

    .container {
        max-width: 1200px;
        margin: 0 auto;
        background: var(--bg-card);
        border-radius: 16px;
        box-shadow: var(--shadow-glow);
        padding: 50px;
        border: 1px solid var(--border-subtle);
    }

    h1 {
        font-size: clamp(2.5rem, 6vw, 4rem);
        font-weight: 700;
        line-height: 1.1;
        margin-bottom: 40px;
        text-align: center;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -2px;
    }

    h2 {
        color: var(--accent-cyan);
        margin-top: 50px;
        margin-bottom: 25px;
        font-size: 1.8rem;
        font-weight: 600;
        letter-spacing: 1px;
        text-transform: uppercase;
    }

    h3 {
        color: var(--text-primary);
        margin-top: 30px;
        margin-bottom: 15px;
        font-size: 1.3rem;
        font-weight: 500;
    }

    .endpoint {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 25px;
        margin-bottom: 30px;
        border-left: 4px solid var(--accent-cyan);
        transition: all 0.3s ease;
    }

    .endpoint:hover {
        transform: translateX(5px);
        box-shadow: -5px 5px 20px rgba(0, 255, 245, 0.15);
    }

    .method {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 6px;
        color: white;
        font-weight: 700;
        margin-right: 15px;
        font-size: 0.85rem;
        letter-spacing: 1px;
        text-transform: uppercase;
    }

    .get { background-color: var(--accent-green); }
    .post { background-color: var(--accent-cyan); }

    .path {
        font-family: 'JetBrains Mono', monospace;
        background: var(--bg-card);
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 0.95rem;
        color: var(--accent-purple);
        border: 1px solid var(--border-subtle);
    }

    .description {
        margin: 20px 0;
        color: var(--text-secondary);
        font-size: 1.05rem;
        line-height: 1.6;
    }

    .parameters {
        margin: 25px 0;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        margin: 20px 0;
        background: var(--bg-card);
        border-radius: 12px;
        overflow: hidden;
    }

    th, td {
        padding: 16px;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle);
    }

    th {
        background: var(--bg-secondary);
        color: var(--accent-cyan);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 0.85rem;
    }

    tr:hover {
        background: var(--bg-card-hover);
    }

    .example {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        font-family: 'JetBrains Mono', monospace;
        white-space: pre-wrap;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        font-size: 0.9rem;
        line-height: 1.5;
    }

    code {
        font-family: 'JetBrains Mono', monospace;
        background: rgba(0, 255, 245, 0.1);
        padding: 3px 8px;
        border-radius: 4px;
        color: var(--accent-cyan);
        font-size: 0.9em;
    }

    .note {
        background: rgba(255, 0, 170, 0.1);
        border-left: 4px solid var(--accent-pink);
        padding: 15px 20px;
        margin: 20px 0;
        border-radius: 0 8px 8px 0;
        color: var(--text-primary);
    }

    .response {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        font-family: 'JetBrains Mono', monospace;
        white-space: pre-wrap;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        color: var(--accent-green);
        font-size: 0.9rem;
    }

    .tab {
        overflow: hidden;
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        border-radius: 8px 8px 0 0;
        margin-bottom: 25px;
    }

    .tab button {
        background-color: inherit;
        float: left;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 14px 20px;
        transition: 0.3s;
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .tab button:hover {
        background: var(--bg-card-hover);
        color: var(--accent-cyan);
    }

    .tab button.active {
        background: var(--accent-cyan);
        color: var(--bg-primary);
        font-weight: 600;
    }

    .tabcontent {
        display: none;
        padding: 25px;
        border: 1px solid var(--border-subtle);
        border-top: none;
        border-radius: 0 0 8px 8px;
        background: var(--bg-card);
    }

    .toc {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 25px;
        margin-bottom: 40px;
        border: 1px solid var(--border-subtle);
    }

    .toc h2 {
        margin-top: 0;
        color: var(--accent-purple);
        font-size: 1.3rem;
    }

    .toc ul {
        padding-left: 25px;
        list-style: none;
    }

    .toc li {
        margin: 12px 0;
    }

    .toc a {
        color: var(--accent-cyan);
        text-decoration: none;
        font-size: 1.05rem;
        transition: color 0.3s ease;
    }

    .toc a:hover {
        color: var(--accent-purple);
        text-decoration: underline;
    }

    .page-actions {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin: -20px 0 40px;
        flex-wrap: wrap;
    }

    .action-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        border-radius: 999px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        text-decoration: none;
        font-size: 0.9rem;
        transition: all 0.3s ease;
    }

    .action-link:hover {
        color: var(--text-primary);
        border-color: var(--border-glow);
        box-shadow: -5px 5px 20px rgba(0, 255, 245, 0.15);
        transform: translateY(-2px);
    }

    /* Responsive */
    @media (max-width: 768px) {
        body {
            padding: 20px 10px;
        }

        .container {
            padding: 30px 20px;
        }

        h1 {
            font-size: 2rem;
        }

        .endpoint {
            padding: 20px;
        }

        table {
            font-size: 0.85rem;
        }

        .tab button {
            padding: 12px 16px;
            font-size: 0.85rem;
        }
    }
</style>
</head>
<body>
<div class="container">
    <h1>ZtoApi 文档</h1>

    <div class="page-actions">
        <a class="action-link" href="/">返回首页</a>
        <a class="action-link" href="/deno-deploy">Deno Deploy 部署</a>
    </div>

    <div class="toc">
        <h2>目录</h2>
        <ul>
            <li><a href="#overview">概述</a></li>
            <li><a href="#models">支持的模型</a></li>
            <li><a href="#authentication">身份验证</a></li>
            <li><a href="#endpoints">API端点</a>
                <ul>
                    <li><a href="#models-list">获取模型列表</a></li>
                    <li><a href="#chat-completions">聊天完成</a></li>
                </ul>
            </li>
            <li><a href="#examples">使用示例</a></li>
            <li><a href="#error-handling">错误处理</a></li>
        </ul>
    </div>

    <section id="overview">
        <h2>概述</h2>
        <p>ZtoApi 是一个高性能的 OpenAI 兼容 API 代理服务器，为 Z.ai 的 GLM 系列模型提供标准化的访问接口。支持流式和非流式响应，提供实时监控面板，并具备企业级的可用性和安全性。</p>
        <p><strong>基础URL:</strong> <code>http://localhost:9090/v1</code></p>
        <div class="note">
            <strong>注意:</strong> 默认端口为9090，可以通过环境变量 PORT 进行修改。
        </div>
    </section>

    <section id="models">
        <h2>支持的模型</h2>
        <p>ZtoApi 支持 Z.ai 的多个先进 AI 模型：</p>
        <table>
            <thead>
                <tr>
                    <th>模型 ID</th>
                    <th>模型名称</th>
                    <th>特性</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><code>0727-360B-API</code></td>
                    <td>GLM-4.5</td>
                    <td>通用对话、代码生成、思考过程</td>
                </tr>
                <tr>
                    <td><code>glm-4.6</code></td>
                    <td>GLM-4.6</td>
                    <td>🚀 增强推理、高级代码生成、深度搜索</td>
                </tr>
                <tr>
                    <td><code>glm-4.7</code></td>
                    <td>GLM-4.7</td>
                    <td>🆕 最新推理、更强思考能力、卓越编程</td>
                </tr>
                <tr>
                    <td><code>glm-5</code></td>
                    <td>GLM-5</td>
                    <td>🚀 旗舰模型、全方位能力提升</td>
                </tr>
                <tr>
                    <td><code>glm-4.5v</code></td>
                    <td>GLM-4.5V</td>
                    <td>🎯 全方位多模态：图像、视频、文档、音频</td>
                </tr>
                <tr>
                    <td><code>glm-4.6v</code></td>
                    <td>GLM-4.6V</td>
                    <td>🚀 增强多模态：高级视觉理解</td>
                </tr>
                <tr>
                    <td><code>0727-106B-API</code></td>
                    <td>GLM-4.5-Air</td>
                    <td>⚡ 轻量快速、低延迟响应</td>
                </tr>
                <tr>
                    <td><code>0808-360B-DR</code></td>
                    <td>0808-360B-DR</td>
                    <td>🔬 深度研究专用、长文本分析</td>
                </tr>
            </tbody>
        </table>
        <div class="note">
            <strong>模型说明:</strong> 多模态模型（4.5V、4.6V）支持图像、视频、文档和音频内容处理。其他模型专注于文本对话和推理能力。
        </div>
        <div class="note">
            <strong>关于工具调用:</strong> ZtoApi 已完整支持 OpenAI 格式的 <code>tools</code> 参数解析和转发，但实际工具调用功能受限于上游 Z.ai API。目前测试显示 <code>/api/v2/chat/completions</code> 端点可能未完全启用工具调用功能，建议使用 <code>reasoning: true</code> 参数启用思考模式以获得类似的推理能力。
        </div>
    </section>

    <section id="authentication">
        <h2>身份验证</h2>
        <p>所有API请求都需要在请求头中包含有效的API密钥进行身份验证：</p>
        <div class="example">
Authorization: Bearer your-api-key</div>
        <p>默认的API密钥为 <code>sk-your-key</code>，可以通过环境变量 <code>DEFAULT_KEY</code> 进行修改。</p>
    </section>
    
    <section id="endpoints">
        <h2>API端点</h2>
        
        <div class="endpoint" id="models-list">
            <h3>获取模型列表</h3>
            <div>
                <span class="method get">GET</span>
                <span class="path">/v1/models</span>
            </div>
            <div class="description">
                <p>获取可用模型列表。</p>
            </div>
            <div class="parameters">
                <h4>请求参数</h4>
                <p>无</p>
            </div>
            <div class="response">
{
  "object": "list",
  "data": [
    {
      "id": "GLM-4.5",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.5V",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.6",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.6V",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.7",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-5",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-4.5-Air",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    },
    {
      "id": "GLM-DR",
      "object": "model",
      "created": 1756788845,
      "owned_by": "z.ai"
    }
  ]
}</div>
        </div>
        
        <div class="endpoint" id="chat-completions">
            <h3>聊天完成</h3>
            <div>
                <span class="method post">POST</span>
                <span class="path">/v1/chat/completions</span>
            </div>
            <div class="description">
                <p>基于消息列表生成模型响应。支持流式和非流式两种模式。</p>
            </div>
            <div class="parameters">
                <h4>请求参数</h4>
                <table>
                    <thead>
                        <tr>
                            <th>参数名</th>
                            <th>类型</th>
                            <th>必需</th>
                            <th>说明</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>model</td>
                            <td>string</td>
                            <td>是</td>
                            <td>要使用的模型ID，例如 "GLM-4.5"</td>
                        </tr>
                        <tr>
                            <td>messages</td>
                            <td>array</td>
                            <td>是</td>
                            <td>消息列表，包含角色和内容</td>
                        </tr>
                        <tr>
                            <td>stream</td>
                            <td>boolean</td>
                            <td>否</td>
                            <td>是否使用流式响应，默认为true</td>
                        </tr>
                        <tr>
                            <td>temperature</td>
                            <td>number</td>
                            <td>否</td>
                            <td>采样温度，控制随机性</td>
                        </tr>
                        <tr>
                            <td>max_tokens</td>
                            <td>integer</td>
                            <td>否</td>
                            <td>生成的最大令牌数</td>
                        </tr>
                        <tr>
                            <td>reasoning</td>
                            <td>boolean</td>
                            <td>否</td>
                            <td>启用思考模式，展示模型推理过程（推荐用于复杂任务）</td>
                        </tr>
                        <tr>
                            <td>tools</td>
                            <td>array</td>
                            <td>否</td>
                            <td>OpenAI 格式的工具定义列表（功能受上游 API 限制）</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="parameters">
                <h4>消息格式</h4>
                <table>
                    <thead>
                        <tr>
                            <th>字段</th>
                            <th>类型</th>
                            <th>说明</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>role</td>
                            <td>string</td>
                            <td>消息角色，可选值：system、user、assistant</td>
                        </tr>
                        <tr>
                            <td>content</td>
                            <td>string</td>
                            <td>消息内容</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </section>
    
    <section id="examples">
        <h2>使用示例</h2>
        
        <div class="tab">
            <button class="tablinks active" onclick="openTab(event, 'python-tab')">Python</button>
            <button class="tablinks" onclick="openTab(event, 'curl-tab')">cURL</button>
            <button class="tablinks" onclick="openTab(event, 'javascript-tab')">JavaScript</button>
        </div>
        
        <div id="python-tab" class="tabcontent" style="display: block;">
            <h3>Python示例</h3>
            <div class="example">
import openai

# 配置客户端
client = openai.OpenAI(
  api_key="your-api-key",  # 对应 DEFAULT_KEY
  base_url="http://localhost:9090/v1"
)

# 示例 1: 使用旗舰模型 GLM-5 进行复杂推理
response = client.chat.completions.create(
  model="GLM-5",
  messages=[{"role": "user", "content": "分析并优化这段代码的时间复杂度"}]
)
print(response.choices[0].message.content)

# 示例 2: 使用 GLM-4.5-Air 快速响应（适合简单对话）
response = client.chat.completions.create(
  model="GLM-4.5-Air",
  messages=[{"role": "user", "content": "今天天气怎么样？"}]
)
print(response.choices[0].message.content)

# 示例 3: 流式请求 - 使用 GLM-4.7
response = client.chat.completions.create(
  model="GLM-4.7",
  messages=[{"role": "user", "content": "请写一首关于春天的诗"}],
  stream=True
)

for chunk in response:
  if chunk.choices[0].delta.content:
    print(chunk.choices[0].delta.content, end="")

# 示例 4: 启用思考模式（GLM-4.5/4.6/4.7/5 支持）
response = client.chat.completions.create(
  model="GLM-5",
  messages=[{"role": "user", "content": "分析这段算法的时间复杂度并给出优化建议"}],
  reasoning=True  # 启用思考模式，展示详细推理过程
)
print(response.choices[0].message.content)

# 示例 5: 使用多模态模型 GLM-4.6V（支持图像）
# response = client.chat.completions.create(
#   model="GLM-4.6V",
#   messages=[{
#     "role": "user",
#     "content": [
#       {"type": "text", "text": "描述这张图片"},
#       {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
#     ]
#   }]
# )</div>
        </div>
        
        <div id="curl-tab" class="tabcontent">
            <h3>cURL示例</h3>
            <div class="example">
# 示例 1: 使用旗舰模型 GLM-5（复杂任务）
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-5",
    "messages": [{"role": "user", "content": "请分析这段代码的性能瓶颈"}],
    "stream": false
  }'

# 示例 2: 使用 GLM-4.5-Air 快速响应（简单对话）
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-4.5-Air",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'

# 示例 3: 流式请求 - 使用 GLM-4.7
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-4.7",
    "messages": [{"role": "user", "content": "讲一个有趣的故事"}],
    "stream": true
  }'

# 示例 4: 启用思考模式 - 使用 GLM-5（展示详细推理过程）
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-5",
    "messages": [{"role": "user", "content": "分析这段算法的时间复杂度并给出优化建议"}],
    "reasoning": true,
    "stream": false
  }'

# 示例 5: 多模态请求 - 使用 GLM-4.6V（支持图像）
# curl -X POST http://localhost:9090/v1/chat/completions \
#   -H "Content-Type: application/json" \
#   -H "Authorization: Bearer your-api-key" \
#   -d '{
#     "model": "GLM-4.6V",
#     "messages": [{
#       "role": "user",
#       "content": [
#         {"type": "text", "text": "这张图片里有什么？"},
#         {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
#       ]
#     }],
#     "stream": false
#   }'</div>
        </div>
        
        <div id="javascript-tab" class="tabcontent">
            <h3>JavaScript示例</h3>
            <div class="example">
const fetch = require('node-fetch');

async function chatWithGLM(model, message, stream = false) {
  const response = await fetch('http://localhost:9090/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer your-api-key'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: message }],
      stream: stream
    })
  });

  if (stream) {
    // 处理流式响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('\n流式响应完成');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              process.stdout.write(content);
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }
  } else {
    // 处理非流式响应
    const data = await response.json();
    console.log(data.choices[0].message.content);
  }
}

// 使用示例 1: 旗舰模型 GLM-5（复杂任务）
chatWithGLM('GLM-5', '请分析并优化这段算法的时间复杂度', false);

// 使用示例 2: GLM-4.5-Air（快速响应）
chatWithGLM('GLM-4.5-Air', '你好', false);

// 使用示例 3: GLM-4.7 流式响应
chatWithGLM('GLM-4.7', '写一个关于未来的短篇故事', true);

// 使用示例 4: 启用思考模式（GLM-4.5/4.6/4.7/5 支持）
async function chatWithReasoning(model, message) {
  const response = await fetch('http://localhost:9090/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer your-api-key'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: message }],
      reasoning: true,  // 启用思考模式
      stream: false
    })
  });
  const data = await response.json();
  console.log(data.choices[0].message.content);
}

chatWithReasoning('GLM-5', '分析这段算法的时间复杂度并给出优化建议');

// 使用示例 5: 多模态模型 GLM-4.6V（支持图像）
// chatWithGLM('GLM-4.6V', [
//   { type: 'text', text: '描述这张图片' },
//   { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
// ], false);</div>
        </div>
    </section>
    
    <section id="error-handling">
        <h2>错误处理</h2>
        <p>API使用标准HTTP状态码来表示请求的成功或失败：</p>
        <table>
            <thead>
                <tr>
                    <th>状态码</th>
                    <th>说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>200 OK</td>
                    <td>请求成功</td>
                </tr>
                <tr>
                    <td>400 Bad Request</td>
                    <td>请求格式错误或参数无效</td>
                </tr>
                <tr>
                    <td>401 Unauthorized</td>
                    <td>API密钥无效或缺失</td>
                </tr>
                <tr>
                    <td>502 Bad Gateway</td>
                    <td>上游服务错误</td>
                </tr>
            </tbody>
        </table>
        <div class="note">
            <strong>注意:</strong> 在调试模式下，服务器会输出详细的日志信息，可以通过设置环境变量 DEBUG_MODE=true 来启用。
        </div>
    </section>
</div>

<script>
    function openTab(evt, tabName) {
        var i, tabcontent, tablinks;
        tabcontent = document.getElementsByClassName("tabcontent");
        for (i = 0; i < tabcontent.length; i++) {
            tabcontent[i].style.display = "none";
        }
        tablinks = document.getElementsByClassName("tablinks");
        for (i = 0; i < tablinks.length; i++) {
            tablinks[i].className = tablinks[i].className.replace(" active", "");
        }
        document.getElementById(tabName).style.display = "block";
        evt.currentTarget.className += " active";
    }
</script>
</body>
</html>`;
}

function getDenoDeployHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deno Deploy 部署 - ZtoApi</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@300;500;700&display=swap" rel="stylesheet">
<style>
    :root {
        --bg-primary: #0a0a0f;
        --bg-secondary: #13131a;
        --bg-card: rgba(19, 19, 26, 0.8);
        --bg-card-hover: rgba(19, 19, 26, 0.95);
        --accent-cyan: #00fff5;
        --accent-purple: #b94fff;
        --accent-pink: #ff00aa;
        --accent-green: #00ff88;
        --text-primary: #ffffff;
        --text-secondary: #a0a0c0;
        --text-muted: #6b7280;
        --border-glow: rgba(0, 255, 245, 0.3);
        --border-subtle: rgba(255, 255, 255, 0.1);
        --shadow-glow: 0 20px 40px rgba(0, 255, 245, 0.15);
    }

    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        line-height: 1.7;
        padding: 40px 20px;
        min-height: 100vh;
    }

    .container {
        max-width: 1200px;
        margin: 0 auto;
        background: var(--bg-card);
        border-radius: 16px;
        box-shadow: var(--shadow-glow);
        padding: 50px;
        border: 1px solid var(--border-subtle);
    }

    h1 {
        font-size: clamp(2.5rem, 6vw, 4rem);
        font-weight: 700;
        line-height: 1.1;
        margin-bottom: 40px;
        text-align: center;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-cyan) 50%, var(--accent-purple) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -2px;
    }

    h2 {
        color: var(--accent-cyan);
        margin-top: 50px;
        margin-bottom: 25px;
        font-size: 1.8rem;
        font-weight: 600;
        letter-spacing: 1px;
        text-transform: uppercase;
    }

    h3 {
        color: var(--text-primary);
        margin-top: 30px;
        margin-bottom: 15px;
        font-size: 1.3rem;
        font-weight: 500;
    }

    p {
        color: var(--text-secondary);
        margin: 12px 0;
    }

    .section-card {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px 24px;
        border: 1px solid var(--border-subtle);
    }

    .step-list {
        padding-left: 22px;
        color: var(--text-secondary);
    }

    .step-list li {
        margin: 12px 0;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        margin: 20px 0;
        background: var(--bg-card);
        border-radius: 12px;
        overflow: hidden;
    }

    th, td {
        padding: 16px;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle);
        vertical-align: top;
    }

    th {
        background: var(--bg-secondary);
        color: var(--accent-cyan);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 0.85rem;
    }

    tr:hover {
        background: var(--bg-card-hover);
    }

    .example {
        background: var(--bg-secondary);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        font-family: 'JetBrains Mono', monospace;
        white-space: pre-wrap;
        overflow-x: auto;
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        font-size: 0.9rem;
        line-height: 1.5;
    }

    code {
        font-family: 'JetBrains Mono', monospace;
        background: rgba(0, 255, 245, 0.1);
        padding: 3px 8px;
        border-radius: 4px;
        color: var(--accent-cyan);
        font-size: 0.9em;
    }

    .note {
        background: rgba(255, 0, 170, 0.1);
        border-left: 4px solid var(--accent-pink);
        padding: 15px 20px;
        margin: 20px 0;
        border-radius: 0 8px 8px 0;
        color: var(--text-primary);
    }

    .page-actions {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin: -20px 0 40px;
        flex-wrap: wrap;
    }

    .action-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        border-radius: 999px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        text-decoration: none;
        font-size: 0.9rem;
        transition: all 0.3s ease;
    }

    .action-link:hover {
        color: var(--text-primary);
        border-color: var(--border-glow);
        box-shadow: -5px 5px 20px rgba(0, 255, 245, 0.15);
        transform: translateY(-2px);
    }

    @media (max-width: 768px) {
        body {
            padding: 20px 10px;
        }

        .container {
            padding: 30px 20px;
        }

        h1 {
            font-size: 2rem;
        }

        table {
            font-size: 0.85rem;
        }
    }
</style>
</head>
<body>
<div class="container">
    <h1>Deno Deploy 部署</h1>

    <div class="page-actions">
        <a class="action-link" href="/">返回首页</a>
        <a class="action-link" href="/docs">API 文档</a>
        <a class="action-link" href="/dashboard">监控看板</a>
    </div>

    <section id="overview">
        <h2>概述</h2>
        <p>本页介绍在 Deno Deploy 上部署 ZtoApi 的流程与注意事项。部署完成后，你将获得类似 <code>https://your-project.deno.dev</code> 的访问地址。</p>
        <div class="note">
            <strong>提示:</strong> 未配置 <code>ZAI_TOKEN</code> 或 <code>ZAI_TOKENS</code> 时仅支持文本对话，多模态功能会被限制。
        </div>
    </section>

    <section id="steps">
        <h2>部署步骤</h2>
        <div class="section-card">
            <ol class="step-list">
                <li>准备仓库：确保 <code>main.ts</code> 位于仓库根目录并已推送。</li>
                <li>在 Deno Deploy 控制台创建项目并连接 GitHub 仓库。</li>
                <li>选择部署分支与入口文件 <code>main.ts</code>。</li>
                <li>配置环境变量（见下表）。</li>
                <li>部署完成后访问 <code>/v1/models</code> 与 <code>/dashboard</code> 进行验证。</li>
            </ol>
        </div>
    </section>

    <section id="env">
        <h2>环境变量说明</h2>
        <table>
            <thead>
                <tr>
                    <th>变量</th>
                    <th>用途</th>
                    <th>建议</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><code>DEFAULT_KEY</code></td>
                    <td>客户端访问密钥，用于请求鉴权</td>
                    <td>生产环境务必设置为强随机值</td>
                </tr>
                <tr>
                    <td><code>ZAI_TOKEN</code></td>
                    <td>单个 Z.ai Token，多模态功能必需</td>
                    <td>没有 Token 时仅支持文本</td>
                </tr>
                <tr>
                    <td><code>ZAI_TOKENS</code></td>
                    <td>多 Token 池，自动轮换提升可用性</td>
                    <td>生产推荐优先使用</td>
                </tr>
                <tr>
                    <td><code>ZAI_SIGNING_SECRET</code></td>
                    <td>自定义签名密钥，增强安全性</td>
                    <td>生产建议设置</td>
                </tr>
                <tr>
                    <td><code>DEBUG_MODE</code></td>
                    <td>调试日志开关</td>
                    <td>生产环境设为 <code>false</code></td>
                </tr>
                <tr>
                    <td><code>DEFAULT_STREAM</code></td>
                    <td>默认启用流式响应</td>
                    <td>保持 <code>true</code> 获取更低延迟</td>
                </tr>
                <tr>
                    <td><code>DASHBOARD_ENABLED</code></td>
                    <td>监控看板开关</td>
                    <td>需要监控时保持开启</td>
                </tr>
            </tbody>
        </table>
        <div class="note">
            <strong>建议:</strong> 生产环境推荐使用 <code>ZAI_TOKENS</code> 并关闭 <code>DEBUG_MODE</code> 以提升稳定性与性能。
        </div>
    </section>

    <section id="examples">
        <h2>示例代码</h2>
        <div class="example">curl -X GET https://your-project.deno.dev/v1/models \
  -H "Authorization: Bearer sk-your-key"</div>
        <div class="example">curl -X POST https://your-project.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'</div>
    </section>

    <section id="faq">
        <h2>常见问题</h2>
        <table>
            <thead>
                <tr>
                    <th>问题</th>
                    <th>可能原因</th>
                    <th>处理建议</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>401 Unauthorized</td>
                    <td>DEFAULT_KEY 不匹配</td>
                    <td>确认请求头 Bearer 与部署环境的 DEFAULT_KEY 一致</td>
                </tr>
                <tr>
                    <td>502 Bad Gateway</td>
                    <td>上游服务异常或 Token 失效</td>
                    <td>检查 ZAI_TOKEN/ZAI_TOKENS 是否有效</td>
                </tr>
                <tr>
                    <td>/dashboard 无法访问</td>
                    <td>DASHBOARD_ENABLED=false</td>
                    <td>在部署环境变量中启用该开关</td>
                </tr>
                <tr>
                    <td>多模态请求失败</td>
                    <td>未配置正式 Token</td>
                    <td>设置 ZAI_TOKEN 或 ZAI_TOKENS</td>
                </tr>
            </tbody>
        </table>
    </section>
</div>
</body>
</html>`;
}

// 处理API文档页面
async function handleDocs(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getDocsHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// 处理Deno Deploy部署页面
async function handleDenoDeploy(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  return new Response(getDenoDeployHTML(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// 主HTTP服务器
async function main() {
  console.log(`OpenAI兼容API服务器启动`);
  console.log(
    `支持的模型: ${SUPPORTED_MODELS.map((m) => `${m.id} (${m.name})`).join(
      ", "
    )}`
  );
  console.log(`上游: ${UPSTREAM_URL}`);
  console.log(`Debug模式: ${DEBUG_MODE}`);
  console.log(`默认流式响应: ${DEFAULT_STREAM}`);
  console.log(`Dashboard启用: ${DASHBOARD_ENABLED}`);

  // 检测是否在Deno Deploy上运行
  const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

  if (isDenoDeploy) {
    // Deno Deploy环境
    console.log("运行在Deno Deploy环境中");
    Deno.serve(handleRequest);
  } else {
    // 本地或自托管环境
    const port = parseInt(Deno.env.get("PORT") || "9090");
    console.log(`运行在本地环境中，端口: ${port}`);

    if (DASHBOARD_ENABLED) {
      console.log(
        `Dashboard已启用，访问地址: http://localhost:${port}/dashboard`
      );
    }

    const server = Deno.listen({ port });

    for await (const conn of server) {
      handleHttp(conn);
    }
  }
}

// 处理HTTP连接（用于本地环境）
async function handleHttp(conn: Deno.Conn) {
  const httpConn = Deno.serveHttp(conn);

  while (true) {
    const requestEvent = await httpConn.nextRequest();
    if (!requestEvent) break;

    const { request, respondWith } = requestEvent;
    const url = new URL(request.url);
    const startTime = Date.now();
    const userAgent = request.headers.get("User-Agent") || "";

    try {
      // 路由分发
      if (url.pathname === "/") {
        const response = await handleIndex(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/v1/models") {
        const response = await handleModels(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/v1/chat/completions") {
        const response = await handleChatCompletions(request);
        await respondWith(response);
        // 请求统计已在handleChatCompletions中记录
      } else if (url.pathname === "/internal/session-state") {
        const response = await handleInternalSessionState(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/internal/pure-code-worker") {
        const response = await handleInternalPureCodeWorker(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/docs") {
        const response = await handleDocs(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/deno-deploy") {
        const response = await handleDenoDeploy(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard" && DASHBOARD_ENABLED) {
        const response = await handleDashboard(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard/stats" && DASHBOARD_ENABLED) {
        const response = await handleDashboardStats(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else if (url.pathname === "/dashboard/requests" && DASHBOARD_ENABLED) {
        const response = await handleDashboardRequests(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      } else {
        const response = await handleOptions(request);
        await respondWith(response);
        recordRequestStats(startTime, url.pathname, response.status);
        addLiveRequest(
          request.method,
          url.pathname,
          response.status,
          Date.now() - startTime,
          userAgent
        );
      }
    } catch (error) {
      debugLog("处理请求时出错: %v", error);
      const response = new Response("Internal Server Error", { status: 500 });
      await respondWith(response);
      recordRequestStats(startTime, url.pathname, 500);
      addLiveRequest(
        request.method,
        url.pathname,
        500,
        Date.now() - startTime,
        userAgent
      );
    }
  }
}

// 处理HTTP请求（用于Deno Deploy环境）
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const startTime = Date.now();
  const userAgent = request.headers.get("User-Agent") || "";

  try {
    // 路由分发
    if (url.pathname === "/") {
      const response = await handleIndex(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/v1/models") {
      const response = await handleModels(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/v1/chat/completions") {
      const response = await handleChatCompletions(request);
      // 请求统计已在handleChatCompletions中记录
      return response;
    } else if (url.pathname === "/internal/session-state") {
      const response = await handleInternalSessionState(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/internal/pure-code-worker") {
      const response = await handleInternalPureCodeWorker(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/docs") {
      const response = await handleDocs(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/deno-deploy") {
      const response = await handleDenoDeploy(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard" && DASHBOARD_ENABLED) {
      const response = await handleDashboard(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard/stats" && DASHBOARD_ENABLED) {
      const response = await handleDashboardStats(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else if (url.pathname === "/dashboard/requests" && DASHBOARD_ENABLED) {
      const response = await handleDashboardRequests(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    } else {
      const response = await handleOptions(request);
      recordRequestStats(startTime, url.pathname, response.status);
      addLiveRequest(
        request.method,
        url.pathname,
        response.status,
        Date.now() - startTime,
        userAgent
      );
      return response;
    }
  } catch (error) {
    debugLog("处理请求时出错: %v", error);
    recordRequestStats(startTime, url.pathname, 500);
    addLiveRequest(
      request.method,
      url.pathname,
      500,
      Date.now() - startTime,
      userAgent
    );
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 启动服务器
main();
