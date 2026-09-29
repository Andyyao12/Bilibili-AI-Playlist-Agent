import type {
  Candidate,
  ContentGranularity,
  Intent,
  IntentItem,
  MediaType,
  ScoredCandidate,
  SelectionSource,
} from '../types';
import { describeError, logger } from '../utils/logger';
import { extractBvId, normalizeTitle, parseDuration } from '../utils/text';
import { LlmError, describeLlmFailure, type LlmClient } from './llm';

/* ------------------------------------------------------------------ */
/* 媒体规则档案                                                        */
/*                                                                     */
/* 必须按媒体类型分开：音乐场景要避开「教学」，但教程场景里「教学」    */
/* 恰恰就是目标；演讲/纪录片本来就长，不能按时长判定合集。             */
/* ------------------------------------------------------------------ */

interface MediaRuleProfile {
  /** 与 intent.avoid 合并的硬负向词 */
  negative: string[];
  /** 标题里明确的合集 / 歌单 / 系列特征词 —— 单曲模式下直接判不合格 */
  collectionSignals: string[];
  /** 疑似合集但不致命，只降权 */
  softCollectionSignals: string[];
  /** 正常内容的最短时长（秒） */
  minSeconds: number;
  /** 短于此视为片段，重罚（秒） */
  clipSeconds: number;
  /**
   * 超过这个时长只降权、不剔除（秒），null 表示不看时长。
   * 刻意不做成硬判据：一段 40 分钟的轻音乐/钢琴曲本身就是合理的"一个播放单位"，
   * 而且合集特征按规范应该以**标题**为准。
   */
  longSeconds: number | null;
}

const MEDIA_RULES: Record<MediaType, MediaRuleProfile> = {
  music: {
    negative: ['教程', '教学', 'reaction', '解析', '讲解', '伴奏教学', '吉他教学', '钢琴教学', '一分钟了解'],
    collectionSignals: ['合集', '歌单', '串烧', '精选集', '全收录', '合辑', '全集', '连播', '马拉松', '音乐集', '全mv'],
    softCollectionSignals: ['专辑', '盘点', '排行', '多版本', '各个版本', '专场', '联唱'],
    minSeconds: 90,
    clipSeconds: 60,
    longSeconds: 900,
  },
  speech: {
    negative: ['reaction', '鬼畜', '恶搞', '混剪', '吐槽'],
    collectionSignals: ['合集', '合辑', '全集', '连播', '系列'],
    softCollectionSignals: ['盘点', '排行', '片段'],
    minSeconds: 300,
    clipSeconds: 120,
    // 演讲本来就长，不看时长
    longSeconds: null,
  },
  tutorial: {
    // 教程场景下「教学 / 教程」正是目标，绝不能当负向词
    negative: ['reaction', '带货', '广告'],
    // 「全套 / 合集」是教程的正常形态，不做粒度约束
    collectionSignals: [],
    softCollectionSignals: [],
    minSeconds: 180,
    clipSeconds: 60,
    longSeconds: null,
  },
  documentary: {
    negative: ['reaction', '片段'],
    collectionSignals: ['合集', '全集', '系列'],
    softCollectionSignals: ['盘点'],
    minSeconds: 300,
    clipSeconds: 120,
    longSeconds: null,
  },
  movie: {
    negative: ['reaction'],
    collectionSignals: ['合集', '全集'],
    softCollectionSignals: ['盘点'],
    minSeconds: 120,
    clipSeconds: 60,
    longSeconds: null,
  },
  general_video: {
    negative: ['reaction'],
    collectionSignals: [],
    softCollectionSignals: [],
    minSeconds: 0,
    clipSeconds: 0,
    longSeconds: null,
  },
};

/**
 * 标题里不依赖词表的合集特征：100首 / 600集 / Top10 / 第3季。
 * 刻意不包含"N小时"：那段长音频可能只是单个长作品，靠标题里的「合集/歌单」等词判断更准。
 */
