/**
 * 全局类型与消息协议。
 * 这些结构被 SW / content script / side panel 三端共享，是全项目唯一的契约来源。
 */

/** 状态在界面上的中文标签（放在这里是为了让 SW 与 Side Panel 共用同一份，且不引入运行时依赖）。 */
export const STATE_LABEL: Record<AgentState, string> = {
  IDLE: '待启动',
  PARSING_INTENT: '解析需求',
  DISCOVERING: '挑选内容',
  SEARCHING: '搜索中',
  RANKING: '排序中',
  OPENING: '打开视频',
  PLAYING: '播放中',
  NEXT: '切换下一首',
  FINISHED: '已完成',
  ERROR: '出错',
};

/** 状态徽章的颜色分组。 */
export const STATE_TONE: Record<AgentState, 'idle' | 'busy' | 'playing' | 'done' | 'error'> = {
  IDLE: 'idle',
  PARSING_INTENT: 'busy',
  DISCOVERING: 'busy',
  SEARCHING: 'busy',
  RANKING: 'busy',
  OPENING: 'busy',
  PLAYING: 'playing',
  NEXT: 'busy',
  FINISHED: 'done',
  ERROR: 'error',
};

export type AgentState =
  | 'IDLE'
  | 'PARSING_INTENT'
  /** 用户没给具体作品时，先搜索 + 排序，把播放队列搭出来 */
  | 'DISCOVERING'
  | 'SEARCHING'
  | 'RANKING'
  | 'OPENING'
  | 'PLAYING'
  | 'NEXT'
  | 'FINISHED'
  | 'ERROR';

export type MediaType = 'music' | 'speech' | 'tutorial' | 'documentary' | 'movie' | 'general_video';

/**
 * 意图模式：
 * - explicit_playlist：用户点名了具体作品，直接按清单播
 * - discovery：用户只给了歌手/风格/主题/场景，先搜索发现再构建队列
 * - hybrid：用户给了一个参考作品，同时想要类似内容
 */
export type IntentMode = 'explicit_playlist' | 'discovery' | 'hybrid';

/**
 * 播放单位粒度。
 * - single：一首歌 / 一个视频算一项（音乐 discovery 的默认值）
 * - collection：用户明确要合集、歌单、串烧、N 首精选
 */
export type ContentGranularity = 'single' | 'collection';

/** LLM 返回的单个待播放条目。 */
export interface IntentItem {
  title: string;
  artist: string | null;
}

/** LLM 对用户自然语言需求的解析结果。 */
export interface Intent {
  task: 'media_playlist';
  mode: IntentMode;
  media_type: MediaType;
  /** 播放单位粒度，决定是否把「合集 / 歌单 / 串烧」当成合格候选 */
  granularity: ContentGranularity;
  /**
   * 仅 hybrid 有意义：是否把参考作品本身也播一遍。
   * 「播放类似《送别》的歌」-> false（《送别》只作参考，不默认播放）
   * 「先播放《送别》，然后推荐类似的」-> true
   */
  play_reference: boolean;
  /** 用户明确点名的作品。discovery 模式下为空数组，这不是错误。 */
  items: IntentItem[];
  /** 可直接放进 B 站搜索框的关键词，1~3 条 */
  search_queries: string[];
  topic: string;
  creator: string;
  style: string[];
  keywords: string[];
  preferred: string[];
  avoid: string[];
  auto_expand: boolean;
  /** 期望的队列长度，默认 5 */
  target_count: number;
}

/** 从搜索页 DOM 提取出的候选视频。字段缺失一律为 null，不编造。 */
export interface Candidate {
  title: string;
  /** 已归一化为 https://www.bilibili.com/video/BV... */
  url: string;
  author: string | null;
  duration: string | null;
  views: string | null;
  description: string | null;
}

/** 经过规则打分与截断后、准备发给 LLM 排序的候选。 */
export interface ScoredCandidate extends Candidate {
  durationSeconds: number | null;
  ruleScore: number;
  /** 1 起的序号，即发给 LLM 的候选编号 */
  rank: number;
}

export type QueueItemStatus = 'pending' | 'searching' | 'playing' | 'done' | 'failed';

/** 选片来源，用于向用户标明是否发生了 LLM 降级。 */
export type SelectionSource = 'cache' | 'llm' | 'fallback';

