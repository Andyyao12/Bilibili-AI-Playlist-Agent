import type { ContentGranularity, Intent, IntentItem, IntentMode, MediaType } from '../types';
import { logger } from '../utils/logger';
import { LlmClient, type ChatMessage } from './llm';

const VALID_MEDIA_TYPES: MediaType[] = ['music', 'speech', 'tutorial', 'documentary', 'movie', 'general_video'];
const VALID_MODES: IntentMode[] = ['explicit_playlist', 'discovery', 'hybrid'];

/** 一次请求最多接受多少个条目，防止 LLM 输出失控。 */
const MAX_ITEMS = 30;
const MAX_SEARCH_QUERIES = 3;
const DEFAULT_TARGET_COUNT = 5;
const MAX_TARGET_COUNT = 10;

/** 本地兜底合成搜索词时用的媒体类型词。 */
const MEDIA_SEARCH_WORD: Record<MediaType, string> = {
  music: '歌曲',
  speech: '演讲',
  tutorial: '教程',
  documentary: '纪录片',
  movie: '电影',
  general_video: '',
};

/**
 * 解析提示词。
 *
 * 关键设计：**不要求用户提供具体作品名**。
 * 用户只给歌手、风格、主题、观看场景，甚至只给一个参考作品要求"找类似的"，
 * 都属于合法请求，都必须返回可执行的搜索计划。
 * 只有完全无法判断媒体目标时才允许返回 {"task":"unknown"}。
 */
export const INTENT_SYSTEM_PROMPT = `你是一个 Bilibili 媒体搜索与播放意图解析器。请把用户的自然语言转换成一份可直接执行的媒体播放计划。

用户不需要给出具体作品名称。以下输入全部合法：
- 播放《偶然》《再别康桥》
- 播放一些周杰伦的歌
- 找几首古风歌曲
- 播放适合睡前听的轻音乐
- 找一些类似《送别》的歌曲
- 播放乔布斯经典演讲
- 找几个 Python 入门教程
- 播放最近的 AI 相关新闻

判断 mode：
- explicit_playlist：用户明确列出了一个或多个作品名
- discovery：用户没有列出具体作品，但给出了歌手/作者、主题、风格或内容类型
- hybrid：用户给了一个参考作品，同时要求寻找类似内容

判断 granularity：
- single：用户要的是**一首一首播放**（"几首""一些""经典歌曲"等）。音乐类默认就是 single。
- collection：用户**明确**要合集/歌单/串烧/精选集/一次听完（例如"周杰伦歌曲合集""100首精选""歌单"）。

判断 play_reference（只有 hybrid 需要）：
- 用户说"播放类似《送别》的歌""像《送别》那种"→ play_reference = false。参考作品只用来推断风格，**不要播放它本身**。
- 用户说"先播放《送别》，然后推荐类似的歌"→ play_reference = true。

只返回 JSON，不要任何解释、前言或 markdown 围栏：
{
  "task": "media_playlist",
  "mode": "explicit_playlist | discovery | hybrid",
  "media_type": "music | speech | tutorial | documentary | movie | general_video",
  "granularity": "single | collection",
  "play_reference": false,
  "items": [{ "title": "作品名", "artist": "演唱者或作者，未知则 null" }],
  "search_queries": ["可直接粘进 B 站搜索框的关键词"],
  "topic": "主题，例如 经典歌曲 / 古风离别",
  "creator": "歌手或作者名，没有则空字符串",
  "style": ["风格关键词"],
  "keywords": ["其它有助于检索的**具体**关键词，例如 Python、斯坦福、钢琴"],
  "preferred": ["用户偏好的形态，例如 完整版 / MV / 现场"],
  "avoid": ["用户希望规避的形态，例如 教学 / 解说 / 翻唱"],
  "auto_expand": false,
  "target_count": 5
}

规则：
1. 用户明确给出的作品放进 items，保持顺序；没有就留空数组，**这不算错误**。
2. 无论哪种模式，都要生成 1~3 条 search_queries。搜索词要短、不要标点、不要写成完整句子，必须能直接放进 B 站搜索框。
3. discovery 模式下 items 为空，但 search_queries 必须有内容。
4. hybrid 模式下 items 只放参考作品，search_queries 放"找同类内容"的检索词（例如"类似 送别 古风 离别 歌曲"）。
5. **keywords 一定要填具体的领域词**（人名、技术名、场合名），不要只写"歌曲/教程/演讲"这类泛化词。这些词会被用来判断候选是否切题。
6. target_count：用户说"一些/几首/几个"就用 5；用户明确数量就用该数量；上限 10。
7. auto_expand：用户表达"之后可以继续推荐/多来一些"时为 true。
8. 绝不编造 B 站链接、BV 号、UP 主或播放量。
9. 只有当完全无法判断用户想搜索或播放什么内容时，才返回：{"task":"unknown"}`;

