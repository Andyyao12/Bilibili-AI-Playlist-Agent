import type { IntentItem, QueueItem, QueueItemStatus } from '../types';

/**
 * 播放队列。按规范要求就用数组，不做数据库、不做独立队列服务。
 * 全部实现为纯函数：输入旧数组返回新数组，方便与不可变快照配合，也便于直接自测。
 */

export function createQueueItems(items: IntentItem[], startId = 1): QueueItem[] {
  return items.map((item, index) => ({
    id: startId + index,
    title: item.title,
    artist: item.artist,
    status: 'pending',
    videoUrl: null,
    videoTitle: null,
    error: null,
    source: null,
  }));
}

export function currentItem(queue: QueueItem[], index: number): QueueItem | null {
  return queue[index] ?? null;
}

export function hasCurrent(queue: QueueItem[], index: number): boolean {
  return index >= 0 && index < queue.length;
}

export function updateItem(queue: QueueItem[], index: number, patch: Partial<QueueItem>): QueueItem[] {
  if (!hasCurrent(queue, index)) return queue;
  return queue.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

export interface QueueSummary {
  total: number;
  pending: number;
  playing: number;
  done: number;
  failed: number;
}

export function summarize(queue: QueueItem[]): QueueSummary {
  const count = (status: QueueItemStatus) => queue.filter((item) => item.status === status).length;
  return {
    total: queue.length,
    pending: count('pending'),
    playing: count('playing') + count('searching'),
    done: count('done'),
    failed: count('failed'),
  };
}