const COLLECTION_PATTERNS: RegExp[] = [
  /\d+\s*首/,
  /\d+\s*集/,
  /\d+\s*连播/,
  /top\s*\d+/i,
  /第\s*\d+\s*[季弹期辑]/,
];

/** 常见分辨率，用于把「1080P」这类画质标记和「200P」这类分P标记区分开。 */
const VIDEO_RESOLUTIONS = new Set(['240', '360', '480', '540', '720', '1080', '1440', '2160', '4320']);

/** 分P 合集：200P / 12P。排除分辨率写法。 */
function partsSignal(title: string): string | null {
  const matched = title.match(/(\d{2,4})\s*[pP](?![a-zA-Z0-9])/);
  if (!matched) return null;
  if (VIDEO_RESOLUTIONS.has(matched[1])) return null;
  return `${matched[1]}P`;
}

/**
 * 泛化词：只说明媒体形态，不携带任何主题信息。
 * 一个词把这些都剥掉后如果还剩内容，才算「具体词」——只有具体词才能用来判断候选是否切题。
 * 这一步是防止「Blender 零基础入门教程」混进「Python 教程」这类跨领域误召回的关键。
 */
const GENERIC_TERMS = [
  '视频',
  '影片',
  '合集',
  '歌单',
  '串烧',
  '精选集',
  '精选',
  '推荐',
  '好听',
  '动听',
  '完整版',
  '完整',
  '高清',
  '超清',
  '无损',
  '中文字幕',
  '字幕',
  '教程',
  '教学',
  '演讲',
  '歌曲',
  '音乐',
  '歌手',
  '唱歌',
  '演唱',
  '入门',
  '新手',
  '基础',
  '全套',
  '实用',
  '经典',
  '热门',
  '流行',
  '系列',
  'b站',
  '哔哩哔哩',
  '抖音',
  '类似',
  '风格',
  '那种',
  '类型',
  '1080p',
  'live',
  'mv',
  'hd',
  '集',
  '首',
  '歌',
  '的',
];

const MEDIA_LABEL: Record<MediaType, string> = {
  music: '歌曲',
  speech: '演讲',
  tutorial: '教程',
  documentary: '纪录片',
  movie: '电影',
  general_video: '视频',
};

/** 这些形态只有在用户明确要求时才优先，否则轻微降权（不一概排除）。 */
const DECORATION_TERMS = ['翻唱', 'cover', '伴奏', '混剪', 'dj', 'remix'];

/** 打分权重集中在此，便于以后调参。 */
const SCORE = {
  negativeHit: -100,
  exactTitleMatch: 50,
  titleMismatch: -25,
  artistMatch: 15,
  creatorMatch: 30,
  termMatch: 15,
  maxTermMatches: 3,
  completeVersion: 20,
  collectionWhenWanted: 10,
  softCollection: -20,
  longDuration: -25,
  desiredDecoration: 12,
  undesiredDecoration: -12,
  hasAuthor: 5,
  hasViews: 2,
};

export function mediaLabel(mediaType: MediaType): string {
  return MEDIA_LABEL[mediaType] ?? '视频';
}

export function collectNegativeKeywords(intent: Intent): string[] {
  const merged = [...(MEDIA_RULES[intent.media_type]?.negative ?? []), ...intent.avoid];
  const unique = new Set<string>();
  for (const keyword of merged) {
    const clean = keyword.trim().toLowerCase();
    if (clean.length > 0) unique.add(clean);
  }
  return [...unique];
}

/* ------------------------------------------------------------------ */
/* 匹配上下文                                                          */
/* ------------------------------------------------------------------ */

export interface MatchContext {
  /** 明确作品模式下的目标标题 */
  title?: string | null;
  artist?: string | null;
  /** 作者权重最高（用户说"周杰伦的歌"时，标题含周杰伦最可信） */
  creator?: string | null;
  /** 用于打分的词 */
  terms?: string[];
}

