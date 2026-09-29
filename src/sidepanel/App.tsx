import { useCallback, useEffect, useState } from 'react';
import { summarize } from '../agent/queue';
import type { ActionAck, AgentSnapshot, LlmConfig, PanelCommand, StateUpdate } from '../types';
import { ControlBar, LogPanel, NowPlayingCard, PlaylistList, SettingsPanel, StatusBadge } from './components';

/** 仅用于界面刷新；agent 的存活与推进完全不依赖这个轮询（靠事件 + alarm）。 */
const POLL_INTERVAL_MS = 1500;

const FALLBACK_SETTINGS: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.3,
  maxTokens: 800,
};

const EXAMPLES = [
  '帮我播放类似《送别》那种古道、长亭、离愁、民国诗意风格的歌曲，先播放《偶然》《再别康桥》《在水一方》《涛声依旧》，之后可以继续推荐类似的',
  '帮我连续播放乔布斯经典演讲',
  '给我找一些 Claude Code 教程，优先完整、质量高的视频',
];

async function send(command: PanelCommand): Promise<ActionAck> {
  try {
    const response = (await chrome.runtime.sendMessage(command)) as ActionAck | undefined;
    if (!response) return { kind: 'ack', ok: false, error: '后台未响应，请到 chrome://extensions 重新加载扩展' };
    return response;
  } catch (error) {
    return {
      kind: 'ack',
      ok: false,
      error: error instanceof Error ? error.message : '与后台通信失败',
    };
  }
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [draft, setDraft] = useState<LlmConfig>(FALLBACK_SETTINGS);
  const [prompt, setPrompt] = useState('');
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 统一的指令出口：成功就把返回的快照立刻铺到界面上，失败就显示在横幅上。 */
  const run = useCallback(async (command: PanelCommand, successText?: string) => {
    setBusy(true);
    const ack = await send(command);
    setBusy(false);

    if (ack.snapshot) setSnapshot(ack.snapshot);
    if (ack.settings) setDraft(ack.settings);

    if (!ack.ok) {
      setBanner({ tone: 'error', text: ack.error ?? '操作失败' });
      return ack;
    }
    if (successText) setBanner({ tone: 'ok', text: successText });
    return ack;
  }, []);

  // 首屏：拉一次快照与设置
  useEffect(() => {
    void (async () => {
      const [stateAck, settingsAck] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_SETTINGS' })]);
      if (stateAck.snapshot) setSnapshot(stateAck.snapshot);
      if (settingsAck.settings) setDraft(settingsAck.settings);
    })();
  }, []);

  // 后台广播：面板打开时状态变化立刻可见
  useEffect(() => {
    const listener = (message: unknown) => {
      const update = message as StateUpdate | undefined;
      if (update?.kind === 'state' && update.snapshot) setSnapshot(update.snapshot);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // 兜底轮询，防止广播丢失导致界面停在旧状态
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const ack = await send({ type: 'GET_STATE' });
        if (ack.snapshot) setSnapshot(ack.snapshot);
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const handleStart = useCallback(async () => {
    const text = prompt.trim();
    if (!text) {
      setBanner({ tone: 'error', text: '先描述一下你想听或想看什么吧' });
      return;
    }
    setBanner(null);
    const ack = await run({ type: 'START', prompt: text }, '已开始解析需求，正在生成播放队列');
    if (ack.ok) setPrompt('');
  }, [prompt, run]);

  const queue = snapshot?.queue ?? [];
  const stats = summarize(queue);
  const lastError = snapshot?.lastError;

  return (
    <div className="app">
      <header className="header">
        <div className="header__titles">
          <h1 className="header__title">Bilibili AI Playlist Agent</h1>
          <p className="header__subtitle">用一句话描述想听什么，自动搜索、挑选并连续播放</p>
        </div>
        <StatusBadge state={snapshot?.state ?? 'IDLE'} paused={snapshot?.paused ?? false} />
      </header>

      <main className="content">
        <section className="composer">
          <label className="composer__label" htmlFor="prompt">
            你想听 / 想看什么
          </label>
          <textarea
            id="prompt"
            className="composer__input"
            rows={3}
            value={prompt}
            placeholder="例如：帮我播放类似《送别》这种古道离愁、民国诗意风格的歌，先播放《偶然》《再别康桥》《在水一方》"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void handleStart();
              }
            }}
          />
          <div className="composer__examples">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="chip"
                onClick={() => setPrompt(example)}
                title={example}
              >
                {example.length > 18 ? `${example.slice(0, 18)}…` : example}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--start" onClick={() => void handleStart()} disabled={busy}>
            {busy ? '处理中…' : '开始播放'}
          </button>
          <p className="composer__hint">Ctrl + Enter 也可提交 · 播放前请先确认已打开 Bilibili 标签页</p>
        </section>

        {banner && <p className={`feedback feedback--${banner.tone}`}>{banner.text}</p>}
        {lastError && (!banner || banner.tone !== 'error') && (
          <p className="feedback feedback--error" title={lastError}>
            {lastError}
          </p>
        )}

        <ControlBar
          snapshot={snapshot}
          onPause={() => void run({ type: 'PAUSE' }, '已暂停：当前这首播完后不会自动进入下一首')}
          onResume={() => void run({ type: 'RESUME' }, '已继续')}
          onNext={() => void run({ type: 'NEXT' }, '已跳到下一首')}
          onStop={() => void run({ type: 'STOP' }, '已停止 agent')}
          onClear={() => {
            setBanner({ tone: 'ok', text: '已清空播放队列' });
            void run({ type: 'CLEAR' });
          }}
        />

        <NowPlayingCard snapshot={snapshot} />

        <section className="section">
          <div className="section__head section__head--static">
            <span className="section__title">播放队列</span>
            <span className="section__hint">
              共 {stats.total} · 完成 {stats.done} · 失败 {stats.failed} · 待播 {stats.pending}
            </span>
          </div>
          <div className="section__body">
            <PlaylistList queue={queue} currentIndex={snapshot?.currentIndex ?? 0} />
          </div>
        </section>

        <SettingsPanel
          open={settingsOpen}
          onToggle={() => setSettingsOpen((value) => !value)}
          draft={draft}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          onSave={() => void run({ type: 'SAVE_SETTINGS', config: draft }, '设置已保存到本机')}
          onTest={() =>
            void (async () => {
              const ack = await run({ type: 'TEST_LLM', config: draft });
              setBanner(
                ack.ok
                  ? { tone: 'ok', text: ack.testResult ?? '连接成功' }
                  : { tone: 'error', text: ack.error ?? '连接失败' },
              );
            })()
          }
          busy={busy}
          message={null}
          messageTone={null}
        />

        <LogPanel
          open={logsOpen}
          onToggle={() => setLogsOpen((value) => !value)}
          logs={snapshot?.logs ?? []}
          onClear={() => void run({ type: 'CLEAR_LOGS' })}
        />

        <footer className="footer">
          开源 MVP · MIT License · 需要你自备任意 OpenAI-compatible 模型服务
        </footer>
      </main>
    </div>
  );
}
