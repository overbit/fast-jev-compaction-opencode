import { afterEach, describe, expect, it, vi } from 'vitest';

import { JevClient } from '../src/client.js';
import { LocalJevAsker } from '../src/local.js';

afterEach(() => vi.unstubAllGlobals());

describe('TypeSafe backend', () => {
  it('sends System One state and questions', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('jev-latest');
      expect(body.state.goal).toBe('ship');
      return new Response(JSON.stringify({ answers: { keep: { noul: 0.9 } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);

    const response = await new JevClient({ apiKey: 'test' }).ask(
      { context: 'ctx', goal: 'ship', history: [] },
      { keep: { type: 'noul', instructions: 'keep?' } },
    );
    expect(response.answers.keep && 'noul' in response.answers.keep ? response.answers.keep.noul : undefined).toBe(0.9);
  });
});

describe('local backend', () => {
  it('derives noul probability from OpenAI-compatible logprobs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                logprobs: {
                  content: [
                    {
                      top_logprobs: [
                        { token: 'A', logprob: -0.1 },
                        { token: 'B', logprob: -2.0 },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const asker = new LocalJevAsker({
      concurrency: 1,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        return { status: response.status, ok: response.ok, text: await response.text() };
      },
    });
    const response = await asker.ask(
      { context: 'ctx', goal: 'ship', history: [] },
      { keep: { type: 'noul', instructions: 'keep?' } },
    );
    expect(response.answers.keep && 'noul' in response.answers.keep ? response.answers.keep.noul : 0).toBeGreaterThan(0.8);
  });
});