/** 明确作品模式：必须像这个作品。 */
export function matchContextForItem(item: IntentItem, intent: Intent): MatchContext {
  return {
    title: item.title,
    artist: item.artist,
    creator: intent.creator || null,
    terms: intent.preferred,
  };
}

/**
 * 发现式搜索：按作者 + 风格/关键词加权。
 * 刻意不把 topic 放进 terms —— topic 常是「类似送别的歌曲」这种描述性短语，
 * 拿它做切题判断会把正常候选全部误杀。
 */
export function matchContextForDiscovery(intent: Intent): MatchContext {
  return {
    title: null,
    artist: null,
    creator: intent.creator || null,
    terms: [...intent.style, ...intent.keywords, ...intent.preferred].filter((term) => term.length > 0),
  };
}

/** 剥掉泛化词后还有内容，才算携带主题信息的具体词。 */
export function isSpecificTerm(term: string): boolean {
  const lower = term.toLowerCase().replace(/[\s\u3000]+/g, '');
  if (lower.length === 0) return false;
  let rest = lower;
  for (const generic of GENERIC_TERMS) {
    rest = rest.split(generic).join('');
  }
  return rest.length >= 1;
}

export function specificTermsOf(context: MatchContext): string[] {
  const terms = context.terms ?? [];
  const specific = terms.filter(isSpecificTerm);
  return [...new Set(specific)];
}

/**
 * 强证据词：作者、以及长度 >= 3 的具体词（例如 轻音乐 / 斯坦福 / Python）。
 * 2 字词（安静 / 离别 / 古风）太容易在无关作品名里出现，只算弱证据。
 */
export function strongTermsOf(context: MatchContext, specificTerms: string[]): string[] {
  if (context.creator && isSpecificTerm(context.creator)) return [context.creator, ...specificTerms.filter((t) => t.length >= 3)];
  return specificTerms.filter((term) => term.length >= 3);
}

/**
 * 候选是否切题。
 * - 有强证据词时：必须命中强证据词（防止《安静以后》靠"安静"两字混进睡前轻音乐）
 * - 只有弱证据词时：命中任意一个即可（"类似《送别》"这种风格检索需要放宽）
 * - 完全没有具体词时：不限制，避免过度过滤
 */
export function isTopicRelevant(title: string, specificTerms: string[], strongTerms: string[] = []): boolean {
  if (specificTerms.length === 0) return true;
  const normalized = normalizeTitle(title);
  const matches = (terms: string[]) => terms.some((term) => normalized.includes(normalizeTitle(term)));

  if (strongTerms.length > 0) return matches(strongTerms);
  return matches(specificTerms);
}

/* ------------------------------------------------------------------ */
/* 同作品版本识别                                                      */
/* ------------------------------------------------------------------ */

/** 标题里的装饰性噪声，去掉后才好判断"是不是同一个作品的不同版本"。 */
const WORK_KEY_NOISE =
  /(mv|live|现场|官方|高清|超清|无损|完整版|完整|纯享|臻享|字幕|中文字幕|中文|英文|翻唱|cover|伴奏|remix|remaster|正式版|原版|正版|重置版|重制版|修复版|重新|音频|高音质|音质|动态|歌词|铃音|铃声|dj|串烧|版|hd|4k|1080p|720p|60fps|超品)/gi;

/**
 * 提取"作品指纹"：去掉括号内容与版本噪声后归一化的标题。
 * 用于识别同一首歌的多个上传版本（BV 去重之外的补充）。
 * 注意：只做等值 / 长前缀匹配，不做顺序无关匹配，避免把不同歌曲误合。
 */
export function workKey(title: string): string {
  const stripped = title
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, ' ')
    .replace(/[《》「」『』]/g, ' ')
    .replace(WORK_KEY_NOISE, ' ');
  return normalizeTitle(stripped);
}

function isSameWork(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  // 只有足够长的指纹才允许前缀合并，避免把短歌名误判成同一作品
  return short.length >= 8 && long.includes(short);
}

/* ------------------------------------------------------------------ */
/* 打分与过滤                                                          */
/* ------------------------------------------------------------------ */