export async function parseIntent(client: LlmClient, userPrompt: string): Promise<Intent> {
  const messages: ChatMessage[] = [
    { role: 'system', content: INTENT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const raw = await client.chatJson<unknown>(messages, { jsonMode: true, temperature: 0.2 });

  if (isRecord(raw) && raw.task === 'unknown') {
    throw new Error('没能理解你想搜索或播放的内容，请换一种说法。');
  }

  const intent = normalizeIntent(raw);
  const queries = synthesizeSearchQueries(intent);
  const resolved: Intent = { ...intent, search_queries: queries };

  // 只有在「既没有明确作品、本地也合成不出任何搜索词」时才拒绝
  if (resolved.items.length === 0 && resolved.search_queries.length === 0) {
    throw new Error('没能理解你想搜索或播放的内容，请换一种说法。');
  }

  logger.info(
    `意图解析完成：mode=${resolved.mode} media_type=${resolved.media_type} ` +
      `items=${resolved.items.length} queries=${resolved.search_queries.length} target=${resolved.target_count}`,
  );
  if (resolved.search_queries.length > 0) {
    logger.debug(`搜索词：${resolved.search_queries.join(' | ')}`);
  }

  return resolved;
}

/** 把 LLM 的任意输出收敛成合法 Intent，字段缺失一律用默认值兜底。 */
export function normalizeIntent(raw: unknown): Intent {
  const source = (isRecord(raw) && isRecord(raw.intent) ? raw.intent : raw) as Record<string, unknown>;
  if (!isRecord(source)) {
    throw new Error('意图解析结果不是 JSON 对象');
  }

  const mediaType = VALID_MEDIA_TYPES.includes(source.media_type as MediaType)
    ? (source.media_type as MediaType)
    : 'general_video';

  const items = normalizeItems(source.items);

  const mode = normalizeMode(source.mode, items);

  return {
    task: 'media_playlist',
    mode,
    media_type: mediaType,
    granularity: normalizeGranularity(source.granularity),
    // 只有 hybrid 才可能有"是否播放参考作品"的语义，其余模式一律 false
    play_reference: mode === 'hybrid' && source.play_reference === true,
    items,
    search_queries: normalizeSearchQueries(source.search_queries),
    topic: normalizeText(source.topic),
    creator: normalizeText(source.creator),
    style: normalizeStringList(source.style),
    keywords: normalizeStringList(source.keywords),
    preferred: normalizeStringList(source.preferred, defaultPreferred(mediaType)),
    avoid: normalizeStringList(source.avoid, defaultAvoid(mediaType)),
    auto_expand: source.auto_expand === true,
    target_count: normalizeTargetCount(source.target_count, items.length),
  };
}

/**
 * 本地兜底合成搜索词：LLM 没给 search_queries 时，用 topic / creator / style / items 拼出来。
 * 这样即使模型漏填字段，discovery 模式也依然能跑起来。
 */
export function synthesizeSearchQueries(intent: Intent): string[] {
  if (intent.search_queries.length > 0) return intent.search_queries;

  const mediaWord = MEDIA_SEARCH_WORD[intent.media_type];
  const styleWords = [...intent.style, ...intent.keywords].filter((word) => word.length > 0).slice(0, 3);
  const queries: string[] = [];

  if (intent.items.length > 0) {
    const first = intent.items[0];
    queries.push(joinWords([first.title, first.artist ?? '', mediaWord]));
    if (intent.auto_expand || intent.mode === 'hybrid') {
      queries.push(joinWords([first.title, ...styleWords]));
    }
  } else if (intent.creator.length > 0) {
    queries.push(joinWords([intent.creator, intent.topic || mediaWord]));
    if (styleWords.length > 0) queries.push(joinWords([intent.creator, ...styleWords.slice(0, 2)]));
  } else {
    const words = [intent.topic, ...styleWords, mediaWord];
    const composed = joinWords(words);
    if (composed.length > 0) queries.push(composed);
  }

  const unique = [...new Set(queries.map((query) => query.trim()).filter((query) => query.length > 0))];
  return unique.slice(0, MAX_SEARCH_QUERIES);
}

/* ------------------------------------------------------------------ */
/* 归一化辅助                                                          */
/* ------------------------------------------------------------------ */

function normalizeMode(raw: unknown, items: IntentItem[]): IntentMode {
  if (VALID_MODES.includes(raw as IntentMode)) return raw as IntentMode;
  // LLM 没给 mode 时按是否点名了作品来推断
  return items.length > 0 ? 'explicit_playlist' : 'discovery';
}

/** 粒度默认 single：宁可保守地按"一首一首"处理，也不要默认把合集灌进队列。 */
function normalizeGranularity(raw: unknown): ContentGranularity {
  return raw === 'collection' ? 'collection' : 'single';
}

function normalizeTargetCount(raw: unknown, itemCount: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(MAX_TARGET_COUNT, Math.max(1, Math.trunc(raw)));
  }
  // 明确清单模式下，清单长度就是目标数量
  return itemCount > 0 ? Math.min(MAX_TARGET_COUNT, itemCount) : DEFAULT_TARGET_COUNT;
}

function normalizeSearchQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const queries = raw
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .map((entry) => entry.replace(/[\s\u3000]+/g, ' ').trim())
    .filter((entry) => entry.length > 0 && entry.length <= 60);
  return [...new Set(queries)].slice(0, MAX_SEARCH_QUERIES);
}

function normalizeItems(raw: unknown): IntentItem[] {
  if (!Array.isArray(raw)) return [];
  const items: IntentItem[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    // 容忍 LLM 直接返回字符串数组
    const title = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.title ?? '') : '';
    const artist = isRecord(entry) && typeof entry.artist === 'string' ? entry.artist.trim() : '';
    const cleanTitle = title.trim();
    if (!cleanTitle) continue;

    const dedupeKey = `${cleanTitle}::${artist}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({ title: cleanTitle, artist: artist.length > 0 ? artist : null });
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

function normalizeStringList(raw: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const list = raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return list.length > 0 ? list.slice(0, 8) : [...fallback];
}

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function defaultPreferred(mediaType: MediaType): string[] {
  return mediaType === 'music' ? ['完整版', '歌曲'] : [];
}

function defaultAvoid(mediaType: MediaType): string[] {
  switch (mediaType) {
    case 'music':
      return ['教学', 'reaction', '解说'];
    case 'speech':
      return ['reaction', '解说'];
    case 'tutorial':
      // 教程场景下「教学」正是目标，不能当成负向词
      return ['reaction'];
    default:
      return [];
  }
}

function joinWords(words: string[]): string {
  return words
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
