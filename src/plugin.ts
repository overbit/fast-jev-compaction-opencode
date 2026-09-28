import { Plugin } from '@opencode/plugin';

import { JevClient } from './client.js';
import { compact, reductionRatio, resolveOptions } from './compact.js';
import { LOCAL_BASE_URL, LOCAL_MODEL, LocalJevAsker } from './local.js';
import { createLogger, defaultLogPath, errorSummary, safeUrl, type Logger } from './log.js';
import { collectToolCalls } from './state.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from './types.js';

type Backend = 'typesafe' | 'local';
type PluginOptions = Record<string, unknown>;

type NativeTextPart = {
  type: 'text';
  text: string;
  [key: string]: unknown;
};

type NativeToolCallPart = {
  type: 'tool-call';
  id: string;
  name: string;
  input: unknown;
  [key: string]: unknown;
};

type NativeToolResultPart = {
  type: 'tool-result';
  id: string;
  result: {
    type: string;
    value?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type NativePart =
  | NativeTextPart
  | NativeToolCallPart
  | NativeToolResultPart
  | { type: string; [key: string]: unknown };

export type NativeMessage = {
  id?: string;
  role: string;
  content: NativePart[];
  [key: string]: unknown;
};

export interface FastJevConfig extends CompactOptions {
  backend: Backend;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  localModel?: string;
  localBaseUrl?: string;
  logFile?: string;
  localConcurrency: number;
  localContextTokens: number;
  minReductionRatio: number;
}

const DEFAULTS = {
  backend: 'typesafe' as const,
  localConcurrency: 2,
  localContextTokens: 64_000,
  minReductionRatio: 0.25,
};

function stringOption(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOption(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveConfig(options: PluginOptions = {}): FastJevConfig {
  const backend = options.backend === 'local' ? 'local' : 'typesafe';
  const config: FastJevConfig = {
    backend,
    localConcurrency: Math.max(1, Math.floor(numberOption(options, 'localConcurrency', DEFAULTS.localConcurrency))),
    localContextTokens: Math.max(1, numberOption(options, 'localContextTokens', DEFAULTS.localContextTokens)),
    minReductionRatio: Math.max(0, Math.min(1, numberOption(options, 'minReductionRatio', DEFAULTS.minReductionRatio))),
  };

  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }

  for (const key of ['apiKey', 'model', 'baseUrl', 'localModel', 'localBaseUrl', 'logFile', 'goal'] as const) {
    const value = stringOption(options, key);
    if (value) config[key] = value;
  }

  return config;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inputOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function isText(part: NativePart): part is NativeTextPart {
  return part.type === 'text' && typeof (part as NativeTextPart).text === 'string';
}

function isToolCall(part: NativePart): part is NativeToolCallPart {
  return (
    part.type === 'tool-call' &&
    typeof (part as NativeToolCallPart).id === 'string' &&
    typeof (part as NativeToolCallPart).name === 'string'
  );
}

function isToolResult(part: NativePart): part is NativeToolResultPart {
  return (
    part.type === 'tool-result' &&
    typeof (part as NativeToolResultPart).id === 'string' &&
    !!(part as NativeToolResultPart).result &&
    typeof (part as NativeToolResultPart).result === 'object'
  );
}

function resultInfo(part: NativeToolResultPart): { text: string; isError: boolean } {
  const value = part.result.value;
  return {
    text: value === undefined ? textOf(part.result) : textOf(value),
    isError: part.result.type === 'error',
  };
}

/**
 * Adapts OpenCode V2 model messages to the transport-neutral transcript used by
 * the upstream fast-JEV compaction core. Tool-result-only messages are treated
 * as user turns because the core models Claude-style tool results that way.
 */
export function toCompactionMessages(messages: readonly NativeMessage[]): Message[] {
  return messages.flatMap((message) => {
    const toolUses = message.content.filter(isToolCall).map((part) => ({
      tool_use_id: part.id,
      tool: part.name,
      input: inputOf(part.input),
    }));
    const toolResults = message.content.filter(isToolResult).map((part) => {
      const result = resultInfo(part);
      return {
        tool_use_id: part.id,
        text: result.text,
        isError: result.isError,
      };
    });
    const text =
      message.role === 'user' || message.role === 'assistant'
        ? message.content.filter(isText).map((part) => part.text).join('\n')
        : '';

    if (text.length === 0 && toolUses.length === 0 && toolResults.length === 0) return [];

    const adapted: Message = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text,
      toolUses,
    };
    if (toolResults.length > 0) adapted.toolResults = toolResults;
    return [adapted];
  });
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * OpenCode V2's compaction override accepts a summary string rather than an
 * arbitrary replacement message list. Serialize the JEV-pruned transcript
 * deterministically, keeping retained user/assistant text and tool output
 * verbatim instead of asking another model to rewrite it.
 */
export function serializeCompaction(messages: readonly Message[]): string {
  const out: string[] = [
    '[fast-jev-compaction checkpoint: retained conversation follows verbatim; no model summary was generated]',
  ];

  for (const message of messages) {
    out.push('', '<' + message.role + '>');
    if (message.text.length > 0) out.push(message.text);

    for (const tool of message.toolUses) {
      out.push('[tool-call id=' + tool.tool_use_id + ' name=' + tool.tool + ']');
      out.push(json(tool.input));
      if (tool.text !== undefined) {
        out.push('[tool-result id=' + tool.tool_use_id + (tool.isError ? ' error=true' : '') + ']');
        out.push(tool.text);
      }
    }

    for (const result of message.toolResults ?? []) {
      if (message.toolUses.some((tool) => tool.tool_use_id === result.tool_use_id)) continue;
      out.push('[tool-result id=' + result.tool_use_id + (result.isError ? ' error=true' : '') + ']');
      out.push(result.text);
    }

    out.push('</' + message.role + '>');
  }

  return out.join('\n');
}

function partCensus(messages: readonly NativeMessage[]): {
  roles: Record<string, number>;
  parts: Record<string, number>;
} {
  const roles: Record<string, number> = Object.create(null) as Record<string, number>;
  const parts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const message of messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    for (const part of message.content) parts[part.type] = (parts[part.type] ?? 0) + 1;
  }
  return { roles, parts };
}

function createAsker(config: FastJevConfig, logger: Logger): JevAsker {
  if (config.backend === 'local') {
    return new LocalJevAsker({
      baseUrl: config.localBaseUrl,
      model: config.localModel,
      concurrency: config.localConcurrency,
      contextTokens: config.localContextTokens,
      onDecision: (name, probability) => {
        logger.info('classifier decision', { question: name, noul: probability });
      },
      fetch: async (url, init) => {
        const started = Date.now();
        logger.info('classifier request', { method: init.method, url: safeUrl(url) });
        try {
          const response = await fetch(url, init);
          const text = await response.text();
          logger.info('classifier response', {
            status: response.status,
            ok: response.ok,
            durationMs: Date.now() - started,
          });
          return { status: response.status, ok: response.ok, text };
        } catch (error) {
          logger.warn('classifier transport error', {
            durationMs: Date.now() - started,
            ...errorSummary(error),
          });
          throw error;
        }
      },
    });
  }

  return new JevClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
  });
}

export async function runOpenCodeCompaction(
  messages: readonly NativeMessage[],
  asker: JevAsker,
  config: FastJevConfig,
): Promise<CompactResult | undefined> {
  const transcript = toCompactionMessages(messages);
  if (transcript.length === 0) return;
  return compact(transcript, asker, config);
}

export async function compactOpenCodeMessages(
  messages: readonly NativeMessage[],
  asker: JevAsker,
  config: FastJevConfig,
): Promise<CompactResult | undefined> {
  const result = await runOpenCodeCompaction(messages, asker, config);
  if (!result || reductionRatio(result) < config.minReductionRatio) return;
  return result;
}

function percent(value: number): string {
  return Math.round(value * 100) + '%';
}

export const FastJevCompaction = Plugin.define({
  id: 'fast-jev-compaction-opencode',

  async setup(ctx) {
    const config = resolveConfig(ctx.options as PluginOptions);
    const resolved = resolveOptions(config);
    const logFile = config.logFile ?? defaultLogPath();
    const logger = createLogger(logFile);
    const asker = createAsker(config, logger);
    const backendDetails =
      config.backend === 'local'
        ? {
            endpoint: safeUrl(config.localBaseUrl ?? LOCAL_BASE_URL),
            model: config.localModel ?? LOCAL_MODEL,
          }
        : {};

    logger.info('initialized', {
      backend: config.backend,
      ...backendDetails,
      localConcurrency: config.localConcurrency,
      localContextTokens: config.localContextTokens,
      preserveRecentMessages: resolved.preserveRecentMessages,
      keepThreshold: resolved.keepThreshold,
      maxStateTokens: resolved.maxStateTokens,
      maxRequestTokens: resolved.maxRequestTokens,
      truncateHeadChars: resolved.truncateHeadChars,
      minReductionRatio: config.minReductionRatio,
      logFile,
    });

    await ctx.session.hook('compaction', async (event) => {
      const sessionID = event.sessionID;
      const nativeMessages = event.messages as unknown as NativeMessage[];

      try {
        const census = partCensus(nativeMessages);
        logger.info('compaction hook entered', {
          session: sessionID,
          rawMessages: nativeMessages.length,
          roles: census.roles,
          parts: census.parts,
          backend: config.backend,
        });

        const transcript = toCompactionMessages(nativeMessages);
        const calls = collectToolCalls(transcript, resolved.preserveRecentMessages);
        const candidateCalls = calls.filter((call) => !call.pinned).length;
        logger.info('transcript adapted', {
          session: sessionID,
          adaptedMessages: transcript.length,
          emptyDropped: nativeMessages.length - transcript.length,
          completedCalls: calls.length,
          pinned: calls.length - candidateCalls,
          candidates: candidateCalls,
        });

        if (transcript.length === 0) {
          logger.info('compaction outcome', {
            session: sessionID,
            outcome: 'fallback',
            reason: 'no-adaptable-messages',
          });
          return;
        }

        const result = await compact(transcript, asker, config);
        if (!result) {
          logger.info('compaction outcome', {
            session: sessionID,
            outcome: 'fallback',
            reason: 'no-compaction-result',
          });
          return;
        }

        const ratio = reductionRatio(result);
        logger.info('classification complete', {
          session: sessionID,
          calls: result.stats.calls,
          candidates: Math.max(0, result.stats.calls - result.stats.pinned),
          pinned: result.stats.pinned,
          jevBatches: result.stats.requests,
          stateTokens: result.stats.stateTokens,
          stateStage: result.stats.stateStage,
          reduction: percent(ratio),
        });

        if (ratio < config.minReductionRatio) {
          const reason =
            result.stats.requests === 0
              ? 'no-eligible-completed-tool-calls'
              : 'below-minimum-reduction';
          logger.info('compaction outcome', {
            session: sessionID,
            outcome: 'fallback',
            reason,
            reduction: percent(ratio),
            minimum: percent(config.minReductionRatio),
          });
          return;
        }

        event.result = {
          summary: serializeCompaction(result.messages),
          metadata: {
            plugin: 'fast-jev-compaction-opencode',
            backend: config.backend,
            calls: result.stats.calls,
            candidateCalls,
            pinned: result.stats.pinned,
            jevBatches: result.stats.requests,
            kept: result.stats.kept,
            resultsDropped: result.stats.resultsDropped,
            callsDropped: result.stats.callsDropped,
            reductionRatio: ratio,
          },
        };

        logger.info('compaction outcome', {
          session: sessionID,
          outcome: 'override',
          backend: config.backend,
          reduction: percent(ratio),
        });
      } catch (error) {
        logger.warn('compaction outcome', {
          session: sessionID,
          outcome: 'fallback',
          ...errorSummary(error),
        });
      }
    });
  },
});

export default FastJevCompaction;
