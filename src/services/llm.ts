import type { LlmConfig } from '../types';
import { describeError, logger } from '../utils/logger';
import { parseJsonLoose, truncate } from '../utils/text';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 置 true 时附带 response_format=json_object。并非所有兼容服务都支持，默认关闭。 */
  jsonMode?: boolean;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 覆盖默认的最大尝试次数（含首次） */
  maxAttempts?: number;
}

/** 失败分类，用于日志区分与是否重试的判定。 */
export type LlmFailureKind = 'network' | 'timeout' | 'http' | 'parse' | 'empty';

export const FAILURE_LABEL: Record<LlmFailureKind, string> = {
  network: '网络失败',
  timeout: '请求超时',
  http: 'HTTP 失败',
  parse: 'JSON 解析失败',
  empty: '模型返回空内容',
};

/* ---------------- 重试策略 ---------------- */

/** 最多 3 次请求（首次 + 2 次重试）。 */
const MAX_ATTEMPTS = 3;
/** 退避等待（毫秒），最后一次沿用最后一个值。 */
const RETRY_BACKOFF_MS = [600, 1500];
/** 单次请求超时。 */
const DEFAULT_TIMEOUT_MS = 45_000;
/** 多次尝试的总预算，避免一路重试拖到几分钟。 */
const TOTAL_BUDGET_MS = 150_000;

/** 这些网络错误是"环境就错了"，重试没有意义。 */
const PERMANENT_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_NONAME',
  'ERR_INVALID_URL',
  'ERR_INVALID_PROTOCOL',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ABORT_ERR',
]);

export class LlmError extends Error {
  kind: LlmFailureKind;
  status: number | null;
  /** 底层错误码，例如 ECONNRESET */
  code: string | null;
  /** 底层错误类型名，例如 TypeError / SocketError */
  causeType: string | null;
  /** 已经尝试了几次 */
  attempts: number;
  /** 从第一次请求开始算的总耗时 */
  elapsedMs: number;
  retryable: boolean;
  /** 服务端 Retry-After 建议的等待时长；有值时用它替代默认退避，而不是叠加 */
  retryAfterMs: number | null;

