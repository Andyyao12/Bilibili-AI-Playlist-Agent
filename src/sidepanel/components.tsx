import { useEffect, useRef, useState } from 'react';
import type { AgentSnapshot, LlmConfig, LogEntry, QueueItem } from '../types';
import { STATE_LABEL, STATE_TONE } from '../types';

/* ---------------- 状态徽章 ---------------- */

export function StatusBadge({ state, paused }: { state: AgentSnapshot['state']; paused: boolean }) {
  const tone = STATE_TONE[state];
  return (
    <span className={`badge badge--${tone}`} title={`agent 当前状态：${STATE_LABEL[state]}`}>
      <span className="badge__dot" />
      {paused ? '已暂停' : STATE_LABEL[state]}
    </span>
  );
}

/* ---------------- 控制条 ---------------- */

interface ControlBarProps {
  snapshot: AgentSnapshot | null;
  onPause: () => void;
  onResume: () => void;
  onNext: () => void;
  onStop: () => void;
  onClear: () => void;
}

export function ControlBar({ snapshot, onPause, onResume, onNext, onStop, onClear }: ControlBarProps) {
  const running = snapshot?.running ?? false;
  const paused = snapshot?.paused ?? false;
  const hasQueue = (snapshot?.queue.length ?? 0) > 0;

  return (
    <div className="controlbar">
      <button
        type="button"
        className={`ctrl ctrl--primary ${running && !paused ? '' : 'ctrl--idle'}`}
        onClick={paused ? onResume : onPause}
        disabled={!running}
        title={paused ? '继续自动播放' : '暂停后不再自动进入下一首'}
      >
        <span className="ctrl__icon">{paused ? '▶' : '❚❚'}</span>
        <span className="ctrl__text">{paused ? '继续' : '暂停'}</span>
      </button>

      <button
        type="button"
        className={`ctrl ${running ? '' : 'ctrl--idle'}`}
        onClick={onNext}
        disabled={!running}
        title="立即跳到下一首"
      >
        <span className="ctrl__icon">⏭</span>
        <span className="ctrl__text">下一首</span>
      </button>

      <button
        type="button"
        className={`ctrl ctrl--danger ${running ? '' : 'ctrl--idle'}`}
        onClick={onStop}
        disabled={!running}
        title="停止 agent（不清空队列）"
      >
        <span className="ctrl__icon">■</span>
        <span className="ctrl__text">停止</span>
      </button>

      <button
        type="button"
        className={`ctrl ${hasQueue ? '' : 'ctrl--idle'}`}
        onClick={onClear}
        disabled={!hasQueue}
        title="清空播放队列"
      >
        <span className="ctrl__icon">🗑</span>
        <span className="ctrl__text">清空</span>
      </button>
    </div>
  );
}

/* ---------------- Now Playing ---------------- */

export function NowPlayingCard({ snapshot }: { snapshot: AgentSnapshot | null }) {
  const item = snapshot?.queue[snapshot.currentIndex] ?? null;
  const state = snapshot?.state ?? 'IDLE';
  const tone = STATE_TONE[state];
  const failed = item?.status === 'failed';
  const picking = state === 'PARSING_INTENT' || state === 'DISCOVERING';
  const picked = snapshot?.queue.length ?? 0;

  const detail = snapshot?.running
    ? failed
      ? item?.error ?? '当前条目的视频不可用'
      : state === 'PARSING_INTENT'
        ? '正在理解你的需求，准备搜索计划'
        : state === 'DISCOVERING'
          ? `正在搜索并挑选内容${picked > 0 ? `，已选 ${picked} 项` : ''}`
          : state === 'SEARCHING'
            ? '正在 Bilibili 搜索并挑选最合适的视频'
            : state === 'RANKING'
              ? '正在对候选视频排序'
              : state === 'PLAYING'
                ? '播放中，结束后自动进入下一首'
                : STATE_LABEL[state]
    : '在下方描述你想听的内容，然后点击开始';

  return (
    <section className={`nowplaying ${failed ? 'nowplaying--failed' : ''} nowplaying--${tone}`}>
      <div className="nowplaying__top">
        <div className="nowplaying__info">
          <p className="nowplaying__eyebrow">NOW PLAYING</p>
          <h2 className="nowplaying__title" title={item?.title ?? ''}>
            {item ? item.title : picking ? '正在挑选中…' : '尚未开始'}
          </h2>
          <p className="nowplaying__detail">{detail}</p>
        </div>
        <StateFigure tone={tone} />
      </div>

      {item?.videoTitle && (
        <div className="nowplaying__video">
          <span className="nowplaying__video-label">已选视频</span>
          <span className="nowplaying__video-title" title={item.videoTitle}>
            {item.videoTitle}
          </span>
          {item.source && (
            <span className={`tag tag--${item.source}`}>
              {item.source === 'cache' ? '缓存命中' : item.source === 'llm' ? 'AI 选片' : '本地规则降级'}
            </span>
          )}
        </div>
      )}

      {item?.videoUrl && (
        <a className="nowplaying__link" href={item.videoUrl} target="_blank" rel="noreferrer">
          打开视频页 ↗
        </a>
      )}
    </section>
  );
}

