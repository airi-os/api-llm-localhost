const MAX_ENTRIES = 500;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

let nextId = 1;
const buffer: LogEntry[] = [];

function push(level: LogLevel, args: unknown[]) {
  const message = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  buffer.push({ id: nextId++, timestamp: new Date().toISOString(), level, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args: unknown[]) => { origLog(...args); push('info', args); };
console.warn = (...args: unknown[]) => { origWarn(...args); push('warn', args); };
console.error = (...args: unknown[]) => { origError(...args); push('error', args); };

export function getLogs(limit = MAX_ENTRIES): LogEntry[] {
  const entries = buffer.slice(-limit);
  return entries.reverse();
}