  constructor(
    message: string,
    details: {
      kind: LlmFailureKind;
      status?: number | null;
      code?: string | null;
      causeType?: string | null;
      attempts?: number;
      elapsedMs?: number;
      retryable?: boolean;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = details.kind;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.causeType = details.causeType ?? null;
    this.attempts = details.attempts ?? 1;
    this.elapsedMs = details.elapsedMs ?? 0;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/** 统一的失败描述，供日志与验证脚本区分四类失败。 */
export function describeLlmFailure(failure: LlmError): string {
  const parts = [`[LLM][${FAILURE_LABEL[failure.kind]}]`];
  if (failure.status !== null) parts.push(`HTTP=${failure.status}`);
  if (failure.code) parts.push(`code=${failure.code}`);
  if (failure.causeType) parts.push(`cause=${failure.causeType}`);
  parts.push(`attempt=${failure.attempts}/${MAX_ATTEMPTS}`);
  parts.push(`elapsed=${failure.elapsedMs}ms`);
  return `${parts.join(' ')} ${failure.message}`;
}

/* ---------------- 底层错误解析 ---------------- */

/** 顺着 cause 链找错误码（undici / Node 的底层错误都挂在 cause 上）。 */
function extractNetworkCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor && typeof cursor === 'object' && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/** 顺着 cause 链找最内层的错误类型名。 */
function extractCauseType(error: unknown): string | null {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  let last: string | null = null;
  for (let depth = 0; depth < 5 && cursor && typeof cursor === 'object' && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    if (cursor instanceof Error && cursor.name) last = cursor.name;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return last;
}

/**
 * 判断网络错误是否值得重试。
 * 没有错误码的（例如浏览器里裸的 "Failed to fetch"）一律当作可重试的临时故障 ——
 * 这正是最需要重试的那类情况。
 */
function isRetryableNetworkError(code: string | null): boolean {
  if (!code) return true;
  return !PERMANENT_NETWORK_CODES.has(code);
}

/** 只有限流、超时和 5xx 值得重试；4xx 重试是白费力气。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 尊重 Retry-After，但不要等太久。 */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, 5000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 客户端 ---------------- */

/**
 * 全项目唯一的 LLM 出口。
 * 业务代码里不允许出现裸 fetch —— 所有请求都必须经过这里，
 * 以便统一处理超时、有限重试、错误分类、JSON 清洗与日志脱敏。
 */
export class LlmClient {
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    };
  }

  get endpoint(): string {
    return `${this.config.baseUrl}/chat/completions`;
  }

  /** 日志里只出现去掉了 query / hash 的地址，避免密钥藏在参数里被写进日志。 */
  private get safeEndpoint(): string {
    return this.endpoint.replace(/[?#].*$/, '');
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS);
    const startedAt = Date.now();
    let lastFailure: LlmError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const elapsed = Date.now() - startedAt;
      if (attempt > 1 && elapsed >= TOTAL_BUDGET_MS) {
        logger.warn(`[LLM][网络失败] 重试预算已耗尽（${elapsed}ms），停止重试`);
        break;
      }

      try {
        const text = await this.requestOnce(messages, options, attempt, startedAt);
        if (attempt > 1) {
          logger.info(`[LLM] 第 ${attempt} 次尝试成功，累计耗时 ${Date.now() - startedAt}ms`);
        }
        return text;
      } catch (error) {
        const failure =
          error instanceof LlmError
            ? error
            : new LlmError(describeError(error), { kind: 'network', attempts: attempt, elapsedMs: Date.now() - startedAt });

        failure.attempts = attempt;
        failure.elapsedMs = Date.now() - startedAt;
        lastFailure = failure;

        if (!failure.retryable || attempt >= maxAttempts) {
          // 终止性失败也要留痕，否则日志里就看不到"模型返回空内容"这类结果
          logger.error(`${describeLlmFailure(failure)} -> 放弃，不再重试`);
          throw failure;
        }

        // 服务端给了 Retry-After 就用它，否则用默认退避；两者不叠加
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        const wait =
          failure.retryAfterMs ?? backoff + Math.floor(Math.random() * 200);
        logger.warn(`${describeLlmFailure(failure)} -> ${wait}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）`);
        await sleep(wait);
      }
    }

    throw (
      lastFailure ??
      new LlmError('LLM 请求失败', { kind: 'network', attempts: maxAttempts, elapsedMs: Date.now() - startedAt })
    );
  }

  /** 单次请求。不做重试，失败一律抛 LlmError 并带上分类信息。 */
  private async requestOnce(
    messages: ChatMessage[],
    options: ChatOptions,
    attempt: number,
    startedAt: number,
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const elapsed = () => Date.now() - startedAt;

    let response: Response;
    let requestBody: string;
    try {
      requestBody = JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options.temperature ?? this.config.temperature,
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === 'AbortError';
      const code = extractNetworkCode(error);
      const causeType = extractCauseType(error);
      // 只记录地址、模型、错误码与耗时；绝不记录 Authorization 头或请求体
      const detail = `endpoint=${this.safeEndpoint} model=${this.config.model} timeout=${timeoutMs}ms`;
      if (aborted) {
        const budget = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)} 秒`;
        throw new LlmError(`请求超过 ${budget} 未返回（${detail}）`, {
          kind: 'timeout',
          code,
          causeType,
          attempts: attempt,
          elapsedMs: elapsed(),
          retryable: true,
        });
      }
      throw new LlmError(`底层网络错误：${describeError(error)}（${detail}）`, {
        kind: 'network',
        code,
        causeType,
        attempts: attempt,
        elapsedMs: elapsed(),
        retryable: isRetryableNetworkError(code),
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      throw new LlmError(
        `HTTP ${response.status}${detail ? `：${truncate(detail.replace(/\s+/g, ' '), 200)}` : ''}`,
        {
          kind: 'http',
          status: response.status,
          attempts: attempt,
          elapsedMs: elapsed(),
          retryable: isRetryableStatus(response.status),
          retryAfterMs: retryAfterMs(response.headers),
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LlmError(`响应体不是合法 JSON：${describeError(error)}`, {
        kind: 'http',
        status: response.status,
        attempts: attempt,
        elapsedMs: elapsed(),
        // 协议层面的问题，不属于"临时网络故障"，不重试
        retryable: false,
      });
    }

    const content = extractContent(payload);
    if (!content.trim()) {
      throw new LlmError('响应里没有可用文本', {
        kind: 'empty',
        status: response.status,
        attempts: attempt,
        elapsedMs: elapsed(),
        retryable: false,
      });
    }
    return content;
  }

  /**
   * chat + JSON 解析。
   * 解析失败时把原始回复回传并要求重试一次（最多一次）——这是**纠正提示**，
   * 与网络层的自动重试是两套独立机制，不会叠加消耗。
   */
  async chatJson<T>(messages: ChatMessage[], options: ChatOptions = {}): Promise<T> {
    const first = await this.chat(messages, options);
    try {
      return parseJsonLoose<T>(first);
    } catch (error) {
      logger.warn(`[LLM][JSON 解析失败] 首次返回无法解析，追加纠正提示再试一次：${describeError(error)}`);
    }

    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: truncate(first, 1200) },
      {
        role: 'user',
        content: '上面的回复不是合法 JSON。请只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。',
      },
    ];

    try {
      const second = await this.chat(retryMessages, options);
      return parseJsonLoose<T>(second);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(`[LLM][JSON 解析失败] 纠正后仍然无法解析：${describeError(error)}`, {
        kind: 'parse',
        retryable: false,
      });
    }
  }

  /** Settings 里的「测试连接」。 */
  async testConnection(): Promise<string> {
    const reply = await this.chat(
      [
        {
          role: 'system',
          content: '你是一个连通性测试端点，只回复「可用」两个字。',
        },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 16, temperature: 0, timeoutMs: 20_000, maxAttempts: 2 },
    );
    return reply.trim();
  }
}

function extractContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  // 少数服务返回 content 数组（多段文本），做最小兼容
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
      .join('');
  }
  return '';
}