export interface QueueItem {
  id: number;
  title: string;
  artist: string | null;
  status: QueueItemStatus;
  videoUrl: string | null;
  videoTitle: string | null;
  error: string | null;
  source: SelectionSource | null;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

/** 落盘（chrome.storage.session）的 Agent 全量快照，用于 SW 重启后恢复。 */
export interface AgentSnapshot {
  sessionId: string;
  state: AgentState;
  running: boolean;
  paused: boolean;
  /** 受控标签页，启动任务时绑定，之后不再操作其他标签页 */
  controlledTabId: number | null;
  /** 当前正在播放/搜索的 BV 号，用于校验消息来源，防止重复消费 ended */
  currentBvId: string | null;
  currentIndex: number;
  queue: QueueItem[];
  /** 解析出的意图。SW 重启后仍需要它来做候选排序与队列扩展，所以一并落盘。 */
  intent: Intent | null;
  /** 用户原始需求文本，发现式排序时直接作为需求描述交给 LLM */
  userPrompt: string;
  /** 已从搜索页取回、等待排序的候选。落盘后 RANKING 阶段也可恢复。 */
  pendingCandidates: Candidate[];
  /** 已完成的自动扩展轮数，最多 1 轮，避免无限推荐 */
  expandRounds: number;
  /** 当前条目的搜索次数，最多 2 次 */
  searchAttempt: number;
  /** DISCOVERING 阶段正在使用第几个 search_query */
  discoveryIndex: number;
  /** 本轮发现式搜索从队列的哪个下标开始追加，播完参考作品后从它开始播 */
  discoveryStartIndex: number;
  /**
   * 用户干预代数。START / NEXT / STOP / CLEAR 时自增。
   * 异步流程在 await 之后会用这个值自检：如果代数变了，说明用户已经改变了播放目标，
   * 本次结果必须丢弃，否则会出现"用户点了下一个，却被上一个条目的遗留流程覆盖"的竞态。
   */
  generation: number;
  /**
   * 进入「等待外部事件」阶段的时刻。
   * SW 可能被浏览器回收，普通 setTimeout 会随之丢失，所以超时判断只依赖这个时间戳 + alarms。
   */
  waitingSince: number | null;
  /** 最近一次收到视频心跳的时刻，用于检测播放器静默卡死 */
  lastHeartbeatAt: number | null;
  lastError: string | null;
  logs: LogEntry[];
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 消息协议                                                            */
/* ------------------------------------------------------------------ */

/** side panel -> service worker */
export type PanelCommand =
  | { type: 'START'; prompt: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'NEXT' }
  | { type: 'STOP' }
  | { type: 'CLEAR' }
  | { type: 'GET_STATE' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; config: LlmConfig }
  | { type: 'TEST_LLM'; config: LlmConfig }
  | { type: 'CLEAR_LOGS' };

/**
 * content script -> service worker。
 * 所有事件都带上 content script 从 CONTENT_HELLO 拿到的 sessionId，
 * SW 侧同时校验 sessionId + sender.tab.id + bvId，防止重复消费播放结束事件。
 */
export type ContentEvent =
  | { type: 'CONTENT_HELLO' }
  | { type: 'SEARCH_RESULTS'; sessionId: string | null; itemId: number | null; candidates: Candidate[] }
  | { type: 'VIDEO_ENDED'; sessionId: string | null; itemId: number | null; bvId: string }
  | { type: 'VIDEO_FAILED'; sessionId: string | null; itemId: number | null; bvId: string | null; reason: string }
  | {
      type: 'VIDEO_HEARTBEAT';
      sessionId: string | null;
      itemId: number | null;
      bvId: string;
      currentTime: number;
      duration: number;
    }
  | { type: 'VIDEO_NOTICE'; sessionId: string | null; itemId: number | null; level: LogLevel; message: string };

export type IncomingMessage = PanelCommand | ContentEvent;

/** CONTENT_HELLO 的响应：告知 content script 本次该扮演什么角色。 */
export interface HelloAck {
  kind: 'hello';
  /**
   * search -> 收集搜索结果
   * video  -> 挂播放器并上报 ended / failed
   * none   -> 立即退出，绝不动用户的其它页面
   */
  role: 'search' | 'video' | 'none';
  sessionId: string | null;
  /** 本次握手对应的队列条目 id，content script 必须原样回传，用于丢弃过期页面的消息 */
  itemId: number | null;
  state: AgentState;
  /** 视频页期望的 BV 号，不匹配说明页面已经被用户或 B 站自己导走了 */
  expectedBvId: string | null;
}

/** 普通指令的通用回执。 */
export interface ActionAck {
  kind: 'ack';
  ok: boolean;
  error?: string;
  snapshot?: AgentSnapshot;
  settings?: LlmConfig;
  /** TEST_LLM 的结果文案 */
  testResult?: string;
}

/** SW 主动向 side panel 广播的新快照。 */
export interface StateUpdate {
  kind: 'state';
  snapshot: AgentSnapshot;
}

export type ResponseMessage = HelloAck | ActionAck | StateUpdate;
