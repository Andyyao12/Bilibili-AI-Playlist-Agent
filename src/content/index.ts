import type { HelloAck } from '../types';
import { logger } from '../utils/logger';
import { currentBvId, getVideoElement, isSearchPage, isVideoPage, waitForSearchResults } from './bilibili';
import { startMonitoring, type PlayerSession } from './player';

const RESULT_LIMIT = 15;
const SEARCH_WAIT_MS = 10_000;

let session: PlayerSession | null = null;

/**
 * content script 只做一件事：握手，然后按角色干活。
 * 拿不到角色（role === 'none'）就立刻退出，绝不触碰用户的其它标签页。
 */
async function send(message: unknown): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    // 扩展被重载、SW 尚未就绪、页面正在卸载时都会走到这里，静默忽略即可
    return null;
  }
}

async function runSearchRole(ack: HelloAck): Promise<void> {
  if (!isSearchPage()) {
    logger.warn('握手角色是 search，但当前页面不是搜索结果页，跳过');
    return;
  }

  logger.info('开始从搜索结果页提取候选');
  const candidates = await waitForSearchResults(SEARCH_WAIT_MS, RESULT_LIMIT);
  await send({ type: 'SEARCH_RESULTS', sessionId: ack.sessionId, itemId: ack.itemId, candidates });
}

async function runVideoRole(ack: HelloAck): Promise<void> {
  if (!isVideoPage()) {
    logger.warn('握手角色是 video，但当前页面不是视频页，跳过');
    return;
  }

  const pageBvId = currentBvId() ?? ack.expectedBvId;
  if (!pageBvId) {
    await send({
      type: 'VIDEO_FAILED',
      sessionId: ack.sessionId,
      itemId: ack.itemId,
      bvId: null,
      reason: '无法从页面 URL 解析出 BV 号',
    });
    return;
  }

  // B 站可能自己跳到了别的视频（首页推荐、自动连播），这时绝不能把 ended 报给 agent
  if (ack.expectedBvId && pageBvId !== ack.expectedBvId) {
    await send({
      type: 'VIDEO_NOTICE',
      sessionId: ack.sessionId,
      itemId: ack.itemId,
      level: 'WARN',
      message: `页面 BV 与期望不一致（期望 ${ack.expectedBvId}，实际 ${pageBvId}），本页不做播放监控`,
    });
    return;
  }

  const video = await getVideoElement();
  if (!video) {
    await send({
      type: 'VIDEO_FAILED',
      sessionId: ack.sessionId,
      itemId: ack.itemId,
      bvId: pageBvId,
      reason: '页面里找不到视频元素（可能已被删除、地区受限或播放器未加载）',
    });
    return;
  }

  session?.stop();
  session = await startMonitoring(video, {
    onEnded: () => {
      void send({ type: 'VIDEO_ENDED', sessionId: ack.sessionId, itemId: ack.itemId, bvId: pageBvId });
    },
    onPlaybackProblem: (reason) => {
      void send({ type: 'VIDEO_FAILED', sessionId: ack.sessionId, itemId: ack.itemId, bvId: pageBvId, reason });
    },
    onHeartbeat: ({ currentTime, duration }) => {
      void send({
        type: 'VIDEO_HEARTBEAT',
        sessionId: ack.sessionId,
        itemId: ack.itemId,
        bvId: pageBvId,
        currentTime,
        duration,
      });
    },
    onNotice: (level, message) => {
      void send({ type: 'VIDEO_NOTICE', sessionId: ack.sessionId, itemId: ack.itemId, level, message });
    },
  });

  logger.info(`开始监控播放：${document.title}`);
}

async function main(): Promise<void> {
  const ack = (await send({ type: 'CONTENT_HELLO' })) as HelloAck | null;
  if (!ack || ack.kind !== 'hello') {
    logger.debug('未收到握手响应，本页面不做任何事');
    return;
  }
  if (ack.role === 'none') {
    logger.debug(`本页面不是 agent 的目标（state=${ack.state}），不做任何事`);
    return;
  }

  if (ack.role === 'search') {
    await runSearchRole(ack);
    return;
  }
  await runVideoRole(ack);
}

window.addEventListener('pagehide', () => {
  session?.stop();
  session = null;
});

void main();