export interface FilterOptions {
  limit?: number;
  /**
   * 找不到合格候选时允许退让到哪一层：
   *  - none       只接受「无负向词 + 切题 + 粒度匹配」，宁可队列短
   *  - collection 再找不到才允许退让到合集（但仍要求切题）
   *  - any        逐层退让，直到有候选（点名了具体作品时必须这样，否则会死锁）
   */
  fallback?: 'none' | 'collection' | 'any';
}

/** 单次批量发给 LLM 的候选上限，控制 token 与延迟。 */
const DEFAULT_RANK_BATCH_SIZE = 8;

/** 基础去重：同一 BV 号只保留一次；同标题同 UP 主视为重复。 */
export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seenBv = new Set<string>();
  const seenTitleAuthor = new Set<string>();
  const result: Candidate[] = [];

  for (const candidate of candidates) {
    const bvId = extractBvId(candidate.url);
    if (!bvId || seenBv.has(bvId)) continue;
    seenBv.add(bvId);

    const signature = `${normalizeTitle(candidate.title)}::${normalizeTitle(candidate.author ?? '')}`;
    if (seenTitleAuthor.has(signature)) continue;
    seenTitleAuthor.add(signature);

    result.push(candidate);
  }

  return result;
}

/** 标题里的合集特征。只依据标题，不看时长。 */
function collectionSignalHits(title: string, profile: MediaRuleProfile): string[] {
  if (profile.collectionSignals.length === 0) return [];

  const lower = title.toLowerCase();
  const hits: string[] = [];

  for (const signal of profile.collectionSignals) {
    if (lower.includes(signal.toLowerCase())) hits.push(signal);
  }
  for (const pattern of COLLECTION_PATTERNS) {
    const matched = title.match(pattern);
    if (matched) hits.push(matched[0].replace(/\s+/g, ''));
  }
  const parts = partsSignal(title);
  if (parts) hits.push(parts);

  return [...new Set(hits)];
}

/** 供自测与调试使用：判断一个标题是否带有合集特征。 */
export function detectCollectionSignals(title: string, mediaType: MediaType): string[] {
  const profile = MEDIA_RULES[mediaType] ?? MEDIA_RULES.general_video;
  return collectionSignalHits(title, profile);
}

function decorateBalance(title: string, desired: Set<string>): number {
  const lower = title.toLowerCase();
  let balance = 0;
  for (const decoration of DECORATION_TERMS) {
    if (!lower.includes(decoration)) continue;
    balance += desired.has(decoration) ? SCORE.desiredDecoration : SCORE.undesiredDecoration;
  }
  return balance;
}

/** 用户是否明确要了这些形态（翻唱 / 伴奏 / 混剪…）。 */
function desiredDecorations(intent: Intent): Set<string> {
  const haystack = [...intent.style, ...intent.keywords, ...intent.preferred, intent.topic]
    .join(' ')
    .toLowerCase();
  const desired = new Set<string>();
  for (const decoration of DECORATION_TERMS) {
    if (haystack.includes(decoration)) desired.add(decoration);
  }
  return desired;
}

interface RuleScore {
  score: number;
  negativeHits: string[];
  collectionHits: string[];
}

