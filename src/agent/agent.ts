import type {
  ActionAck,
  AgentSnapshot,
  Candidate,
  ContentEvent,
  HelloAck,
  Intent,
  LlmConfig,
  LogLevel,
  PanelCommand,
  QueueItem,
  SelectionSource,
} from '../types';
import { LlmClient } from '../services/llm';
import { parseIntent } from '../services/intent';
import {
  filterCandidates,
  matchContextForDiscovery,
  matchContextForItem,
  rankCandidates,
  rankRequestForDiscovery,
  rankRequestForItem,
  workKey,
  type RankSelection,
} from '../services/ranking';
import { clearEntries, describeError, logger } from '../utils/logger';
import { cacheKey, getCachedVideo, getSettings, saveSettings, setCachedVideo } from '../utils/storage';
import { buildSearchKeyword, buildSearchUrl, extractBvId, truncate } from '../utils/text';
import { createQueueItems, currentItem, updateItem } from './queue';
import { store } from './state';

/* ---------------- 可调常量 ---------------- */

/** 等搜索结果 / 打开视频的最长时间。 */
const SEARCH_TIMEOUT_MS = 45_000;
/**
 * 排序阶段的超时必须覆盖 LLM 的失败重试预算（3 次尝试 + 退避），
 * 否则看门狗会在 LLM 还在重试时就把当前条目判失败，把状态机搅乱。
 */
const RANKING_TIMEOUT_MS = 180_000;
/** 播放心跳静默多久判定为卡死。 */
const PLAYBACK_STALL_TIMEOUT_MS = 90_000;
/** 规范要求：第一版最多两次搜索。 */
const MAX_SEARCH_ATTEMPTS = 2;
/** 自动扩展只做一轮，避免无限推荐。 */
const MAX_EXPAND_ROUNDS = 1;
/** 发现式阶段送审候选上限。跨关键词累积后池子更大，所以比单曲模式放得宽一些。 */
const DISCOVERY_RANK_BATCH_SIZE = 12;
/** 明确清单模式每个作品的送审上限。 */
const EXPLICIT_RANK_BATCH_SIZE = 8;

/** 各阶段等待外部事件的超时上限。RANKING 要给 LLM 的失败重试留足时间。 */
const WAITING_TIMEOUT_MS: Partial<Record<AgentSnapshot['state'], number>> = {
  DISCOVERING: SEARCH_TIMEOUT_MS,
  SEARCHING: SEARCH_TIMEOUT_MS,
  OPENING: SEARCH_TIMEOUT_MS,
  RANKING: RANKING_TIMEOUT_MS,
};

/** 保活 + 超时检查的 alarm。它是"安全网"，不是生命周期主力（主力是真实事件）。 */
export const TICK_ALARM = 'bapa:tick';
const TICK_PERIOD_MINUTES = 0.5;

const BILIBILI_HOME = 'https://www.bilibili.com/';

/* ---------------- 标签页 ---------------- */

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** 任务进行中获取受控标签页。用户把标签页关了或不在了就返回 null（不抢占别的标签页）。 */
async function requireControlledTab(): Promise<number | null> {
  const { controlledTabId } = store.get();
  if (controlledTabId === null) return null;
  return (await tabExists(controlledTabId)) ? controlledTabId : null;
}

/** 只在 START 时调用：复用当前绑定 / 复用已有 B 站标签页 / 实在没有才新建一个。 */
async function resolveControlledTabForStart(): Promise<number> {
  const snapshot = store.get();
  if (snapshot.controlledTabId !== null && (await tabExists(snapshot.controlledTabId))) {
    return snapshot.controlledTabId;
  }

  const bilibiliTabs = await chrome.tabs.query({
    url: ['https://www.bilibili.com/*', 'https://search.bilibili.com/*'],
  });
  const picked = bilibiliTabs.find((tab) => tab.active) ?? bilibiliTabs[0];
  if (picked?.id !== undefined) return picked.id;

  const created = await chrome.tabs.create({ url: BILIBILI_HOME, active: true });
  if (created.id === undefined) throw new Error('无法创建 Bilibili 标签页');
  return created.id;
}

/**
 * 跳转。若目标 URL 与当前完全一致，chrome.tabs.update 不会触发重新加载，
 * content script 也就不会重新握手 —— 这时改用 reload 强制重新注入。
 */
async function navigate(tabId: number, url: string): Promise<void> {
  const currentUrl = (await chrome.tabs.get(tabId)).url ?? '';
  await chrome.tabs.update(tabId, { url });
  if (currentUrl === url) {
    logger.debug('目标 URL 与当前一致，改用 reload 触发 content script 重新注入');
    await chrome.tabs.reload(tabId);
  }
}

/* ---------------- 过期操作自检 ---------------- */

/**
 * 用户干预（START / NEXT / STOP / CLEAR）会让 generation 自增。
 * 任何跨 await 的异步流程回来时都要自检，否则会用过期结果覆盖用户的新意图 ——
 * 典型症状：用户点了「下一个」，上一个条目的流程却把队列状态又写了回去。
 */
