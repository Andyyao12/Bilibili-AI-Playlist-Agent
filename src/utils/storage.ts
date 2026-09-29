import type { AgentSnapshot, LlmConfig } from '../types';
import { logger, registerSecret } from './logger';

const SETTINGS_KEY = 'bapa:settings';
const SNAPSHOT_KEY = 'bapa:snapshot';
const CACHE_KEY = 'bapa:searchCache';

/** 搜索缓存有效期与容量上限，够用即可，不做复杂缓存系统。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  url: string;
  title: string;
  ts: number;
}

type CacheMap = Record<string, CacheEntry>;

// 同 logger：先取出 import.meta.env 再取字段，便于 Vite 静态替换且不依赖运行环境。
const buildEnv: Record<string, string | undefined> = import.meta.env ?? {};

export const DEFAULT_SETTINGS: LlmConfig = {
  baseUrl: buildEnv.VITE_DEFAULT_LLM_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: '',
  model: buildEnv.VITE_DEFAULT_LLM_MODEL ?? 'gpt-4o-mini',
  temperature: 0.3,
  maxTokens: 800,
};

/* ------------------------------------------------------------------ */
/* 写入串行化：避免并发 read-modify-write 互相覆盖                      */
/* ------------------------------------------------------------------ */

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/* 用户设置：chrome.storage.local                                       */
/* ------------------------------------------------------------------ */

export async function getSettings(): Promise<LlmConfig> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<LlmConfig> | undefined;
  const merged: LlmConfig = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  registerSecret(merged.apiKey);
  return merged;
}

export async function saveSettings(config: LlmConfig): Promise<void> {
  const normalized: LlmConfig = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    temperature: Number.isFinite(config.temperature) ? config.temperature : DEFAULT_SETTINGS.temperature,
    maxTokens: Number.isFinite(config.maxTokens) ? Math.max(64, Math.floor(config.maxTokens)) : DEFAULT_SETTINGS.maxTokens,
  };
  registerSecret(normalized.apiKey);
  await serialize(() => chrome.storage.local.set({ [SETTINGS_KEY]: normalized }));
  logger.info(`设置已保存: baseUrl=${normalized.baseUrl} model=${normalized.model}`); // 注意：不含 apiKey
}

/* ------------------------------------------------------------------ */
/* Agent 快照：chrome.storage.session（SW 被回收后可恢复）              */
/* ------------------------------------------------------------------ */

export async function getSnapshot(): Promise<AgentSnapshot | null> {
  const stored = await chrome.storage.session.get(SNAPSHOT_KEY);
  return (stored[SNAPSHOT_KEY] as AgentSnapshot | undefined) ?? null;
}

export async function saveSnapshot(snapshot: AgentSnapshot): Promise<void> {
  await serialize(() => chrome.storage.session.set({ [SNAPSHOT_KEY]: snapshot }));
}

export async function clearSnapshot(): Promise<void> {
  await serialize(() => chrome.storage.session.remove(SNAPSHOT_KEY));
}

/* ------------------------------------------------------------------ */
/* 搜索缓存：chrome.storage.local，key = title|media_type              */
/* ------------------------------------------------------------------ */

export function cacheKey(title: string, mediaType: string): string {
  return `${title.trim()}|${mediaType}`;
}

async function readCache(): Promise<CacheMap> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return (stored[CACHE_KEY] as CacheMap | undefined) ?? {};
}

export async function getCachedVideo(key: string): Promise<string | null> {
  const cache = await readCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    await serialize(async () => {
      const fresh = await readCache();
      delete fresh[key];
      await chrome.storage.local.set({ [CACHE_KEY]: fresh });
    });
    return null;
  }
  return entry.url;
}

export async function setCachedVideo(key: string, url: string, title: string): Promise<void> {
  await serialize(async () => {
    const cache = await readCache();
    cache[key] = { url, title, ts: Date.now() };

    const entries = Object.entries(cache);
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      const trimmed: CacheMap = {};
      for (const [entryKey, entry] of entries.slice(0, CACHE_MAX_ENTRIES)) {
        trimmed[entryKey] = entry;
      }
      await chrome.storage.local.set({ [CACHE_KEY]: trimmed });
      return;
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  });
}
