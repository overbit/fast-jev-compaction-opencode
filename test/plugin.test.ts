import { describe, expect, it } from 'vitest';

import {
  resolveConfig,
  serializeCompaction,
  toCompactionMessages,
  type NativeMessage,
} from '../src/plugin.js';

describe('resolveConfig', () => {
  it('selects the local backend', () => {
    const config = resolveConfig({ backend: 'local', localConcurrency: 4 });
    expect(config.backend).toBe('local');
    expect(config.localConcurrency).toBe(4);
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
});
