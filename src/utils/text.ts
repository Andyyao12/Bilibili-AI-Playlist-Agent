import type { IntentItem, MediaType } from '../types';

/** 剥离 markdown 代码围栏，截出第一个看起来完整的 JSON 块。 */
export function cleanJsonText(raw: string): string {
  let text = raw.trim();

  // 去掉 ```json ... ``` / ``` ... ``` 围栏
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();

  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  let closeChar = '}';
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    start = firstBrace;
    closeChar = '}';
  } else if (firstBracket >= 0) {
    start = firstBracket;
    closeChar = ']';
  }

  if (start < 0) return text;

  const end = text.lastIndexOf(closeChar);
  if (end <= start) return text.slice(start);
  return text.slice(start, end + 1);
}

/**
 * 宽松 JSON 解析。只做最小清理（去围栏、截块、修尾逗号），不做复杂 parser。
 * 失败时抛出带片段的可读错误，供上层提示 LLM 重试。
 */
export function parseJsonLoose<T>(raw: string): T {
  const cleaned = cleanJsonText(raw).replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    const preview = cleaned.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : '未知错误'} | 片段: ${preview}`);
  }
}

/** "03:24" -> 204，"1:02:33" -> 3753，"--:--" / 空 -> null。 */
export function parseDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const text = input.trim();
  if (!/\d/.test(text)) return null;

  const parts = text.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;

  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => Number.isNaN(value) || value < 0)) return null;

  return numbers.reduce((total, value) => total * 60 + value, 0);
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * 标题归一化：只保留中日韩文字与字母数字。
 * 用于去重和对"标题是否包含目标歌名"的判断，避免《偶然》、偶然、【偶然】被判成三个东西。
 */
export function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]/gu, '');
}

/** 把任意形态的视频链接归一化为 https://www.bilibili.com/video/BVxxx，非法返回 null。 */
export function normalizeVideoUrl(href: string | null | undefined): string | null {
  const bvId = extractBvId(href);
  return bvId ? `https://www.bilibili.com/video/${bvId}` : null;
}

/** 从任意链接/文本中抽取 BV 号。 */
export function extractBvId(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/video\/(BV[0-9A-Za-z]{8,14})/);
  if (match?.[1]) return match[1];
  const bare = href.match(/^\s*(BV[0-9A-Za-z]{8,14})\s*$/);
  return bare?.[1] ?? null;
}

const MEDIA_KEYWORD: Record<MediaType, string> = {
  music: '音乐',
  speech: '演讲',
  tutorial: '教程',
  documentary: '纪录片',
  movie: '电影',
  general_video: '',
};

/**
 * 本地生成搜索关键词，不调用 LLM。
 * attempt 1: 有 artist -> "偶然 蔡琴 完整版"；无 artist -> "偶然 歌曲 完整版"
 * attempt 2: "偶然 音乐"（兜底，放宽约束）
 */
export function buildSearchKeyword(
  item: IntentItem,
  mediaType: MediaType,
  preferred: string[],
  attempt: number,
): string {
  const title = item.title.trim();
  const artist = item.artist?.trim() ?? '';
  const parts: string[] = title ? [title] : [];
  if (artist) parts.push(artist);

  if (attempt <= 1) {
    if (mediaType === 'music' && !artist) parts.push('歌曲');
    const primary = preferred.map((entry) => entry.trim()).find((entry) => entry.length > 0);
    if (primary) parts.push(primary);
    return parts.join(' ');
  }

  const fallback = MEDIA_KEYWORD[mediaType];
  if (fallback) parts.push(fallback);
  return parts.join(' ');
}

export function buildSearchUrl(keyword: string): string {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

/** 把秒数格式化为"剩余 3 分 12 秒"这类可读文案。 */
export function humanizeSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}
