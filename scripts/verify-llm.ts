/**
 * 真实模型验证脚本 —— 用**你自己配置的真实 LLM** 跑一遍 A–F 验收语句。
 *
 * 它和扩展内跑的完全是同一份代码：
 *   - 意图解析：src/services/intent.ts 的真实 Prompt 与归一化
 *   - 准入过滤：src/services/ranking.ts 的 filterCandidates
 *   - 候选排序：src/services/ranking.ts 的 rankCandidates（真实模型调用）
 *   - 网络层：src/services/llm.ts 的超时、有限重试与失败分类
 *   - 搜索结果：真实 search.bilibili.com
 *
 * 唯一的差异：这里没有浏览器 DOM，HTML→候选 用 Node 侧文本提取器。
 * 扩展内走的是 src/content/bilibili.ts 的真实 DOM 提取（已用真实 Chrome 验证）。
 *
 * 用法：
 *   npm run verify:llm -- --base-url https://api.openai.com/v1 --api-key sk-xxx --model gpt-4o-mini
 * 或（推荐，避免密钥留在命令历史里）：
 *   BAPA_BASE_URL / BAPA_API_KEY / BAPA_MODEL
 *
 * 单个用例失败不会中断后续用例，最后会打印 A–F 汇总表与失败分类统计。
 * 日志只包含地址、模型名、错误码与耗时，绝不打印 API Key / Authorization / 请求体。
 */
import { LlmClient, LlmError, FAILURE_LABEL } from '../src/services/llm';
import { parseIntent } from '../src/services/intent';
import {
  filterCandidates,
  matchContextForDiscovery,
  matchContextForItem,
  rankCandidates,
  rankRequestForDiscovery,
  rankRequestForItem,
} from '../src/services/ranking';
import { enableConsoleLogging } from '../src/utils/logger';
import { buildSearchKeyword, buildSearchUrl, normalizeVideoUrl } from '../src/utils/text';
import type { Candidate, Intent, LlmConfig } from '../src/types';

// Node 环境没有 Vite 的 DEV 标志，这里显式打开控制台日志，
// 这样重试告警与失败分类都会实时打印出来。
enableConsoleLogging();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SEARCH_LIMIT = 15;
const DISCOVERY_BATCH = 12;
const EXPLICIT_BATCH = 8;

interface Case {
  id: string;
  prompt: string;
  expect: Partial<{
    mode: Intent['mode'];
    media: Intent['media_type'];
    granularity: Intent['granularity'];
    minItems: number;
    playReference: boolean;
  }>;
  note?: string;
}

const CASES: Case[] = [
  { id: 'A', prompt: '播放5首周杰伦经典歌曲', expect: { mode: 'discovery', media: 'music', granularity: 'single' }, note: '应优先得到独立单曲，而不是合集' },
  { id: 'B', prompt: '播放一些适合晚上安静听的轻音乐', expect: { mode: 'discovery', media: 'music', granularity: 'single' }, note: '不应混入与睡前/轻音乐无关的内容' },
  { id: 'C', prompt: '找5个 Python 入门教程', expect: { mode: 'discovery', media: 'tutorial' }, note: '不应混入 Blender 等跨领域视频' },
  { id: 'D', prompt: '播放类似《送别》的歌曲', expect: { mode: 'hybrid', media: 'music', playReference: false }, note: '《送别》只作参考，不应出现在队列第一首' },
  { id: 'E', prompt: '播放周杰伦歌曲合集', expect: { granularity: 'collection' }, note: '合集模式不能被单曲规则误杀' },
  { id: 'F', prompt: '帮我播放《偶然》《再别康桥》《在水一方》', expect: { mode: 'explicit_playlist', minItems: 3 }, note: '原有明确清单流程必须保持正常' },
];

interface CaseOutcome {
  id: string;
  prompt: string;
  status: 'PASS' | 'FAIL';
  failedChecks: string[];
  failureReason: string | null;
  failureKind: string | null;
  intentSummary: string;
  queue: string[];
}

/* ---------------- 参数 ---------------- */

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

const config: LlmConfig = {
  baseUrl: readArg('base-url') ?? process.env.BAPA_BASE_URL ?? '',
  apiKey: readArg('api-key') ?? process.env.BAPA_API_KEY ?? '',
  model: readArg('model') ?? process.env.BAPA_MODEL ?? '',
  temperature: 0.2,
  maxTokens: 800,
};