function staleGeneration(gen: number): boolean {
  if (store.get().generation === gen) return false;
  logger.debug('用户已改变播放目标，放弃本次过期操作');
  return true;
}

/* ---------------- 保活与超时 ---------------- */

async function syncTick(): Promise<void> {
  const snapshot = store.get();
  const active = ['NEXT', 'DISCOVERING', 'SEARCHING', 'RANKING', 'OPENING', 'PLAYING'].includes(snapshot.state);
  const shouldTick = snapshot.running && !snapshot.paused && active;

  if (!shouldTick) {
    await chrome.alarms.clear(TICK_ALARM);
    return;
  }
  // 已存在就不要重复 create，否则会不断重置计时器，alarm 永远不触发
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_PERIOD_MINUTES });
  }
}

/**
 * 安全网：SW 可能被回收，普通 setTimeout 会丢失，所以超时判定只依赖快照里的时间戳。
 * 注意暂停期间不判定超时——用户手动暂停视频是合法状态。
 */
export async function runWatchdog(): Promise<void> {
  const snapshot = store.get();
  if (!snapshot.running) {
    await chrome.alarms.clear(TICK_ALARM);
    return;
  }
  if (snapshot.paused) return;

  const now = Date.now();
  const waiting = snapshot.waitingSince;

  const stateTimeout = WAITING_TIMEOUT_MS[snapshot.state];
  if (stateTimeout !== undefined) {
    if (waiting !== null && now - waiting > stateTimeout) {
      logger.warn(`${snapshot.state} 等待超时（上限 ${stateTimeout}ms）`);
      await failCurrent(
        snapshot.state === 'RANKING'
          ? '模型排序超时（已重试仍未成功）'
          : '搜索页面超时未返回结果（可能是网络问题或页面结构变化）',
      );
    }
    return;
  }

  if (snapshot.state === 'PLAYING') {
    const since = snapshot.lastHeartbeatAt ?? waiting ?? now;
    if (now - since > PLAYBACK_STALL_TIMEOUT_MS) {
      logger.warn('视频页心跳超时');
      await failCurrent('视频页长时间无响应（可能已被删除、地区受限或播放器未加载）');
    }
  }
}

/* ---------------- 状态机 ---------------- */

let stepping = false;
let stepRequested = false;

export async function step(): Promise<void> {
  if (stepping) {
    stepRequested = true;
    return;
  }
  stepping = true;
  try {
    do {
      stepRequested = false;
      await runOnce();
    } while (stepRequested);
  } catch (error) {
    const message = describeError(error);
    logger.error(`状态机异常：${message}`);
    store.patch({ lastError: message });
  } finally {
    stepping = false;
    // 循环已停下来等外部事件，此刻统一决定要不要挂保活/超时 alarm
    await syncTick();
    await store.flush();
  }
}

async function runOnce(): Promise<void> {
  switch (store.get().state) {
    case 'NEXT':
      await handleNext();
      return;
    case 'DISCOVERING':
      await handleDiscovering();
      return;
    case 'SEARCHING':
      await handleSearch();
      return;
    case 'RANKING':
      await handleRanking();
      return;
    default:
      // IDLE / FINISHED / ERROR / PLAYING 都在等外部事件，不主动做事
      return;
  }
}

async function handleNext(): Promise<void> {
  const snapshot = store.get();
  if (!snapshot.running) {
    store.patch({ state: 'IDLE' });
    return;
  }
  // 暂停时停在 NEXT，等 RESUME 再继续（快照已落盘，SW 被回收也不丢）
  if (snapshot.paused) {
    logger.info('任务已暂停，等待「继续」');
    return;
  }

  const nextIndex = snapshot.currentIndex + 1;
  if (nextIndex >= snapshot.queue.length) {
    if (await tryExpand()) return;

    logger.info('播放队列已完成');
    store.patch({
      state: 'FINISHED',
      running: false,
      currentBvId: null,
      waitingSince: null,
      lastHeartbeatAt: null,
      pendingCandidates: [],
    });
    return;
  }

  store.patch({
    currentIndex: nextIndex,
    state: 'SEARCHING',
    searchAttempt: 0,
    currentBvId: null,
    pendingCandidates: [],
  });
  stepRequested = true;
}

/**
 * 队列播完后的自动扩展。整场会话最多 1 轮，避免无限推荐。
 *
 * 实现方式：直接复用 Intent 里的 search_queries 走一遍发现式搜索，
 * 而不是让 LLM 凭空编歌名 —— 这样找到的每一条都仍然来自真实搜索结果。
 */