export function scoreCandidate(
  candidate: Candidate,
  context: MatchContext,
  intent: Intent,
  desired: Set<string>,
): RuleScore {
  const profile = MEDIA_RULES[intent.media_type] ?? MEDIA_RULES.general_video;
  const title = normalizeTitle(candidate.title);
  const durationSeconds = parseDuration(candidate.duration);
  let score = 0;

  const negativeHits: string[] = [];
  for (const keyword of collectNegativeKeywords(intent)) {
    if (title.includes(normalizeTitle(keyword))) {
      score += SCORE.negativeHit;
      negativeHits.push(keyword);
    }
  }

  const collectionHits = collectionSignalHits(candidate.title, profile);

  const target = normalizeTitle(context.title ?? '');
  if (target.length > 0) {
    score += title.includes(target) ? SCORE.exactTitleMatch : SCORE.titleMismatch;
  }

  const artist = normalizeTitle(context.artist ?? '');
  if (artist.length > 0 && title.includes(artist)) score += SCORE.artistMatch;

  const creator = normalizeTitle(context.creator ?? '');
  if (creator.length > 0 && title.includes(creator)) score += SCORE.creatorMatch;

  const terms = (context.terms ?? []).map((term) => normalizeTitle(term)).filter((term) => term.length > 0);
  const matched = terms.filter((term) => title.includes(term)).length;
  score += Math.min(matched, SCORE.maxTermMatches) * SCORE.termMatch;

  score += decorateBalance(candidate.title, desired);

  if (title.includes('完整')) score += SCORE.completeVersion;

  // 粒度：用户要合集时合集是加分项；用户要单曲时合集在准入阶段就被拦掉
  if (intent.granularity === 'collection' && collectionHits.length > 0) {
    score += SCORE.collectionWhenWanted;
  }
  const lowerTitle = candidate.title.toLowerCase();
  if (profile.softCollectionSignals.some((signal) => lowerTitle.includes(signal.toLowerCase()))) {
    score += SCORE.softCollection;
  }

  if (durationSeconds !== null) {
    if (durationSeconds < profile.clipSeconds) score -= 30;
    else if (durationSeconds >= profile.minSeconds) score += 10;
    // 长视频只降权不定罪：真正的合集特征看标题
    if (profile.longSeconds !== null && durationSeconds >= profile.longSeconds) score += SCORE.longDuration;
  }

  if (candidate.author) score += SCORE.hasAuthor;
  if (candidate.views) score += SCORE.hasViews;

  return { score, negativeHits, collectionHits };
}

/** 内部使用：在 ScoredCandidate 之外额外携带准入判定结果。 */
interface InternalScored extends ScoredCandidate {
  negativeHits: string[];
  collectionHits: string[];
  topicOk: boolean;
  granularityOk: boolean;
}

/**
 * 规则准入 + 打分 + 截断。LLM 之前必须先跑这一步：
 * 明显跑题 / 明显不匹配内容粒度的候选，绝不交给 LLM 去"选"。
 */
