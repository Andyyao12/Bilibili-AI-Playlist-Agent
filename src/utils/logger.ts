import type { LogEntry, LogLevel } from '../types';

const MAX_ENTRIES = 200;

// Vite 在构建时会把 import.meta.env 静态替换为环境对象；这里先取出再取值，
// 既能被正确替换，也能在纯 Node 环境（自测脚本）下安全降级为 false。
const buildEnv: Record<string, unknown> = import.meta.env ?? {};
const isDevBuild = Boolean(buildEnv.DEV);

/** 是否把日志镜像到控制台。Node 侧的验证脚本需要显式打开它（那里没有 Vite 的 DEV 标志）。 */
let consoleEnabled = isDevBuild;

export function enableConsoleLogging(): void {
  consoleEnabled = true;
}

/** 需要被无条件抹掉的高危片段：Authorization 头、常见密钥前缀。 */
const PATTERN_RULES: [RegExp, string][] = [
  [/(Bearer\s+)[A-Za-z0-9._-]{4,}/gi, '$1***'],
  [/(sk-)[A-Za-z0-9._-]{4,}/gi, '$1***'],
  [/("?api_?key"?\s*[:=]\s*")([^"]{2,})(")/gi, '$1***$3'],
];

/** 运行期注册的真实密钥，任何日志中出现即替换。 */
const registeredSecrets = new Set<string>();

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.trim().length >= 6) {
    registeredSecrets.add(value.trim());
  }
}

/** 对日志文本做脱敏。任何可能包含密钥的路径都必须先过这里。 */
export function redact(input: string): string {
  let output = input;
  for (const secret of registeredSecrets) {
    output = output.split(secret).join('***');
  }
  for (const [rule, replacement] of PATTERN_RULES) {
    output = output.replace(rule, replacement);
  }
  return output;
}

function emit(level: LogLevel, message: string): LogEntry {
  const entry: LogEntry = { ts: Date.now(), level, message: redact(message) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  if (consoleEnabled) {
    const line = `[bapa:${level}] ${entry.message}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.info(line);
  }
  for (const listener of listeners) listener(entry);
  return entry;
}

export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentEntries(): LogEntry[] {
  return [...entries];
}

export function clearEntries(): void {
  entries.length = 0;
}

export const logger = {
  debug: (message: string) => emit('DEBUG', message),
  info: (message: string) => emit('INFO', message),
  warn: (message: string) => emit('WARN', message),
  error: (message: string) => emit('ERROR', message),
};

/** 把 unknown 异常转成可读、已脱敏的一行文本。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  if (typeof error === 'string') return redact(error);
  return redact(JSON.stringify(error));
}
