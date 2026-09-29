import type { AgentSnapshot, AgentState, LogEntry } from '../types';
import { logger, onLogEntry, recentEntries } from '../utils/logger';
import { getSnapshot, saveSnapshot } from '../utils/storage';

export function createInitialSnapshot(): AgentSnapshot {
  return {
    sessionId: crypto.randomUUID(),
    state: 'IDLE',
    running: false,
    paused: false,
    controlledTabId: null,
    currentBvId: null,
    currentIndex: 0,
    queue: [],
    intent: null,
    userPrompt: '',
    pendingCandidates: [],
    expandRounds: 0,
    searchAttempt: 0,
    discoveryIndex: 0,
    discoveryStartIndex: 0,
    generation: 0,
    waitingSince: null,
    lastHeartbeatAt: null,
    lastError: null,
    logs: [],
    updatedAt: Date.now(),
  };
}

const PERSIST_DEBOUNCE_MS = 250;

/**
 * Agent 状态的唯一持有者。
 * 每次变更都会：① 更新内存快照 ② 防抖写入 chrome.storage.session ③ 广播给 side panel。
 *
 * 之所以要落盘到 session storage：MV3 的 service worker 随时可能被浏览器回收，
 * 而播放队列必须在 SW 重启后继续调度（用户关掉 Side Panel 也不能影响播放）。
 */
export class AgentStore {
  private snapshot: AgentSnapshot = createInitialSnapshot();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcaster: ((snapshot: AgentSnapshot) => void) | null = null;
  private unsubscribeLog: (() => void) | null = null;

  /** SW 启动时调用：从 session storage 恢复上一次的快照。 */
  async restore(): Promise<AgentSnapshot> {
    const stored = await getSnapshot();

    if (stored) {
      this.snapshot = { ...stored, logs: recentEntries() };
      logger.info(
        `从 session storage 恢复快照：state=${stored.state} running=${stored.running} 队列 ${stored.queue.length} 项，当前第 ${stored.currentIndex + 1} 项`,
      );
    }

    this.unsubscribeLog?.();
    this.unsubscribeLog = onLogEntry(() => this.schedulePersist());

    return this.snapshot;
  }

  get(): AgentSnapshot {
    return this.snapshot;
  }

  patch(changes: Partial<AgentSnapshot>): AgentSnapshot {
    this.snapshot = { ...this.snapshot, ...changes, updatedAt: Date.now() };
    this.schedulePersist();
    this.broadcast();
    return this.snapshot;
  }

  setState(state: AgentState): AgentSnapshot {
    if (this.snapshot.state === state) return this.snapshot;
    logger.debug(`状态迁移 ${this.snapshot.state} -> ${state}`);
    return this.patch({ state });
  }

  /** 进入等待外部事件的阶段，记录起始时刻供 watchdog 使用。 */
  markWaiting(): AgentSnapshot {
    return this.patch({ waitingSince: Date.now() });
  }

  setBroadcaster(broadcaster: ((snapshot: AgentSnapshot) => void) | null): void {
    this.broadcaster = broadcaster;
  }

  /** 立即落盘（在停止、出错、SW 即将闲置等关键点调用）。 */
  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const logs: LogEntry[] = recentEntries();
    this.snapshot = { ...this.snapshot, logs };
    try {
      await saveSnapshot(this.snapshot);
    } catch (error) {
      // 落盘失败不能影响播放主链路，仅记录
      logger.warn(`快照落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private broadcast(): void {
    this.broadcaster?.(this.snapshot);
  }
}

export const store = new AgentStore();