if (!config.baseUrl || !config.apiKey || !config.model) {
  console.error(
    [
      '缺少真实模型配置，无法进行真实模型验证。',
      '',
      '用法：',
      '  npm run verify:llm -- --base-url https://api.openai.com/v1 --api-key sk-xxx --model gpt-4o-mini',
      '',
      '或先设置环境变量 BAPA_BASE_URL / BAPA_API_KEY / BAPA_MODEL。',
    ].join('\n'),
  );
  process.exit(2);
}

const client = new LlmClient(config);

/* ---------------- 真实搜索（Node 侧近似提取，仅用于本脚本） ---------------- */

function decodeOnce(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** B 站 title 属性存在双重实体编码，解两轮；扩展内用 getAttribute 不受影响。 */
const decodeEntities = (text: string): string => decodeOnce(decodeOnce(text)).replace(/\s+/g, ' ').trim();

/** 搜索页请求超时：没有超时的 fetch 会永久挂起，把整个验证脚本拖死。 */
const SEARCH_TIMEOUT_MS = 15_000;

async function fetchCandidates(keyword: string): Promise<Candidate[]> {
  const html = await fetch(buildSearchUrl(keyword), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  }).then((response) => response.text());

  const marks = [...html.matchAll(/<div class="bili-video-card"[^>]*>/g)].map((match) => match.index ?? 0);
  const candidates: Candidate[] = [];

  for (let i = 0; i < marks.length; i += 1) {
    const segment = html.slice(marks[i], marks[i + 1] ?? html.length);
    const url = normalizeVideoUrl(segment.match(/href="(\/\/www\.bilibili\.com\/video\/BV[^"]+)"/)?.[1]);
    if (!url) continue;

    const titleAttr = segment.match(/<h3 class="bili-video-card__info--tit"[^>]*title="([^"]*)"/)?.[1];
    const titleInner = segment.match(/<h3 class="bili-video-card__info--tit"[^>]*>([\s\S]*?)<\/h3>/)?.[1];
    candidates.push({
      title: decodeEntities(titleAttr ?? titleInner?.replace(/<[^>]+>/g, '') ?? ''),
      url,
      author: decodeEntities(segment.match(/class="bili-video-card__info--author"[^>]*>([^<]*)</)?.[1] ?? '') || null,
      duration: decodeEntities(segment.match(/class="bili-video-card__stats__duration"[^>]*>([^<]*)</)?.[1] ?? '') || null,
      views: null,
      description: null,
    });
    if (candidates.length >= SEARCH_LIMIT) break;
  }
  return candidates;
}

/** 与 SW 内 discovery 一致：先累积所有搜索关键词的结果，再统一排序一次。 */
async function runDiscoveryPipeline(intent: Intent, userPrompt: string): Promise<string[]> {
  let pool: Candidate[] = [];
  const seen = new Set<string>();

  for (const [index, query] of intent.search_queries.entries()) {
    const found = await fetchCandidates(query);
    for (const candidate of found) {
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      pool.push(candidate);
    }
    console.log(`    搜索词 ${index + 1}「${query}」-> 真实候选 ${found.length} 条，累计 ${pool.length} 条`);
  }

  if (pool.length === 0) return [];

  const scored = filterCandidates(pool, matchContextForDiscovery(intent), intent, {
    limit: DISCOVERY_BATCH,
    fallback: 'collection',
  });
  console.log(`    准入过滤后送审 ${scored.length} 条（粒度 ${intent.granularity}）`);
  for (const entry of scored) {
    console.log(`      #${entry.rank} [${entry.ruleScore}] ${entry.duration ?? '?'}  ${entry.title.slice(0, 52)}`);
  }
  if (scored.length === 0) return [];

  const outcome = await rankCandidates(
    client,
    scored,
    rankRequestForDiscovery(intent, userPrompt, Math.min(intent.target_count, scored.length)),
  );
  console.log(`    排序结果：来源=${outcome.source} | ${outcome.note}`);
  return outcome.selections.map((selection, index) => `${index + 1}. ${selection.candidate.title}`);
}