async function tryExpand(): Promise<boolean> {
  const snapshot = store.get();
  const intent = snapshot.intent;
  if (!intent) return false;
  // hybrid + 播放参考作品时才需要额外扩一轮；hybrid + 只做参考的情况，
  // 开头那次 DISCOVERING 已经是"找同类内容"了，不能再来一次。
  const wantsExpansion = intent.auto_expand || (intent.mode === 'hybrid' && intent.play_reference);
  if (!wantsExpansion) return false;
  if (intent.search_queries.length === 0) return false;
  if (snapshot.expandRounds >= MAX_EXPAND_ROUNDS) {
    logger.info('自动扩展已达上限（1 轮），不再继续推荐');
    return false;
  }

  logger.info(`首轮队列已播完，开始搜罗同类内容：${intent.search_queries.join(' | ')}`);
  store.patch({
    expandRounds: snapshot.expandRounds + 1,
    discoveryIndex: 0,
    // 新内容会追加到队列末尾，播完就从这里接着播
    discoveryStartIndex: snapshot.queue.length,
    state: 'DISCOVERING',
    currentBvId: null,
    pendingCandidates: [],
    waitingSince: null,
  });
  stepRequested = true;
  return true;
}

async function handleSearch(): Promise<void> {
  const snapshot = store.get();
  const item = currentItem(snapshot.queue, snapshot.currentIndex);
  const intent = snapshot.intent;

  if (!item || !intent) {
    await failCurrent('搜索阶段缺少队列或意图上下文');
    return;
  }

  // 发现式搜索阶段已经把视频挑好了，直接播，不用再搜一次
  if (item.videoUrl) {
    logger.info(`「${item.title}」在挑选阶段已确定视频，直接播放`);
    await openChosen(item.videoUrl, item.videoTitle, item.source ?? 'llm');
    return;
  }

  const attempt = snapshot.searchAttempt + 1;
  if (attempt > MAX_SEARCH_ATTEMPTS) {
    await failCurrent('两次搜索都没有找到可用结果');
    return;
  }

  const tabId = await requireControlledTab();
  if (tabId === null) {
    await pauseFor('受控的 Bilibili 标签页已不可用，任务已暂停。请重新打开 Bilibili 后点「继续」');
    return;
  }
  if (staleGeneration(snapshot.generation)) return;

  const keyword = buildSearchKeyword(
    { title: item.title, artist: item.artist },
    intent.media_type,
    intent.preferred,
    attempt,
  );

  store.patch({
    searchAttempt: attempt,
    queue: updateItem(snapshot.queue, snapshot.currentIndex, { status: 'searching', error: null }),
    currentBvId: null,
  });
  logger.info(`搜索「${item.title}」第 ${attempt} 次，关键词：${keyword}`);

  // 先进入等待计时再跳转：页面可能在 tabs.update 一 resolve 时就已开始注入，
  // 把等待起点前移可以保证"到达的消息一定有计时覆盖"，watchdog 判定才准确。
  store.markWaiting();
  await navigate(tabId, buildSearchUrl(keyword));
  // 保持 SEARCHING，等 content script 回 SEARCH_RESULTS
}

async function handleRanking(): Promise<void> {
  const snapshot = store.get();
  const item = currentItem(snapshot.queue, snapshot.currentIndex);
  const intent = snapshot.intent;

  if (!item || !intent) {
    await failCurrent('排序阶段缺少队列或意图上下文');
    return;
  }
  if (item.videoUrl) {
    await openChosen(item.videoUrl, item.videoTitle, item.source ?? 'llm');
    return;
  }
  if (snapshot.pendingCandidates.length === 0) {
    await failCurrent('没有可排序的候选');
    return;
  }

  const gen = snapshot.generation;
  const key = cacheKey(item.title, intent.media_type);
  const cachedUrl = await getCachedVideo(key);
  if (staleGeneration(gen)) return;

  if (cachedUrl) {
    const cachedTitle = snapshot.pendingCandidates.find((c) => c.url === cachedUrl)?.title ?? null;
    logger.info(`缓存命中「${item.title}」-> ${cachedUrl}`);
    await openChosen(cachedUrl, cachedTitle, 'cache');
    return;
  }

  const scored = filterCandidates(snapshot.pendingCandidates, matchContextForItem(item, intent), intent, {
    limit: EXPLICIT_RANK_BATCH_SIZE,
    // 点名了具体作品就必须找到东西，允许逐层退让，避免死锁
    fallback: 'any',
  });
  if (scored.length === 0) {
    await failCurrent('候选经过规则过滤后为空');
    return;
  }

  const client = new LlmClient(await getSettings());
  const outcome = await rankCandidates(client, scored, rankRequestForItem(item, intent));
  if (staleGeneration(gen)) return;

  const best = outcome.selections[0];
  if (!best) {
    await failCurrent('排序没有产出候选');
    return;
  }

  logger.info(
    `选中 ${best.candidate.url}（来源：${outcome.source}）${best.reason ? `理由：${best.reason}` : outcome.note}`,
  );
  await setCachedVideo(key, best.candidate.url, best.candidate.title);
  await openChosen(best.candidate.url, best.candidate.title, outcome.source);
}