export function filterCandidates(
  candidates: Candidate[],
  context: MatchContext,
  intent: Intent,
  options: FilterOptions = {},
): ScoredCandidate[] {
  const limit = options.limit ?? DEFAULT_RANK_BATCH_SIZE;
  const fallback = options.fallback ?? 'any';
  const desired = desiredDecorations(intent);
  const specificTerms = specificTermsOf(context);
  const strongTerms = strongTermsOf(context, specificTerms);
  const wantsSingle = intent.granularity !== 'collection';

  const unique = dedupeCandidates(candidates);
  const entries: InternalScored[] = unique.map((candidate, index) => {
    const { score, negativeHits, collectionHits } = scoreCandidate(candidate, context, intent, desired);
    const durationSeconds = parseDuration(candidate.duration);
    // 粒度准入只看标题里的合集特征
    const granularityOk = !wantsSingle || collectionHits.length === 0;
    return {
      title: candidate.title,
      url: candidate.url,
      author: candidate.author,
      duration: candidate.duration,
      views: candidate.views,
      description: candidate.description,
      durationSeconds,
      ruleScore: score,
      negativeHits,
      collectionHits,
      topicOk: isTopicRelevant(candidate.title, specificTerms, strongTerms),
      granularityOk,
      rank: index + 1,
    };
  });

  const byScore = (a: InternalScored, b: InternalScored) =>
    b.ruleScore !== a.ruleScore ? b.ruleScore - a.ruleScore : (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);

  const noNegative = entries.filter((entry) => entry.negativeHits.length === 0);

  // 硬性要求：没有命中负向词 + 粒度匹配（单曲模式下排除标题带合集特征的）
  const tierStrict = noNegative.filter((entry) => entry.topicOk && entry.granularityOk).sort(byScore);
  const tierGranularity = noNegative.filter((entry) => entry.granularityOk).sort(byScore);
  // 放宽粒度、但要求切题
  const tierTopic = noNegative.filter((entry) => entry.topicOk).sort(byScore);
  const tierLoose = [...noNegative].sort(byScore);

  /*
   * 主题相关性只是「优先层」，不是硬门槛。
   *
   * 原因：切题判断靠字面包含，而用户给的往往是情绪/体裁词（轻音乐、助眠、安静）。
   * 真实数据显示「睡前 轻音乐 安静」的搜索结果里绝大多数是"睡眠音乐/白噪音/钢琴曲"，
   * 它们明显切题却一个字都不含"轻音乐"。硬拦会把这些内容全部误杀。
   * 所以：严格层够多（>=2）就用严格层；否则放宽主题要求，但**粒度与负向词绝不放宽**。
   */
  const MIN_STRICT_POOL = 2;
  let pool: InternalScored[];
  let tierName: string;

  if (tierStrict.length >= MIN_STRICT_POOL) {
    pool = tierStrict;
    tierName = '严格层（切题+粒度）';
  } else if (tierGranularity.length > 0) {
    pool = tierGranularity;
    tierName = '放宽主题（保留粒度与负向词）';
    if (tierStrict.length > 0) {
      logger.warn(
        `切题候选只有 ${tierStrict.length} 条，主题词可能是情绪/体裁词（${(context.terms ?? []).join('、')}），已放宽主题要求`,
      );
    }
  } else if (fallback === 'none') {
    logger.warn(
      `准入拦截：${candidates.length} 条候选里没有粒度匹配的内容（媒体类型 ${intent.media_type}，粒度 ${intent.granularity}）`,
    );
    return [];
  } else if (tierTopic.length > 0) {
    pool = tierTopic;
    tierName = '放宽粒度（保留切题与负向词）';
  } else if (fallback === 'any') {
    pool = tierLoose;
    tierName = '最宽层（仅排除负向词）';
  } else {
    logger.warn(`准入后没有可用候选（原始 ${candidates.length} 条）`);
    return [];
  }

  if (pool.length === 0) {
    logger.warn(`准入后没有可用候选（原始 ${candidates.length} 条）`);
    return [];
  }

  // 同作品多版本收敛：只保留分数最高的那一个
  const kept: InternalScored[] = [];
  const seenKeys: string[] = [];
  for (const entry of pool) {
    const key = workKey(entry.title);
    if (key.length >= 3 && seenKeys.some((existing) => isSameWork(existing, key))) continue;
    if (key.length >= 3) seenKeys.push(key);
    kept.push(entry);
    if (kept.length >= limit) break;
  }

  logger.info(
    `准入与打分：原始 ${candidates.length} -> 去重 ${unique.length} -> 严格合格 ${tierStrict.length} -> 送审 ${kept.length}` +
      `（粒度 ${intent.granularity}，采用${tierName}${strongTerms.length > 0 ? `，强证据词 ${strongTerms.join('/')}` : ''}）`,
  );

  return kept.map((entry, index) => ({
    title: entry.title,
    url: entry.url,
    author: entry.author,
    duration: entry.duration,
    views: entry.views,
    description: entry.description,
    durationSeconds: entry.durationSeconds,
    ruleScore: entry.ruleScore,
    rank: index + 1,
  }));
}

/* ------------------------------------------------------------------ */
/* 交给 LLM 的排序请求                                                 */
/* ------------------------------------------------------------------ */

export interface RankRequest {
  summary: string;
  prefer: string[];
  avoid: string[];
  limit: number;
  /** 内容粒度，写进 Prompt 让模型也知道不要选合集 */
  granularity: ContentGranularity;
  mediaType: MediaType;
}

export interface RankSelection {
  candidate: Candidate;
  score: number | null;
  reason: string;
}

