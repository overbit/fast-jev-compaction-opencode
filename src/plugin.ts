import { Plugin } from '@opencode/plugin';

import { compact, reductionRatio, resolveOptions } from './compact.js';
import { JevClient } from './client.js';
import { LOCAL_BASE_URL, LOCAL_MODEL, LocalJevAsker } from './local.js';
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

  for (const key of ['apiKey', 'model', 'baseUrl', 'localModel', 'localBaseUrl', 'goal'] as const) {
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

function createAsker(config: FastJevConfig): JevAsker {
  if (config.backend === 'local') {
    return new LocalJevAsker({
      baseUrl: config.localBaseUrl,
      model: config.localModel,
      concurrency: config.localConcurrency,
      contextTokens: config.localContextTokens,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        return { status: response.status, ok: response.ok, text: await response.text() };
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

const LOG_PREFIX = '[fast-jev-compaction-opencode]';

function percent(value: number): string {
  return Math.round(value * 100) + '%';
}

export const FastJevCompaction = Plugin.define({
  id: 'fast-jev-compaction-opencode',

  async setup(ctx) {
    const config = resolveConfig(ctx.options as PluginOptions);
    const resolved = resolveOptions(config);
    const asker = createAsker(config);
    const backendDetails =
      config.backend === 'local'
        ? ' endpoint=' + (config.localBaseUrl ?? LOCAL_BASE_URL) + ' model=' + (config.localModel ?? LOCAL_MODEL)
        : '';

    console.info(
      LOG_PREFIX +
        ' initialized backend=' +
        config.backend +
        backendDetails +
        ' preserveRecentMessages=' +
        resolved.preserveRecentMessages +
        ' minReductionRatio=' +
        percent(config.minReductionRatio),
    );

    await ctx.session.hook('compaction', async (event) => {
      const sessionID = event.sessionID;
      console.info(
        LOG_PREFIX +
          ' compaction hook session=' +
          sessionID +
          ' messages=' +
          event.messages.length +
          ' backend=' +
          config.backend,
      );

      try {
        const result = await runOpenCodeCompaction(
          event.messages as unknown as NativeMessage[],
          asker,
          config,
        );
        if (!result) {
          console.info(
            LOG_PREFIX +
              ' fallback session=' +
              sessionID +
              ' reason=no-adaptable-messages',
          );
          return;
        }

        const ratio = reductionRatio(result);
        const candidateCalls = Math.max(0, result.stats.calls - result.stats.pinned);
        console.info(
          LOG_PREFIX +
            ' classified session=' +
            sessionID +
            ' calls=' +
            result.stats.calls +
            ' candidates=' +
            candidateCalls +
            ' pinned=' +
            result.stats.pinned +
            ' jevBatches=' +
            result.stats.requests +
            ' reduction=' +
            percent(ratio),
        );

        if (result.stats.requests === 0) {
          console.info(
            LOG_PREFIX +
              ' classifier not called session=' +
              sessionID +
              ' reason=no-eligible-completed-tool-calls' +
              ' preserveRecentMessages=' +
              resolved.preserveRecentMessages,
          );
        }

        if (ratio < config.minReductionRatio) {
          console.info(
            LOG_PREFIX +
              ' fallback session=' +
              sessionID +
              ' reason=below-minimum-reduction' +
              ' reduction=' +
              percent(ratio) +
              ' minimum=' +
              percent(config.minReductionRatio),
          );
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

        console.info(
          LOG_PREFIX +
            ' override applied session=' +
            sessionID +
            ' backend=' +
            config.backend +
            ' reduction=' +
            percent(ratio),
        );
      } catch (error) {
        console.warn(
          LOG_PREFIX + ' falling back to OpenCode compaction session=' + sessionID + ':',
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  },
});

export default FastJevCompaction;
