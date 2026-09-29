import type { Candidate } from '../types';
import { logger } from '../utils/logger';
import { normalizeVideoUrl } from '../utils/text';

/**
 * Bilibili DOM Adapter —— 全项目唯一允许出现 B 站 selector 的文件。
 *
 * 维护约定：
 *   1. B 站改版时只改这里，其它文件不得内联任何 selector。
 *   2. 严禁使用 data-v-* 属性，它们是构建期 scoped CSS 哈希，每次发版都会变。
 *   3. 每个目标都给出多级 fallback，优先用「语义稳定」的 class 与链接特征。
 *
 * 下面的主 selector 已在 2026-09 的真实搜索页 HTML 上实测确认。
 */

/** 搜索结果卡片容器。 */
const CARD_SELECTORS = ['.bili-video-card', '.search-page-video-list .bili-video-card', '.video-list .bili-video-card'];

/** 广告位容器，里面的卡片要排除。 */
const AD_CONTAINER_SELECTORS = '.brand-ad-list, .ad-report, .search-all-list.ad-report';

const TITLE_SELECTORS = ['.bili-video-card__info--tit', '.bili-video-card__info--right h3', 'h3[title]'];

const AUTHOR_SELECTORS = ['.bili-video-card__info--author', '.bili-video-card__info--owner span', '.up-name'];

const DURATION_SELECTORS = ['.bili-video-card__stats__duration', '.bili-video-card__stats--duration', '.duration'];

const VIEWS_SELECTORS = [
  '.bili-video-card__stats--left .bili-video-card__stats--item:first-child span',
  '.bili-video-card__stats--item span',
];

const LINK_SELECTORS = ['.bili-video-card__wrap a[href*="/video/BV"]', '.bili-video-card__info--right a[href*="/video/BV"]', 'a[href*="/video/BV"]'];

/**
 * 播放器 video 元素。主播放器在顶层 document，不在 iframe 内，
 * 但 B 站历史上换过几套播放器容器 class，所以逐级回退。
 */
const VIDEO_ELEMENT_SELECTORS = [
  '#bilibili-player video',
  '.bpx-player-video-wrap video',
  '.bpx-player-container video',
  '#bilibili-player-video video',
  '.bilibili-player-video video',
];

const DEFAULT_RESULT_LIMIT = 15;

export function isSearchPage(): boolean {
  return location.hostname === 'search.bilibili.com' || location.pathname.startsWith('/search');
}

export function isVideoPage(): boolean {
  return /\/video\/BV[0-9A-Za-z]{8,14}/.test(location.pathname);
}

/** 当前页面的 BV 号，用于校验 agent 期望的条目。 */
export function currentBvId(): string | null {
  return location.pathname.match(/\/video\/(BV[0-9A-Za-z]{8,14})/)?.[1] ?? null;
}

function pick(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

/** 优先读 title 属性（干净文本），否则退回可见文本。 */
function readText(root: ParentNode, selectors: string[]): string | null {
  const element = pick(root, selectors);
  if (!element) return null;
  const raw = element.getAttribute('title') ?? element.textContent ?? '';
  const value = raw.replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value : null;
}

function collectCards(): Element[] {
  for (const selector of CARD_SELECTORS) {
    const cards = [...document.querySelectorAll(selector)].filter(
      (card) => !card.closest(AD_CONTAINER_SELECTORS),
    );
    if (cards.length > 0) return cards;
  }
  return [];
}

/** 从搜索页提取候选视频。字段缺失一律为 null，绝不编造。 */
export function searchResults(limit = DEFAULT_RESULT_LIMIT): Candidate[] {
  const candidates: Candidate[] = [];
  const seenBv = new Set<string>();

  for (const card of collectCards()) {
    const link = pick(card, LINK_SELECTORS);
    const url = normalizeVideoUrl(link?.getAttribute('href') ?? null);
    if (!url) continue;

    const bvId = url.split('/').pop() ?? url;
    if (seenBv.has(bvId)) continue;
    seenBv.add(bvId);

    candidates.push({
      title: readText(card, TITLE_SELECTORS) ?? '',
      url,
      author: readText(card, AUTHOR_SELECTORS),
      duration: readText(card, DURATION_SELECTORS),
      views: readText(card, VIEWS_SELECTORS),
      // 搜索卡片本身不提供简介，规范允许为 null，不为此额外调接口
      description: null,
    });

    if (candidates.length >= limit) break;
  }

  logger.debug(`DOM 提取：命中 ${candidates.length} 条候选`);
  return candidates.filter((candidate) => candidate.title.length > 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等待搜索结果出现。搜索页是服务端渲染，通常第一次就能拿到；
 * 保留轮询是为了兼容 SPA 二次渲染与网络较慢的情况。
 */
export async function waitForSearchResults(timeoutMs = 10_000, limit = DEFAULT_RESULT_LIMIT): Promise<Candidate[]> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const results = searchResults(limit);
    if (results.length > 0) return results;
    lastCount = results.length;
    await sleep(250);
  }

  logger.warn(`等待搜索结果超时（${timeoutMs}ms，最后命中 ${lastCount} 条）`);
  return [];
}

const videoArea = (video: HTMLVideoElement): number => {
  const rect = video.getBoundingClientRect();
  return rect.width * rect.height;
};

/** 找主播放器。找不到专用容器时，退化为「面积最大的 video」，以此排除悬停预览小窗。 */
export function findVideoElement(): HTMLVideoElement | null {
  for (const selector of VIDEO_ELEMENT_SELECTORS) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLVideoElement) return element;
  }

  const videos = [...document.querySelectorAll('video')].filter(
    (element): element is HTMLVideoElement => element instanceof HTMLVideoElement,
  );
  if (videos.length === 0) return null;
  return videos.sort((a, b) => videoArea(b) - videoArea(a))[0] ?? null;
}

/**
 * 按 500ms / 1s / 2s / 3s 退避重试地等待 video 元素出现。
 * 规范要求「页面没有 video 就重试若干秒，失败后进入 FAILED 并跳下一首」。
 */
export async function getVideoElement(delays: number[] = [500, 1000, 2000, 3000]): Promise<HTMLVideoElement | null> {
  const immediate = findVideoElement();
  if (immediate) return immediate;

  for (const delay of delays) {
    await sleep(delay);
    const video = findVideoElement();
    if (video) return video;
  }
  return null;
}