export interface RankOutcome {
  selections: RankSelection[];
  /** llm = 模型选片；fallback = 已降级为本地规则排序 */
  source: SelectionSource;
  note: string;
}

/** 明确作品模式：只选 1 个最匹配的。 */
export function rankRequestForItem(item: IntentItem, intent: Intent): RankRequest {
  const prefer = [...intent.preferred, ...intent.style.map((style) => `风格：${style}`), '适合连续播放，不要片段'];
  return {
    summary: `${mediaLabel(intent.media_type)}：${item.title}${item.artist ? ` - ${item.artist}` : ''}`,
    prefer,
    avoid: intent.avoid,
    limit: 1,
    granularity: intent.granularity,
    mediaType: intent.media_type,
  };
}

/** 发现式搜索：一次选出最多 limit 个，用来直接搭出播放队列。 */
export function rankRequestForDiscovery(intent: Intent, userPrompt: string, limit: number): RankRequest {
  const prefer: string[] = [];
  if (intent.creator) prefer.push(`优先 ${intent.creator} 本人的内容`);
  prefer.push(...intent.style.map((style) => `风格：${style}`));
  prefer.push(...intent.keywords);
  prefer.push(...intent.preferred);
  if (prefer.length === 0) prefer.push('内容完整、适合连续播放');

  const avoid = [...intent.avoid];
  if (intent.granularity === 'single') {
    avoid.push('多个作品拼在一起的合集', '歌单', '串烧', 'N 首精选', '整张专辑连播');
  }

  return {
    summary: userPrompt.trim().length > 0 ? userPrompt.trim() : intent.topic,
    prefer: [...new Set(prefer)],
    avoid: [...new Set(avoid)],
    limit,
    granularity: intent.granularity,
    mediaType: intent.media_type,
  };
}

const RANK_SYSTEM_PROMPT =
  '你是 Bilibili 内容挑选助手。你只能从用户给出的候选中选择编号，不能发明新的视频、标题或链接。只输出 JSON。';

function buildRankingPrompt(scored: ScoredCandidate[], request: RankRequest): string {
  const candidateLines = scored
    .map((entry) => {
      const parts = [
        `${entry.rank}. 标题：${entry.title}`,
        `UP主：${entry.author ?? '未知'}`,
        `时长：${entry.duration ?? '未知'}`,
      ];
      if (entry.views) parts.push(`播放：${entry.views}`);
      return parts.join(' | ');
    })
    .join('\n');

  const granularityLine =
    request.granularity === 'collection'
      ? '用户想要合集 / 歌单形态，合集是合适的。'
      : `用户想要的是**单个作品**（单曲 / 单个视频），不是多个作品拼在一起的合集。`;

  return `用户需求：
${request.summary}

${granularityLine}

请从下面 Bilibili 搜索结果中选出最符合用户需求的内容。

优先：
${request.prefer.join('\n')}

降低：
${request.avoid.length > 0 ? request.avoid.join('\n') : '与主题无关的内容'}

候选：
${candidateLines}

请最多选择 ${request.limit} 个，按优先级从高到低排列。

只返回 JSON：
{"selected":[{"index":1,"score":95}]}

要求：
1. index 必须是上面候选列表里的编号，绝不臆造不存在的编号，也不要编造 BV 号。
2. 最多选 ${request.limit} 个。**宁缺毋滥**：如果剩下的候选明显不切题，就少选几个，返回空数组也可以。
3. 不要输出任何解释、markdown 或代码围栏。`;
}

/**
 * 单次批量排序：把候选一次性交给 LLM，绝不逐条调用。
 * 返回的 URL 一定来自真实搜索结果（DOM 提取），模型只能给编号。
 */