/** 与 SW 内 explicit 一致：每个点名作品各自搜索 + 各自排序一次。 */
async function runExplicitPipeline(intent: Intent): Promise<string[]> {
  const lines: string[] = [];

  for (const [index, item] of intent.items.entries()) {
    const keyword = buildSearchKeyword(
      { title: item.title, artist: item.artist },
      intent.media_type,
      intent.preferred,
      1,
    );
    const pool = await fetchCandidates(keyword);
    const scored = filterCandidates(pool, matchContextForItem(item, intent), intent, {
      limit: EXPLICIT_BATCH,
      fallback: 'any',
    });
    console.log(`    第 ${index + 1} 项「${item.title}」关键词「${keyword}」-> 候选 ${pool.length} 条，送审 ${scored.length} 条`);
    if (scored.length === 0) {
      lines.push(`${index + 1}. ${item.title}  ->  没有可用候选`);
      continue;
    }

    const outcome = await rankCandidates(client, scored, rankRequestForItem(item, intent));
    const best = outcome.selections[0];
    lines.push(`${index + 1}. ${item.title}  ->  ${best ? best.candidate.title.slice(0, 60) : '（无）'}`);
  }

  return lines;
}

/* ---------------- 失败分类 ---------------- */

function classifyFailure(error: unknown): { reason: string; kind: string } {
  if (error instanceof LlmError) {
    const extra = [error.status !== null ? `HTTP=${error.status}` : '', error.code ? `code=${error.code}` : '', `attempt=${error.attempts}`, `elapsed=${error.elapsedMs}ms`]
      .filter(Boolean)
      .join(' ');
    return { reason: `${FAILURE_LABEL[error.kind]}：${error.message}${extra ? ` [${extra}]` : ''}`, kind: error.kind };
  }
  return { reason: `其它错误：${error instanceof Error ? error.message : String(error)}`, kind: 'other' };
}

/* ---------------- 主流程 ---------------- */

const outcomes: CaseOutcome[] = [];
const failureTally: Record<string, number> = {};

console.log(`真实模型验证开始：${config.baseUrl} / ${config.model}`);
console.log(`重试策略：最多 3 次请求，仅对网络故障 / 429 / 5xx 退避重试；4xx 与格式错误不重试。\n`);

