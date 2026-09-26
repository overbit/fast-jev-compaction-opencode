import { describe, expect, it } from 'vitest';

import { applyCompaction, resolveConfig, toCompactionMessages } from '../src/plugin.js';
import type { CompactResult } from '../src/types.js';

describe('resolveConfig', () => {
  it('selects the local backend and keeps safe OpenCode fallback by default', () => {
    const config = resolveConfig({ backend: 'local', localConcurrency: 4 });
    expect(config.backend).toBe('local');
    expect(config.localConcurrency).toBe(4);
    expect(config.disableBuiltinAutoCompaction).toBe(false);
  });
});

describe('OpenCode adapter', () => {
  const messages = [
    {
      info: { id: 'm1', role: 'user' },
      parts: [{ type: 'text', text: 'Fix the test' }],
    },
    {
      info: { id: 'm2', role: 'assistant' },
      parts: [
        { type: 'text', text: 'Checking.' },
        {
          type: 'tool',
          tool: 'read',
          callID: 'call-1',
          state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'long output' },
        },
      ],
    },
  ];

  it('maps completed OpenCode tools to paired compaction calls and results', () => {
    const transcript = toCompactionMessages(messages);
    expect(transcript[1]?.toolUses[0]).toMatchObject({
      tool_use_id: 'call-1',
      tool: 'read',
      input: { filePath: 'a.ts' },
    });
    expect(transcript[1]?.toolResults?.[0]?.text).toBe('long output');
  });

  it('removes a tool part when Jev drops the call', () => {
    const result: CompactResult = {
      messages: [
        { role: 'user', text: 'Fix the test', toolUses: [] },
        { role: 'assistant', text: 'Checking.', toolUses: [] },
      ],
      decisions: [
        {
          id: 't1',
          tool: 'read',
          action: 'drop_call',
          reason: 'call_dropped',
          keepCall: 0.1,
          keepResult: 0.1,
        },
      ],
      stats: {
        messagesBefore: 2,
        messagesAfter: 2,
        charsBefore: 100,
        charsAfter: 20,
        calls: 1,
        kept: 0,
        resultsDropped: 0,
        callsDropped: 1,
        pinned: 0,
        stateTokens: 20,
        stateStage: 'full',
        requests: 1,
        ms: 1,
      },
    };

    const compacted = applyCompaction(messages, result);
    expect(compacted[1]?.parts).toEqual([{ type: 'text', text: 'Checking.' }]);
  });
});