/** 打开指定视频并进入 PLAYING，之后等 content script 报 ended / failed。 */
async function openChosen(url: string, title: string | null, source: SelectionSource): Promise<void> {
  const tabId = await requireControlledTab();
  if (tabId === null) {
    await pauseFor('受控的 Bilibili 标签页已不可用，任务已暂停。请重新打开 Bilibili 后点「继续」');
    return;
  }

  const snapshot = store.get();
  store.patch({
    state: 'OPENING',
    currentBvId: extractBvId(url),
    pendingCandidates: [],
    queue: updateItem(snapshot.queue, snapshot.currentIndex, {
      status: 'playing',
      videoUrl: url,
      videoTitle: title,
      source,
      error: null,
    }),
  });

  store.markWaiting();
  await navigate(tabId, url);
  store.patch({ state: 'PLAYING', lastHeartbeatAt: Date.now() });
}

/* ---------------- 发现式搜索（用户没点名具体作品时） ---------------- */

/**
 * DISCOVERING 阶段分两步：
 *   1) 收集：把所有 search_queries 的结果页都跑一遍，候选累积到 pendingCandidates
 *   2) 排序：对累积候选做一次准入过滤 + 一次批量排序，再拼出播放队列
 *
 * 之所以不再「第一个关键词凑够数量就停」：单个搜索结果页常常被合集、串烧占满，
 * 多跑几个关键词累积之后再统一挑选，才能拿到足够多的独立单曲。
 * 收集阶段 0 次 LLM 调用，整轮只发 1 次排序请求。
 */
async function handleDiscovering(): Promise<void> {
  const snapshot = store.get();
  const intent = snapshot.intent;
  if (!intent) {
    await failCurrent('挑选阶段缺少意图上下文');
    return;
  }

  const queries = intent.search_queries;

  // 第一遍：逐个关键词收集候选
  if (snapshot.discoveryIndex < queries.length) {
    const tabId = await requireControlledTab();
    if (tabId === null) {
      await pauseFor('受控的 Bilibili 标签页已不可用，任务已暂停。请重新打开 Bilibili 后点「继续」');
      return;
    }
    const query = queries[snapshot.discoveryIndex];
    logger.info(`收集候选 ${snapshot.discoveryIndex + 1}/${queries.length}，搜索词：${query}`);
    store.markWaiting();
    await navigate(tabId, buildSearchUrl(query));
    // 保持 DISCOVERING，等 content script 回 SEARCH_RESULTS
    return;
  }

  // 第二遍：统一排序并拼出队列
  const added = await rankDiscoveryPool();
  logger.info(`挑选阶段结束：本轮新增 ${added} 项`);
  if (added === 0) {
    logger.warn('没有找到符合要求的候选，不强行补入不相关内容');
  }
  await finishDiscoveryRound();
}

