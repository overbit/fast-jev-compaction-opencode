import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FastJevCompaction,
  resolveConfig,
  serializeCompaction,
  toCompactionMessages,
  type NativeMessage,
} from '../src/plugin.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveConfig', () => {
  it('selects the local backend', () => {
    const config = resolveConfig({ backend: 'local', localConcurrency: 4, logFile: '/tmp/jev.log' });
    expect(config.backend).toBe('local');
    expect(config.localConcurrency).toBe(4);
    expect(config.logFile).toBe('/tmp/jev.log');
  });

  it('carries a local bearer token without conflating it with the TypeSafe key', () => {
    const config = resolveConfig({ backend: 'local', localApiKey: 'sk-proxy', apiKey: 'sk-typesafe' });
    expect(config.localApiKey).toBe('sk-proxy');
    expect(config.apiKey).toBe('sk-typesafe');
  });
});

describe('OpenCode V2 adapter', () => {
  const messages: NativeMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'Fix the test' }],
    },
    {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        {
          type: 'tool-call',
          id: 'call-1',
          name: 'read',
          input: { filePath: 'a.ts' },
        },
      ],
    },
    {
      id: 'm3',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'call-1',
          result: { type: 'text', value: 'long output' },
        },
      ],
    },
  ];

  it('maps V2 tool calls and results into the compaction core', () => {
    const transcript = toCompactionMessages(messages);
    expect(transcript[1]?.toolUses[0]).toMatchObject({
      tool_use_id: 'call-1',
      tool: 'read',
      input: { filePath: 'a.ts' },
    });
    expect(transcript[2]?.toolResults?.[0]).toMatchObject({
      tool_use_id: 'call-1',
      text: 'long output',
    });
  });

  it('serializes retained messages without model rewriting', () => {
    const summary = serializeCompaction(toCompactionMessages(messages));
    expect(summary).toContain('Fix the test');
    expect(summary).toContain('Checking.');
    expect(summary).toContain('[tool-call id=call-1 name=read]');
    expect(summary).toContain('long output');
  });

  it('calls the local backend from the V2 compaction hook when a completed tool call is eligible', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logDirectory = mkdtempSync(join(tmpdir(), 'fast-jev-plugin-test-'));
    temporaryDirectories.push(logDirectory);
    const logFile = join(logDirectory, 'plugin.log');
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              logprobs: {
                content: [
                  {
                    top_logprobs: [
                      { token: 'A', logprob: -2 },
                      { token: 'B', logprob: -0.1 },
                    ],
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    let compactionHook: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    await FastJevCompaction.setup({
      options: {
        backend: 'local',
        preserveRecentMessages: 0,
        minReductionRatio: 0,
        localApiKey: 'sk-test-key',
        logFile,
      },
      session: {
        async hook(name: string, callback: (event: Record<string, unknown>) => Promise<void>) {
          if (name === 'compaction') compactionHook = callback;
          return { dispose: async () => undefined };
        },
      },
    } as never);

    expect(compactionHook).toBeTypeOf('function');

    const event: Record<string, unknown> = {
      sessionID: 'ses_test',
      messages,
    };
    await compactionHook!(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key');
    }
    expect(event.result).toMatchObject({
      metadata: {
        plugin: 'fast-jev-compaction-opencode',
        backend: 'local',
        calls: 1,
        candidateCalls: 1,
        pinned: 0,
        jevBatches: 1,
      },
    });

    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"backend":"local"');
    expect(log).toContain('"apiKey":"set"');
    expect(log).not.toContain('sk-test-key');
    expect(log).toContain('"parts":{"text":2,"tool-call":1,"tool-result":1}');
    expect(log).toContain('"candidates":1');
    expect(log).toContain('"question":"call_t1"');
    expect(log).toContain('"outcome":"override"');
    expect(log).not.toContain('Fix the test');
    expect(log).not.toContain('long output');
  });

  it('logs when no completed tool call is eligible without contacting the local backend', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logDirectory = mkdtempSync(join(tmpdir(), 'fast-jev-plugin-test-'));
    temporaryDirectories.push(logDirectory);
    const logFile = join(logDirectory, 'plugin.log');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let compactionHook: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    await FastJevCompaction.setup({
      options: { backend: 'local', logFile },
      session: {
        async hook(name: string, callback: (event: Record<string, unknown>) => Promise<void>) {
          if (name === 'compaction') compactionHook = callback;
          return { dispose: async () => undefined };
        },
      },
    } as never);

    await compactionHook!({ sessionID: 'ses_no_candidates', messages });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(logFile, 'utf8')).toContain(
      '"reason":"no-eligible-completed-tool-calls"',
    );
  });
});
