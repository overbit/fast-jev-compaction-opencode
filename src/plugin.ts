import type { Plugin, PluginOptions } from '@opencode-ai/plugin';

import { compact, reductionRatio } from './compact.js';
import { JevClient } from './client.js';
import { LocalJevAsker } from './local.js';
import type { CompactOptions, JevAsker, Message } from './types.js';

type Backend = 'typesafe' | 'local';

type ToolState =
  | { status: 'completed'; input?: unknown; output?: unknown; [key: string]: unknown }
  | { status: 'error'; input?: unknown; error?: unknown; [key: string]: unknown }
  | { status: string; input?: unknown; [key: string]: unknown };

type OpenCodePart = {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolState;
  [key: string]: unknown;
};

type OpenCodeMessage = {
  info: { id?: string; role?: string; [key: string]: unknown };
  parts: OpenCodePart[];
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
  disableBuiltinAutoCompaction: boolean;
}

const DEFAULTS = {
  backend: 'typesafe' as const,
  localConcurrency: 2,
  localContextTokens: 64_000,
  minReductionRatio: 0.25,
  disableBuiltinAutoCompaction: false,
};

function stringOption(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOption(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOption(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveConfig(options: PluginOptions = {}): FastJevConfig {
  const backend = options.backend === 'local' ? 'local' : 'typesafe';
  const config: FastJevConfig = {
    backend,
    localConcurrency: Math.max(1, Math.floor(numberOption(options, 'localConcurrency', DEFAULTS.localConcurrency))),
    localContextTokens: Math.max(1, numberOption(options, 'localContextTokens', DEFAULTS.localContextTokens)),
    minReductionRatio: Math.max(0, Math.min(1, numberOption(options, 'minReductionRatio', DEFAULTS.minReductionRatio))),
    disableBuiltinAutoCompaction: booleanOption(
      options,
      'disableBuiltinAutoCompaction',
      DEFAULTS.disableBuiltinAutoCompaction,
    ),
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

function isFinishedTool(part: OpenCodePart): boolean {
  return part.type === 'tool' && (part.state?.status === 'completed' || part.state?.status === 'error');
}

export function toCompactionMessages(messages: readonly OpenCodeMessage[]): Message[] {
  return messages
    .filter((message) => message.info.role === 'user' || message.info.role === 'assistant')
    .map((message) => {
      const toolUses = message.parts.filter(isFinishedTool).map((part) => ({
        tool_use_id: part.callID ?? '',
        tool: part.tool ?? 'tool',
        input:
          part.state?.input && typeof part.state.input === 'object'
            ? (part.state.input as Record<string, unknown>)
            : { value: part.state?.input },
        text:
          part.state?.status === 'completed'
            ? textOf(part.state.output)
            : textOf(part.state?.status === 'error' ? part.state.error : ''),
        isError: part.state?.status === 'error',
      }));
      const toolResults = toolUses.map((tool) => ({
        tool_use_id: tool.tool_use_id,
        text: tool.text ?? '',
        isError: tool.isError,
      }));
      return {
        role: message.info.role as 'user' | 'assistant',
        text: message.parts
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n'),
        toolUses,
        ...(toolResults.length > 0 ? { toolResults } : {}),
      };
    });
}

function resultTextByCall(messages: readonly Message[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const message of messages) {
    for (const tool of message.toolUses) {
      if (tool.text !== undefined) result.set(tool.tool_use_id, tool.text);
    }
    for (const toolResult of message.toolResults ?? []) {
      result.set(toolResult.tool_use_id, toolResult.text);
    }
  }
  return result;
}

export function applyCompaction(
  messages: readonly OpenCodeMessage[],
  compacted: Awaited<ReturnType<typeof compact>>,
): OpenCodeMessage[] {
  const action = new Map<string, string>();
  for (const decision of compacted.decisions) {
    const call = compacted.messages
      .flatMap((message) => message.toolUses)
      .find((tool) => tool.tool === decision.tool && tool.tool_use_id);
    if (call) action.set(call.tool_use_id, decision.action);
  }

  // Decisions use compact short ids, so recover actions by ordering when a dropped
  // call no longer exists in compacted.messages.
  const originalCalls = toCompactionMessages(messages).flatMap((message) => message.toolUses);
  compacted.decisions.forEach((decision, index) => {
    const call = originalCalls[index];
    if (call) action.set(call.tool_use_id, decision.action);
  });

  const resultText = resultTextByCall(compacted.messages);
  return messages
    .map((message) => {
      const parts = message.parts.flatMap((part) => {
        if (!isFinishedTool(part) || !part.callID) return [part];
        const decision = action.get(part.callID);
        if (decision === 'drop_call') return [];
        if (decision !== 'drop_result') return [part];

        const text = resultText.get(part.callID);
        if (text === undefined || !part.state) return [part];
        if (part.state.status === 'completed') {
          return [{ ...part, state: { ...part.state, output: text } }];
        }
        if (part.state.status === 'error') {
          return [{ ...part, state: { ...part.state, error: text } }];
        }
        return [part];
      });
      return { ...message, parts };
    })
    .filter((message) => message.parts.length > 0);
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

export const FastJevCompaction: Plugin = async (_input, options = {}) => {
  const config = resolveConfig(options);
  const asker = createAsker(config);

  return {
    config: async (opencode) => {
      if (!config.disableBuiltinAutoCompaction) return;
      const hostConfig = opencode as typeof opencode & {
        compaction?: { auto?: boolean; prune?: boolean; [key: string]: unknown };
      };
      hostConfig.compaction = {
        ...(hostConfig.compaction ?? {}),
        auto: false,
        prune: false,
      };
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const source = output.messages as unknown as OpenCodeMessage[];
      const transcript = toCompactionMessages(source);
      if (transcript.length === 0) return;

      try {
        const result = await compact(transcript, asker, config);
        if (reductionRatio(result) < config.minReductionRatio) return;
        output.messages = applyCompaction(source, result) as typeof output.messages;
      } catch {
        // Preserve OpenCode's normal path when the configured classifier is unavailable.
      }
    },
  };
};

export default FastJevCompaction;