export async function rankCandidates(
  client: LlmClient,
  scored: ScoredCandidate[],
  request: RankRequest,
): Promise<RankOutcome> {
  const limit = Math.max(1, request.limit);
  const fallbackSelections = scored.slice(0, limit).map((entry) => ({
    candidate: entry,
    score: null,
    reason: '本地规则排序',
  }));

  if (scored.length === 0) {
    return { selections: [], source: 'fallback', note: '没有可排序的候选' };
  }

  if (scored.length === 1) {
    return {
      selections: [fallbackSelections[0]],
      source: 'fallback',
      note: '只有一个候选，直接使用',
    };
  }

  let raw: unknown;
  try {
    raw = await client.chatJson<unknown>(
      [
        { role: 'system', content: RANK_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildRankingPrompt(scored, { ...request, limit: Math.min(limit, scored.length) }),
        },
      ],
      { jsonMode: true, temperature: 0.1, maxTokens: 400 },
    );
  } catch (error) {
    const detail = error instanceof LlmError ? describeLlmFailure(error) : describeError(error);
    logger.warn(`${detail} -> 降级为本地规则排序`);
    return {
      selections: fallbackSelections,
      source: 'fallback',
      note: 'LLM 排序失败，已降级为本地规则排序',
    };
  }

  const picked = parseRankResult(raw, scored, limit);

  // null = 返回格式完全不合法（可按失败处理并降级）
  if (picked === null) {
    logger.warn('[LLM][返回格式非法] 没有 selected 字段或编号全部非法，降级为本地规则排序');
    return {
      selections: fallbackSelections,
      source: 'fallback',
      note: 'LLM 返回格式非法，已降级为本地规则排序',
    };
  }

  // 空数组 = 模型明确表示"这些候选都不合适"。必须尊重它，绝不能强行补位，
  // 否则就违背了"允许队列短于 target_count、不补入不相关内容"的约定。
  if (picked.length === 0) {
    logger.warn('[LLM][模型主动返回空选择] 本轮不选入任何内容（不降级、不补位）');
    return {
      selections: [],
      source: 'llm',
      note: '模型主动返回空选择，本轮不选入内容（队列允许短于目标数量）',
    };
  }

  return {
    selections: picked.map((entry) => ({
      candidate: scored[entry.index - 1],
      score: entry.score,
      reason: entry.reason,
    })),
    source: 'llm',
    note: `LLM 选中 ${picked.length} 个候选`,
  };
}

interface ParsedSelection {
  index: number;
  score: number | null;
  reason: string;
}

/**
 * 解析排序结果并做基础有效性校验：
 * 编号必须是整数、必须落在真实候选范围内、不允许重复。
 * 主格式是 {"selected":[{"index":1,"score":95}]}，
 * 同时容忍裸数字数组与旧版单选格式，避免模型不按格式输出就整条链路失败。
 *
 * 返回值语义区分两种"空"：
 *   null -> 返回格式完全不合法，调用方应降级
 *   []   -> 格式合法但模型一个都没选，调用方应当尊重
 */
function parseRankResult(raw: unknown, scored: ScoredCandidate[], limit: number): ParsedSelection[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const hasList = Array.isArray(record.selected);
  const hasLegacy = typeof record.selected_index === 'number' || typeof record.selected_index === 'string';
  if (!hasList && !hasLegacy) return null;

  const out: ParsedSelection[] = [];
  const seen = new Set<number>();

  const push = (value: unknown, score: unknown, reason: unknown) => {
    const index =
      typeof value === 'number'
        ? Math.trunc(value)
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number.parseInt(value.trim(), 10)
          : Number.NaN;
    if (!Number.isFinite(index) || index < 1 || index > scored.length) return;
    if (seen.has(index)) return;
    seen.add(index);
    out.push({
      index,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'LLM 选片',
    });
  };

  if (hasList) {
    for (const entry of record.selected as unknown[]) {
      if (typeof entry === 'number' || typeof entry === 'string') {
        push(entry, null, null);
        continue;
      }
      if (typeof entry === 'object' && entry !== null) {
        const item = entry as Record<string, unknown>;
        push(item.index ?? item.selected_index, item.score, item.reason);
      }
    }
  } else {
    push(record.selected_index, record.score, record.reason);
  }

  return out.slice(0, limit);
}
