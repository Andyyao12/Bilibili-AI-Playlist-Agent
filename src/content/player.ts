import type { LogLevel } from '../types';
import { logger } from '../utils/logger';

export interface HeartbeatPayload {
  currentTime: number;
  duration: number;
  paused: boolean;
}

export interface PlayerHooks {
  onEnded: () => void;
  onPlaybackProblem: (reason: string) => void;
  onHeartbeat: (payload: HeartbeatPayload) => void;
  onNotice: (level: LogLevel, message: string) => void;
}

export interface PlayerSession {
  stop: () => void;
}

const HEARTBEAT_MS = 15_000;
const AUTOPLAY_CHECK_MS = 5_000;
/** 超过这个时长还没开始播，就判定为无法播放。 */
const AUTOPLAY_GRACE_MS = 45_000;
/** 规范给出的备选判定误差。 */
const END_THRESHOLD_SECONDS = 1;

/**
 * 播放监控。按规范要求只依赖 HTML video 的原生事件，不解析 B 站播放器的内部状态：
 *   - 主判定：ended 事件
 *   - 备选判定：currentTime >= duration - 1
 *   - 心跳：每 15s 上报一次，让 SW 知道页面还活着
 *   - 迟迟不开始播放（自动播放被拦截 / 需要登录或会员）时主动上报失败，避免队列卡死
 */
export async function startMonitoring(video: HTMLVideoElement, hooks: PlayerHooks): Promise<PlayerSession> {
  let finished = false;
  let started = false;
  let disposed = false;
  const attachedAt = Date.now();

  const finishOnce = (reason: string) => {
    if (finished || disposed) return;
    finished = true;
    logger.info(`判定播放结束：${reason}`);
    hooks.onEnded();
  };

  const failOnce = (reason: string) => {
    if (finished || disposed) return;
    finished = true;
    logger.warn(`判定播放失败：${reason}`);
    hooks.onPlaybackProblem(reason);
  };

  const handleEnded = () => finishOnce('ended 事件');
  const handlePlaying = () => {
    started = true;
  };
  const handleTimeUpdate = () => {
    if (video.currentTime > 0.5) started = true;
    const { duration, currentTime } = video;
    if (Number.isFinite(duration) && duration > 1 && currentTime >= duration - END_THRESHOLD_SECONDS) {
      finishOnce('currentTime 到达末尾');
    }
  };
  const handleError = () => failOnce(describeMediaError(video));

  video.addEventListener('ended', handleEnded);
  video.addEventListener('playing', handlePlaying);
  video.addEventListener('timeupdate', handleTimeUpdate);
  video.addEventListener('error', handleError);

  try {
    await video.play();
    if (video.currentTime > 0 || !video.paused) started = true;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError') {
      // 按规范不做静音降级（音乐场景静音毫无意义），只提示用户点一下页面
      hooks.onNotice('WARN', '浏览器阻止了自动播放，请点击页面上的视频区域一次即可开始播放');
    } else {
      hooks.onNotice('WARN', `调用 video.play() 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const heartbeat = setInterval(() => {
    if (disposed) return;
    hooks.onHeartbeat({
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
    });
  }, HEARTBEAT_MS);

  const autoplayWatch = setInterval(() => {
    if (disposed || finished || started) return;
    if (!video.paused) return;
    if (Date.now() - attachedAt < AUTOPLAY_GRACE_MS) return;
    failOnce('视频迟迟没有开始播放（可能是浏览器自动播放限制、需要登录或需要大会员）');
  }, AUTOPLAY_CHECK_MS);

  const stop = () => {
    disposed = true;
    clearInterval(heartbeat);
    clearInterval(autoplayWatch);
    video.removeEventListener('ended', handleEnded);
    video.removeEventListener('playing', handlePlaying);
    video.removeEventListener('timeupdate', handleTimeUpdate);
    video.removeEventListener('error', handleError);
  };

  return { stop };
}

function describeMediaError(video: HTMLVideoElement): string {
  const error = video.error;
  if (!error) return '视频加载失败';

  const labels: Record<number, string> = {
    1: '视频加载被中断',
    2: '网络错误导致视频加载失败',
    3: '视频解码失败',
    4: '视频不可用（可能已被删除、设为私密或受地区限制）',
  };
  return labels[error.code] ?? `视频加载失败（错误码 ${error.code}）`;
}
