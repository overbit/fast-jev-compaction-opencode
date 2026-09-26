import { describe, expect, it } from 'vitest';

import { compact } from '../src/compact.js';

describe('compaction', () => {
  it('drops a tool call and result without rewriting text', async () => {
    const messages = [
      { role: 'user' as const, text: 'fix it', toolUses: [] },
      {
        role: 'assistant' as const,
        text: 'checking',
        toolUses: [{ tool_use_id: 'c1', tool: 'read', input: { path: 'a.ts' } }],
      },
      {
        role: 'user' as const,
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'c1', text: 'old output' }],
      },
      { role: 'user' as const, text: 'continue', toolUses: [] },
    ];

    const result = await compact(
      messages,
      {
        async ask(_state, questions) {
          return {
            answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.1 }])),
          };
        },
      },
      { preserveRecentMessages: 0 },
    );

    expect(result.messages.map((message) => message.text)).toEqual(['fix it', 'checking', 'continue']);
    expect(result.stats.callsDropped).toBe(1);
  });
});
