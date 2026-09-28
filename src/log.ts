import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

const LOG_PREFIX = '[fast-jev-compaction-opencode]';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function defaultLogPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'log', 'fast-jev-compaction.log');
}

function serializeFields(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return '';
  try {
    return ' ' + JSON.stringify(fields);
  } catch {
    return ' [unserializable fields]';
  }
}

/** Append diagnostics to disk and mirror them to the host console. Never throws. */
export function createLogger(filePath = defaultLogPath()): Logger {
  const path = resolve(filePath);
  let disabled = false;
  let warned = false;

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${LOG_PREFIX} ${message}${serializeFields(fields)}`;
    const consoleMethod =
      level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;

    try {
      consoleMethod(line);
    } catch {
      // Console output is best-effort in plugin hosts.
    }

    if (disabled) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line + '\n', 'utf8');
    } catch (error) {
      disabled = true;
      if (warned) return;
      warned = true;
      try {
        console.warn(
          `[fast-jev-compaction-opencode] file logging disabled path=${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A logging failure must never affect compaction.
      }
    }
  };

  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

/** Avoid placing credentials or query values from configured endpoints in logs. */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Summarize errors without writing arbitrary server response bodies to disk. */
export function errorSummary(error: unknown): Record<string, string> {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = message.match(/\((\d{3})\)/)?.[1];

  if (httpStatus) return { errorName: name, reason: 'http-request-failed', status: httpStatus };
  if (/unreachable at /i.test(message)) return { errorName: name, reason: 'endpoint-unreachable' };
  if (/context overflow/i.test(message)) return { errorName: name, reason: 'context-overflow' };
  if (/logprobs|candidate tokens|answered none of the options/i.test(message)) {
    return { errorName: name, reason: 'invalid-classifier-response' };
  }
  if (/malformed json|no choices/i.test(message)) {
    return { errorName: name, reason: 'malformed-classifier-response' };
  }
  return { errorName: name, reason: 'classifier-error' };
}