/** 只累积候选，不做任何 LLM 调用。 */
async function onDiscoveryResults(candidates: Candidate[]): Promise<ActionAck> {
  const snapshot = store.get();
  const intent = snapshot.intent;
  if (!intent) {
    await failCurrent('挑选阶段缺少意图上下文');
    return { kind: 'ack', ok: false, error: '缺少意图上下文' };
  }

  const query = intent.search_queries[snapshot.discoveryIndex] ?? '';
  const merged = mergeCandidates(snapshot.pendingCandidates, candidates);
  logger.info(`「${query}」收到 ${candidates.length} 条候选，跨关键词累计去重后 ${merged.length} 条`);

  store.patch({
    pendingCandidates: merged,
    discoveryIndex: snapshot.discoveryIndex + 1,
    waitingSince: null,
  });
  void step();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

/** 跨关键词累积候选，按 BV 去重。 */
function mergeCandidates(existing: Candidate[], incoming: Candidate[]): Candidate[] {
  const seen = new Set(
    existing.map((candidate) => extractBvId(candidate.url)).filter((bv): bv is string => Boolean(bv)),
  );
  const merged = [...existing];
  for (const candidate of incoming) {
    const bvId = extractBvId(candidate.url);
    if (!bvId || seen.has(bvId)) continue;
    seen.add(bvId);
    merged.push(candidate);
  }
  return merged;
}

/** 对累积候选做一次准入过滤 + 一次批量排序，把合格条目追加进队列。 */
async function rankDiscoveryPool(): Promise<number> {
  const snapshot = store.get();
  const intent = snapshot.intent;
  if (!intent) return 0;

  if (snapshot.pendingCandidates.length === 0) {
    logger.warn('所有搜索词都没有返回候选');
    return 0;
  }

  const scored = filterCandidates(snapshot.pendingCandidates, matchContextForDiscovery(intent), intent, {
    limit: DISCOVERY_RANK_BATCH_SIZE,
    // 宁可队列短于 target_count，也不把跑题内容塞进来；只有连单曲都找不到时才退让到合集
    fallback: 'collection',
  });
  if (scored.length === 0) {
    logger.warn('累积候选没有通过准入校验（主题或内容粒度不符）');
    return 0;
  }

  const collected = snapshot.queue.length - snapshot.discoveryStartIndex;
  const remaining = Math.max(1, intent.target_count - collected);

  const client = new LlmClient(await getSettings());
  const outcome = await rankCandidates(
    client,
    scored,
    rankRequestForDiscovery(intent, snapshot.userPrompt, Math.min(remaining, scored.length)),
  );
  if (staleGeneration(snapshot.generation)) return 0;

  logger.info(`排序结论：${outcome.note}`);
  return appendSelections(outcome.selections, intent, outcome.source);
}

/**
 * 把 LLM 选中的候选追加进播放队列。
 * 这里会再做一次基础有效性校验：BV 号必须能从真实链接解析出来，
 * 并且挡掉队列里已有的同一 BV、以及同一作品的其它版本。
 */
function appendSelections(selections: RankSelection[], intent: Intent, source: SelectionSource): number {
  const snapshot = store.get();
  const collected = snapshot.queue.length - snapshot.discoveryStartIndex;
  const remaining = intent.target_count - collected;
  if (remaining <= 0) return 0;

  const knownBv = new Set<string>();
  const knownWorks = new Set<string>();
  for (const item of snapshot.queue) {
    const bvId = extractBvId(item.videoUrl ?? '');
    if (bvId) knownBv.add(bvId);
    const key = workKey(item.videoTitle ?? item.title);
    if (key.length >= 3) knownWorks.add(key);
  }

  const additions: QueueItem[] = [];
  let nextId = snapshot.queue.reduce((max, item) => Math.max(max, item.id), 0) + 1;

  for (const selection of selections) {
    if (additions.length >= remaining) break;

    const bvId = extractBvId(selection.candidate.url);
    if (!bvId) {
      logger.warn(`丢弃无法解析出 BV 号的候选：${truncate(selection.candidate.url, 60)}`);
      continue;
    }
    if (knownBv.has(bvId)) continue;

    const key = workKey(selection.candidate.title);
    if (key.length >= 3 && knownWorks.has(key)) {
      logger.debug(`跳过同一作品的其它版本：${truncate(selection.candidate.title, 40)}`);
      continue;
    }

    knownBv.add(bvId);
    if (key.length >= 3) knownWorks.add(key);
    additions.push({
      id: nextId,
      title: selection.candidate.title,
      artist: selection.candidate.author,
      status: 'pending',
      // 统一用解析出来的 BV 号重建链接，顺带完成一次有效性校验
      videoUrl: `https://www.bilibili.com/video/${bvId}`,
      videoTitle: selection.candidate.title,
      error: null,
      source,
    });
    nextId += 1;
  }

  if (additions.length > 0) {
    store.patch({ queue: [...snapshot.queue, ...additions] });
  }
  return additions.length;
}

/** 一轮发现式搜索收尾：把 currentIndex 指到本轮新增的第一项，交回普通播放流程。 */
async function finishDiscoveryRound(): Promise<void> {
  const snapshot = store.get();
  const collected = snapshot.queue.length - snapshot.discoveryStartIndex;

  if (collected === 0) {
    if (snapshot.queue.length === 0) {
      logger.error('挑选阶段没有找到符合要求的视频');
      store.patch({
        state: 'ERROR',
        running: false,
        lastError: '没有找到符合你要求的视频（主题或内容粒度不匹配），可以试试换一种说法',
        waitingSince: null,
      });
      return;
    }
    logger.info('本轮没有找到新内容，队列结束');
    store.patch({
      state: 'FINISHED',
      running: false,
      discoveryIndex: 0,
      discoveryStartIndex: 0,
      waitingSince: null,
      currentBvId: null,
      pendingCandidates: [],
    });
    return;
  }

  logger.info(`挑选完成，本轮新增 ${collected} 项，开始播放`);
  store.patch({
    currentIndex: snapshot.discoveryStartIndex,
    discoveryIndex: 0,
    discoveryStartIndex: 0,
    state: 'SEARCHING',
    searchAttempt: 0,
    currentBvId: null,
    pendingCandidates: [],
  });
  stepRequested = true;
}

function logPageNotice(level: LogLevel, message: string): void {
  const text = `[页面] ${message}`;
  if (level === 'ERROR') logger.error(text);
  else if (level === 'WARN') logger.warn(text);
  else if (level === 'DEBUG') logger.debug(text);
  else logger.info(text);
}

/* ---------------- 失败与暂停 ---------------- */

async function failCurrent(reason: string): Promise<void> {
  const snapshot = store.get();
  const item = currentItem(snapshot.queue, snapshot.currentIndex);
  logger.warn(`当前条目失败：${reason}`);

  store.patch({
    queue: updateItem(snapshot.queue, snapshot.currentIndex, {
      status: 'failed',
      error: reason,
    }),
    lastError: item ? `${item.title}：${reason}` : reason,
    state: 'NEXT',
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
    pendingCandidates: [],
  });

  // failCurrent 既可能从状态机循环内部调用（此时靠 stepRequested 续跑），
  // 也可能从消息处理器 / watchdog 调用（此时必须主动再驱动一次），
  // 所以这里统一调用 step()：循环内是幂等的，循环外正好启动。
  stepRequested = true;
  void step();
}

async function pauseFor(reason: string): Promise<void> {
  logger.warn(reason);
  store.patch({ paused: true, lastError: reason, waitingSince: null });
  await syncTick();
  await store.flush();
}

/* ---------------- content script 事件 ---------------- */

export async function handleContentEvent(
  event: ContentEvent,
  sender: chrome.runtime.MessageSender,
): Promise<HelloAck | ActionAck> {
  if (event.type === 'CONTENT_HELLO') {
    return buildHelloAck(sender);
  }

  const problem = validateContentSender(event, sender);
  if (problem) return { kind: 'ack', ok: false, error: problem };

  switch (event.type) {
    case 'SEARCH_RESULTS':
      return onSearchResults(event.candidates);
    case 'VIDEO_ENDED':
      return onVideoEnded(event.bvId);
    case 'VIDEO_FAILED':
      return onVideoFailed(event.reason);
    case 'VIDEO_HEARTBEAT':
      return onHeartbeat(event.bvId);
    case 'VIDEO_NOTICE':
      logPageNotice(event.level, event.message);
      return { kind: 'ack', ok: true };
    default:
      return { kind: 'ack', ok: false, error: '未知事件' };
  }
}

/**
 * 三重校验：受控标签页 + 会话 + 队列条目。
 * 目的是让上一次任务或上一个条目残留页面的消息无法影响当前播放。
 */
function validateContentSender(
  event: Exclude<ContentEvent, { type: 'CONTENT_HELLO' }>,
  sender: chrome.runtime.MessageSender,
): string | null {
  const snapshot = store.get();
  const senderTabId = sender.tab?.id;

  if (senderTabId === undefined || senderTabId !== snapshot.controlledTabId) {
    return '非受控标签页，已忽略';
  }
  if (event.sessionId !== snapshot.sessionId) {
    return '会话不匹配，已忽略（可能是上一次任务的残留页面）';
  }
  if (event.itemId !== null) {
    const current = currentItem(snapshot.queue, snapshot.currentIndex);
    if (current && event.itemId !== current.id) {
      return `条目不匹配（当前 #${current.id}，收到 #${event.itemId}），忽略过期页面的消息`;
    }
  }
  return null;
}

function buildHelloAck(sender: chrome.runtime.MessageSender): HelloAck {
  const snapshot = store.get();
  const senderTabId = sender.tab?.id;
  const isControlled = senderTabId !== undefined && senderTabId === snapshot.controlledTabId;
  const url = sender.tab?.url ?? '';

  let role: HelloAck['role'] = 'none';
  if (isControlled && snapshot.running) {
    // 发现式阶段同样是在搜索页上收集候选，必须一起下发 search 角色
    const onSearchState = snapshot.state === 'SEARCHING' || snapshot.state === 'DISCOVERING';
    if (onSearchState && url.includes('search.bilibili.com')) role = 'search';
    else if (snapshot.state === 'PLAYING' || snapshot.state === 'OPENING') role = 'video';
  }

  if (role === 'video' && snapshot.currentBvId === null) {
    // 还没有确定要播哪个 BV，此时挂播放器没有意义
    return { kind: 'hello', role: 'none', sessionId: null, itemId: null, state: snapshot.state, expectedBvId: null };
  }

  return {
    kind: 'hello',
    role,
    sessionId: role === 'none' ? null : snapshot.sessionId,
    itemId: role === 'none' ? null : (currentItem(snapshot.queue, snapshot.currentIndex)?.id ?? null),
    state: snapshot.state,
    expectedBvId: role === 'video' ? snapshot.currentBvId : null,
  };
}

async function onSearchResults(candidates: Candidate[]): Promise<ActionAck> {
  const snapshot = store.get();

  if (snapshot.state === 'DISCOVERING') {
    return onDiscoveryResults(candidates);
  }

  if (snapshot.state !== 'SEARCHING') {
    return { kind: 'ack', ok: false, error: `当前状态是 ${snapshot.state}，忽略搜索结果` };
  }

  logger.info(`收到 ${candidates.length} 条候选`);

  if (candidates.length === 0) {
    if (snapshot.searchAttempt >= MAX_SEARCH_ATTEMPTS) {
      await failCurrent('搜索结果为空');
      return { kind: 'ack', ok: true, snapshot: store.get() };
    }
    // 仍处于 SEARCHING，交给状态机用第 2 个关键词再搜一次
    logger.info('搜索结果为空，换一个关键词再搜一次');
    store.patch({ waitingSince: null });
    void step();
    return { kind: 'ack', ok: true, snapshot: store.get() };
  }

  store.patch({ state: 'RANKING', pendingCandidates: candidates, waitingSince: Date.now() });
  void step();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function onVideoEnded(bvId: string): Promise<ActionAck> {
  const snapshot = store.get();
  if (snapshot.state !== 'PLAYING') {
    return { kind: 'ack', ok: false, error: `当前状态是 ${snapshot.state}，忽略播放结束事件` };
  }
  if (snapshot.currentBvId !== null && bvId !== snapshot.currentBvId) {
    return { kind: 'ack', ok: false, error: `BV 号不匹配（期望 ${snapshot.currentBvId}），忽略播放结束事件` };
  }

  const item = currentItem(snapshot.queue, snapshot.currentIndex);
  logger.info(`《${item?.title ?? '当前曲目'}》播放结束，准备下一首`);

  // 立刻清空 currentBvId，防止同一个 ended 事件被重复消费
  store.patch({
    queue: updateItem(snapshot.queue, snapshot.currentIndex, { status: 'done' }),
    state: 'NEXT',
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
  });

  void step();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function onVideoFailed(reason: string): Promise<ActionAck> {
  const snapshot = store.get();
  if (snapshot.state !== 'PLAYING' && snapshot.state !== 'OPENING') {
    return { kind: 'ack', ok: false, error: `当前状态是 ${snapshot.state}，忽略播放失败事件` };
  }
  await failCurrent(reason);
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function onHeartbeat(bvId: string): Promise<ActionAck> {
  const snapshot = store.get();
  if (snapshot.state !== 'PLAYING') {
    return { kind: 'ack', ok: false, error: '非播放阶段，忽略心跳' };
  }
  if (snapshot.currentBvId !== null && bvId !== snapshot.currentBvId) {
    return { kind: 'ack', ok: false, error: 'BV 号不匹配，忽略心跳' };
  }
  store.patch({ lastHeartbeatAt: Date.now() });
  return { kind: 'ack', ok: true };
}

/* ---------------- side panel 指令 ---------------- */

export async function handlePanelCommand(command: PanelCommand): Promise<ActionAck> {
  switch (command.type) {
    case 'START':
      return startTask(command.prompt);
    case 'PAUSE':
      return pauseTask();
    case 'RESUME':
      return resumeTask();
    case 'NEXT':
      return skipToNext();
    case 'STOP':
      return stopTask();
    case 'CLEAR':
      return clearTask();
    case 'GET_STATE':
      return { kind: 'ack', ok: true, snapshot: store.get() };
    case 'GET_SETTINGS':
      return { kind: 'ack', ok: true, settings: await getSettings(), snapshot: store.get() };
    case 'SAVE_SETTINGS':
      return saveConfig(command.config);
    case 'TEST_LLM':
      return testConfig(command.config);
    case 'CLEAR_LOGS':
      return clearLogs();
    default:
      return { kind: 'ack', ok: false, error: '未知指令' };
  }
}

async function startTask(prompt: string): Promise<ActionAck> {
  const text = prompt.trim();
  if (!text) return { kind: 'ack', ok: false, error: '请先描述你想听或想看的内容' };

  const config = await getSettings();
  const configProblem = validateConfig(config);
  if (configProblem) return { kind: 'ack', ok: false, error: configProblem, settings: config };

  logger.info('收到新任务，开始解析需求');
  store.patch({
    state: 'PARSING_INTENT',
    running: true,
    paused: false,
    queue: [],
    intent: null,
    userPrompt: text,
    pendingCandidates: [],
    discoveryIndex: 0,
    discoveryStartIndex: 0,
    currentIndex: 0,
    searchAttempt: 0,
    expandRounds: 0,
    generation: store.get().generation + 1,
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
    lastError: null,
  });
  await store.flush();

  try {
    const tabId = await resolveControlledTabForStart();
    store.patch({ controlledTabId: tabId });
    logger.info(`已绑定受控标签页 tabId=${tabId}`);

    const intent = await parseIntent(new LlmClient(config), text);

    // 「播放类似《送别》的歌」里的《送别》只是参考作品，默认不播它本身，
    // 直接进入挑选阶段去找同类内容；只有用户明确说"先播放《送别》"才会把清单排进队列。
    const playExplicitItems = intent.items.length > 0 && (intent.mode !== 'hybrid' || intent.play_reference);

    if (playExplicitItems) {
      const queue = createQueueItems(intent.items);
      store.patch({ intent, queue, state: 'SEARCHING', currentIndex: 0 });
      logger.info(
        `${intent.mode} 模式，粒度 ${intent.granularity}，播放队列已生成，共 ${queue.length} 项：${queue.map((item) => item.title).join('、')}`,
      );
    } else {
      store.patch({ intent, queue: [], state: 'DISCOVERING', currentIndex: 0 });
      logger.info(
        `${intent.mode} 模式，粒度 ${intent.granularity}，先搜索再挑选：${intent.search_queries.join(' | ')}` +
          (intent.items.length > 0 ? `（参考作品「${intent.items[0].title}」不直接播放）` : ''),
      );
    }

    await syncTick();
    void step();
    return { kind: 'ack', ok: true, snapshot: store.get() };
  } catch (error) {
    const message = describeError(error);
    logger.error(`启动失败：${message}`);
    store.patch({ state: 'ERROR', running: false, lastError: message, waitingSince: null });
    await syncTick();
    await store.flush();
    return { kind: 'ack', ok: false, error: message, snapshot: store.get() };
  }
}

async function pauseTask(): Promise<ActionAck> {
  const snapshot = store.get();
  if (!snapshot.running) return { kind: 'ack', ok: false, error: '当前没有正在运行的任务' };
  logger.info('任务已暂停');
  store.patch({ paused: true, lastError: null });
  await syncTick();
  await store.flush();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function resumeTask(): Promise<ActionAck> {
  const snapshot = store.get();
  if (!snapshot.running) return { kind: 'ack', ok: false, error: '当前没有正在运行的任务' };
  logger.info('任务继续');
  store.patch({ paused: false, lastError: null });
  await syncTick();
  void step();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function skipToNext(): Promise<ActionAck> {
  const snapshot = store.get();
  if (!snapshot.running) return { kind: 'ack', ok: false, error: '当前没有正在运行的任务' };

  logger.info('手动跳到下一首');
  store.patch({
    queue: updateItem(snapshot.queue, snapshot.currentIndex, { status: 'done', error: null }),
    state: 'NEXT',
    paused: false,
    // 自增代数：当前条目可能正处在搜索/排序的 await 中途，必须让它回来时自行作废
    generation: snapshot.generation + 1,
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
    pendingCandidates: [],
  });
  await syncTick();
  void step();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function stopTask(): Promise<ActionAck> {
  logger.info('任务已停止');
  store.patch({
    state: 'IDLE',
    running: false,
    paused: false,
    generation: store.get().generation + 1,
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
    pendingCandidates: [],
  });
  await syncTick();
  await store.flush();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function clearTask(): Promise<ActionAck> {
  logger.info('播放队列已清空');
  store.patch({
    state: 'IDLE',
    running: false,
    paused: false,
    generation: store.get().generation + 1,
    queue: [],
    intent: null,
    userPrompt: '',
    discoveryIndex: 0,
    discoveryStartIndex: 0,
    pendingCandidates: [],
    currentIndex: 0,
    searchAttempt: 0,
    expandRounds: 0,
    currentBvId: null,
    waitingSince: null,
    lastHeartbeatAt: null,
    lastError: null,
  });
  await syncTick();
  await store.flush();
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

async function saveConfig(config: LlmConfig): Promise<ActionAck> {
  await saveSettings(config);
  return { kind: 'ack', ok: true, settings: await getSettings(), snapshot: store.get() };
}

async function testConfig(config: LlmConfig): Promise<ActionAck> {
  const problem = validateConfig(config);
  if (problem) return { kind: 'ack', ok: false, error: problem };

  try {
    const reply = await new LlmClient(config).testConnection();
    return { kind: 'ack', ok: true, testResult: `连接成功，模型回复：${reply || '（空）'}` };
  } catch (error) {
    return { kind: 'ack', ok: false, error: describeError(error) };
  }
}

async function clearLogs(): Promise<ActionAck> {
  clearEntries();
  store.patch({ logs: [] });
  return { kind: 'ack', ok: true, snapshot: store.get() };
}

function validateConfig(config: LlmConfig): string | null {
  if (!config.baseUrl.trim()) return '请先在 Settings 里填写 API Base URL';
  if (!config.model.trim()) return '请先在 Settings 里填写 Model Name';
  if (!config.apiKey.trim()) return '请先在 Settings 里填写 API Key（只保存在本地浏览器）';
  return null;
}

/** SW 启动后调用：恢复快照，并把中断在半途的任务接着跑下去。 */
export async function restoreOnBoot(): Promise<void> {
  await store.restore();
  const snapshot: AgentSnapshot = store.get();

  if (!snapshot.running) {
    await syncTick();
    return;
  }

  // 落盘时可能正处在等外部事件的状态，这里把控制权交回状态机。
  // 暂停与否交给 handleNext 判断：暂停只阻止"进入下一首"，不影响当前这一首走完流程。
  const resumable = ['NEXT', 'DISCOVERING', 'SEARCHING', 'RANKING', 'OPENING', 'PLAYING'].includes(
    snapshot.state,
  );
  if (resumable) {
    logger.info('检测到未完成的任务，继续调度');
    void step();
    return;
  }

  await syncTick();
}

/** 受控标签页被关闭 / 被导航到别处时调用。 */
export async function handleControlledTabLost(reason: string): Promise<void> {
  const snapshot = store.get();
  if (!snapshot.running) return;
  await pauseFor(reason);
}