for (const testCase of CASES) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`用例 ${testCase.id}：${testCase.prompt}`);
  if (testCase.note) console.log(`说明：${testCase.note}`);
  console.log('='.repeat(72));

  const outcome: CaseOutcome = {
    id: testCase.id,
    prompt: testCase.prompt,
    status: 'PASS',
    failedChecks: [],
    failureReason: null,
    failureKind: null,
    intentSummary: '',
    queue: [],
  };

  const failed = (label: string, detail = '') => {
    outcome.failedChecks.push(`${label}${detail ? ` (${detail})` : ''}`);
    console.log(`    FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  };
  const passed = (label: string, detail = '') => console.log(`    PASS  ${label}${detail ? `  ${detail}` : ''}`);

  try {
    const intent = await parseIntent(client, testCase.prompt);

    outcome.intentSummary =
      `mode=${intent.mode} media=${intent.media_type} gran=${intent.granularity} ` +
      `items=${intent.items.length} queries=${intent.search_queries.length} target=${intent.target_count}`;

    console.log('  真实模型返回的意图：');
    console.log(
      JSON.stringify(
        {
          mode: intent.mode,
          media_type: intent.media_type,
          granularity: intent.granularity,
          play_reference: intent.play_reference,
          items: intent.items,
          search_queries: intent.search_queries,
          topic: intent.topic,
          creator: intent.creator,
          style: intent.style,
          keywords: intent.keywords,
          preferred: intent.preferred,
          avoid: intent.avoid,
          auto_expand: intent.auto_expand,
          target_count: intent.target_count,
        },
        null,
        2,
      )
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );

    // 结构性校验
    passed('未抛「必须点名作品」类错误');
    (intent.items.length > 0 || intent.search_queries.length > 0)
      ? passed('结构可执行：items 与 search_queries 至少一个非空')
      : failed('结构可执行', 'items 与 search_queries 都是空的');
    intent.search_queries.length <= 3
      ? passed('search_queries <= 3', `实际 ${intent.search_queries.length}`)
      : failed('search_queries <= 3', `实际 ${intent.search_queries.length}`);
    intent.target_count >= 1 && intent.target_count <= 10
      ? passed('target_count 在 1~10', `实际 ${intent.target_count}`)
      : failed('target_count 在 1~10', `实际 ${intent.target_count}`);
    if (testCase.expect.mode) {
      intent.mode === testCase.expect.mode
        ? passed(`mode == ${testCase.expect.mode}`)
        : failed(`mode == ${testCase.expect.mode}`, `实际 ${intent.mode}`);
    }
    if (testCase.expect.media) {
      intent.media_type === testCase.expect.media
        ? passed(`media_type == ${testCase.expect.media}`)
        : failed(`media_type == ${testCase.expect.media}`, `实际 ${intent.media_type}`);
    }
    if (testCase.expect.granularity) {
      intent.granularity === testCase.expect.granularity
        ? passed(`granularity == ${testCase.expect.granularity}`)
        : failed(`granularity == ${testCase.expect.granularity}`, `实际 ${intent.granularity}`);
    }
    if (testCase.expect.playReference !== undefined) {
      intent.play_reference === testCase.expect.playReference
        ? passed(`play_reference == ${testCase.expect.playReference}`)
        : failed(`play_reference == ${testCase.expect.playReference}`, `实际 ${intent.play_reference}`);
    }
    if (testCase.expect.minItems !== undefined) {
      intent.items.length >= testCase.expect.minItems
        ? passed(`items >= ${testCase.expect.minItems}`, `实际 ${intent.items.length}`)
        : failed(`items >= ${testCase.expect.minItems}`, `实际 ${intent.items.length}`);
    }

    // 真实搜索 + 真实排序
    const playItems = intent.items.length > 0 && (intent.mode !== 'hybrid' || intent.play_reference);
    console.log('\n  真实链路：');
    try {
      outcome.queue = playItems
        ? await runExplicitPipeline(intent)
        : await runDiscoveryPipeline(intent, testCase.prompt);
    } catch (error) {
      const { reason, kind } = classifyFailure(error);
      outcome.failureReason = `链路执行失败 —— ${reason}`;
      outcome.failureKind = kind;
      failureTally[kind] = (failureTally[kind] ?? 0) + 1;
      failed('链路执行', reason);
    }
  } catch (error) {
    const { reason, kind } = classifyFailure(error);
    outcome.failureReason = `意图解析失败 —— ${reason}`;
    outcome.failureKind = kind;
    failureTally[kind] = (failureTally[kind] ?? 0) + 1;
    failed('意图解析', reason);
  }

  outcome.status = outcome.failedChecks.length === 0 && outcome.failureReason === null ? 'PASS' : 'FAIL';
  console.log(`\n  最终队列（${outcome.queue.length} 项）：`);
  if (outcome.queue.length === 0) console.log('    （空）');
  for (const line of outcome.queue) console.log(`    ${line}`);

  outcomes.push(outcome);
  console.log(`  >>> 用例 ${outcome.id}：${outcome.status}`);
}

/* ---------------- A–F 汇总 ---------------- */

console.log(`\n${'='.repeat(72)}`);
console.log('A–F 验收汇总');
console.log('='.repeat(72));
console.log('用例 | 结果 | 意图摘要 / 失败原因 | 队列');
console.log('-'.repeat(72));
for (const outcome of outcomes) {
  const detail = outcome.failureReason ?? outcome.intentSummary;
  console.log(`${outcome.id.padEnd(4)} | ${outcome.status.padEnd(4)} | ${detail}`);
  console.log(`${''.padEnd(4)} | ${''.padEnd(4)} | 队列 ${outcome.queue.length} 项：${outcome.queue.map((q) => q.slice(0, 40)).join(' / ') || '（空）'}`);
  if (outcome.failedChecks.length > 0) {
    console.log(`${''.padEnd(4)} | ${''.padEnd(4)} | 未通过项：${outcome.failedChecks.join('; ')}`);
  }
}

const passCount = outcomes.filter((o) => o.status === 'PASS').length;
console.log('-'.repeat(72));
console.log(`通过 ${passCount} / ${outcomes.length}`);
const tallyEntries = Object.entries(failureTally);
console.log(
  tallyEntries.length > 0
    ? `失败分类统计：${tallyEntries.map(([kind, count]) => `${kind}=${count}`).join('  ')}`
    : '失败分类统计：无失败',
);
console.log('说明：意图与排序结论均来自真实模型；搜索结果来自真实 search.bilibili.com。');
console.log('日志中的 [LLM][网络失败] / [LLM][HTTP 失败] / [LLM][JSON 解析失败] / [LLM][模型主动返回空选择] 可直接区分失败类型。');

process.exit(passCount === CASES.length ? 0 : 1);