function StateFigure({ tone }: { tone: 'idle' | 'busy' | 'playing' | 'done' | 'error' }) {
  if (tone === 'busy') return <span className="figure figure--spinner" aria-hidden />;
  if (tone === 'playing') {
    return (
      <span className="figure figure--bars" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (tone === 'error') return <span className="figure figure--error">!</span>;
  if (tone === 'done') return <span className="figure figure--done">✓</span>;
  return <span className="figure figure--idle">♪</span>;
}

/* ---------------- 播放队列 ---------------- */

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  pending: '待播放',
  searching: '查找中',
  playing: '播放中',
  done: '已完成',
  failed: '失败',
};

export function PlaylistList({ queue, currentIndex }: { queue: QueueItem[]; currentIndex: number }) {
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentIndex, queue.length]);

  if (queue.length === 0) {
    return <p className="empty">还没有播放队列。描述一句需求，agent 会解析出清单并逐个播放。</p>;
  }

  return (
    <ol className="playlist">
      {queue.map((item, index) => (
        <li
          key={item.id}
          ref={index === currentIndex ? activeRef : null}
          className={`playlist__item playlist__item--${item.status} ${index === currentIndex ? 'playlist__item--current' : ''}`}
        >
          <span className="playlist__index">{index + 1}</span>
          <span className="playlist__body">
            <span className="playlist__title" title={item.title}>
              {item.title}
            </span>
            {item.artist && <span className="playlist__artist">{item.artist}</span>}
            {item.status === 'failed' && item.error && <span className="playlist__error">{item.error}</span>}
          </span>
          <span className="playlist__status">{STATUS_LABEL[item.status]}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- 设置 ---------------- */

interface SettingsPanelProps {
  open: boolean;
  onToggle: () => void;
  draft: LlmConfig;
  onChange: (patch: Partial<LlmConfig>) => void;
  onSave: () => void;
  onTest: () => void;
  busy: boolean;
  message: string | null;
  messageTone: 'ok' | 'error' | null;
}

export function SettingsPanel({
  open,
  onToggle,
  draft,
  onChange,
  onSave,
  onTest,
  busy,
  message,
  messageTone,
}: SettingsPanelProps) {
  const [revealKey, setRevealKey] = useState(false);

  return (
    <section className="section">
      <button type="button" className="section__head" onClick={onToggle} aria-expanded={open}>
        <span className="section__title">LLM 设置</span>
        <span className="section__hint">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="section__body">
          <p className="notice">
            密钥只保存在本机浏览器（chrome.storage.local），仅会发送到你自己填写的模型服务地址，插件没有自建后端。
          </p>

          <label className="field">
            <span className="field__label">API Base URL</span>
            <input
              className="field__input"
              type="text"
              spellCheck={false}
              value={draft.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">API Key</span>
            <span className="field__row">
              <input
                className="field__input"
                type={revealKey ? 'text' : 'password'}
                spellCheck={false}
                autoComplete="off"
                value={draft.apiKey}
                placeholder="sk-..."
                onChange={(event) => onChange({ apiKey: event.target.value })}
              />
              <button type="button" className="field__toggle" onClick={() => setRevealKey((value) => !value)}>
                {revealKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <label className="field">
            <span className="field__label">Model Name</span>
            <input
              className="field__input"
              type="text"
              spellCheck={false}
              value={draft.model}
              placeholder="gpt-4o-mini / deepseek-chat / qwen3"
              onChange={(event) => onChange({ model: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">
              temperature <b>{draft.temperature.toFixed(1)}</b>
            </span>
            <input
              className="field__range"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => onChange({ temperature: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field__label">max_tokens</span>
            <input
              className="field__input"
              type="number"
              min={64}
              max={8000}
              step={64}
              value={draft.maxTokens}
              onChange={(event) => onChange({ maxTokens: Number(event.target.value) })}
            />
          </label>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={onSave} disabled={busy}>
              保存
            </button>
            <button type="button" className="btn" onClick={onTest} disabled={busy}>
              测试连接
            </button>
          </div>

          {message && <p className={`feedback feedback--${messageTone ?? 'ok'}`}>{message}</p>}
        </div>
      )}
    </section>
  );
}

/* ---------------- 日志 ---------------- */

export function LogPanel({
  open,
  onToggle,
  logs,
  onClear,
}: {
  open: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  onClear: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [logs, open]);

  return (
    <section className="section">
      <button type="button" className="section__head" onClick={onToggle} aria-expanded={open}>
        <span className="section__title">运行日志</span>
        <span className="section__hint">{open ? `收起（${logs.length}）` : `展开（${logs.length}）`}</span>
      </button>

      {open && (
        <div className="section__body">
          <div className="logbox" ref={boxRef}>
            {logs.length === 0 && <p className="logbox__empty">暂无日志</p>}
            {logs.map((entry, index) => (
              <p key={`${entry.ts}-${index}`} className={`logbox__line logbox__line--${entry.level}`}>
                <span className="logbox__time">{formatTime(entry.ts)}</span>
                <span className="logbox__level">{entry.level}</span>
                {entry.message}
              </p>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={onClear} disabled={logs.length === 0}>
              清空日志
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
