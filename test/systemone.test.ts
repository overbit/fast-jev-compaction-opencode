import { describe, expect, it, vi } from 'vitest';

import { PartialAnswersError } from '../src/request.js';
import {
  LOCAL_SYSTEM_ONE_BASE_URL,
  SystemOneClient,
  systemOneBatches,
  systemOneEndpoint,
} from '../src/systemone.js';
import type { JevQuestions } from '../src/types.js';

const state = { context: 'Fix tests', goal: 'Keep evidence', history: [] };
const questions: JevQuestions = {
  call_t1: { type: 'noul', instructions: 'Keep the call?' },
  result_t1: { type: 'noul', instructions: 'Keep the result?' },
};

describe('System One local client', () => {
  it('resolves LM Studio, Ollama, and explicit endpoints', () => {
    expect(systemOneEndpoint()).toBe(`${LOCAL_SYSTEM_ONE_BASE_URL}/systemone`);
    expect(systemOneEndpoint('http://localhost:11434')).toBe('http://localhost:11434/v1/systemone');
    expect(systemOneEndpoint('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1/systemone');
    expect(systemOneEndpoint('http://localhost:1234/v1/systemone/')).toBe('http://localhost:1234/v1/systemone');
  });

  it('sends one shared state with both questions and no hosted API key', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        model: 'jev-style-0.8b',
        answers: {
          call_t1: { type: 'noul', noul: 0.9 },
          result_t1: { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 50, output_tokens: 2 },
      })),
    );
    const client = new SystemOneClient({ model: 'jev-style-0.8b', fetch: fetcher });
    const result = await client.ask(state, questions);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:1234/v1/systemone');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'jev-style-0.8b', state, questions });
    expect(result.answers).toMatchObject({
      call_t1: { noul: 0.9 },
      result_t1: { noul: 0.2 },
    });
    expect(result.usage).toEqual({ input_tokens: 50, output_tokens: 2 });
  });

  it('sends the local proxy bearer token without a TypeSafe key', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ answers: { call_t1: { type: 'noul', noul: 0.7 } } })),
    );
    const client = new SystemOneClient({
      model: 'tev1:0.8b', baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-local-proxy', fetch: fetcher,
    });
    await client.ask(state, { call_t1: questions.call_t1! });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/v1/systemone');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-local-proxy');
  });

  it('batches by question count and UTF-8 payload size', () => {
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'Keep?' }]),
    ) as JevQuestions;
    expect(systemOneBatches('tev1:0.8b', state, many).map(b => b.names.length)).toEqual([64, 1]);
    expect(systemOneBatches('tev1:0.8b', state, questions, 190)).toHaveLength(2);
  });

  it('fails before sending an oversized state', async () => {
    const fetcher = vi.fn();
    const client = new SystemOneClient({ model: 'tev1:0.8b', maxRequestBytes: 300, fetch: fetcher });
    await expect(client.ask({ context: 'z'.repeat(500) }, questions)).rejects.toThrow(/maxStateTokens/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains successful answers if a later batch fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { call_t1: { noul: 0.9 } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    const client = new SystemOneClient({ model: 'tev1:0.8b', maxQuestions: 1, fetch: fetcher });
    await expect(client.ask(state, questions)).rejects.toMatchObject({
      name: 'PartialAnswersError',
      answers: { call_t1: { noul: 0.9 } },
    });
  });

  it('rejects missing and out-of-range probabilities', async () => {
    for (const answer of [{ type: 'noul' }, { type: 'noul', noul: 1.2 }]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({
        answers: { call_t1: answer, result_t1: { noul: 0.5 } },
      })));
      await expect(new SystemOneClient({ model: 'tev1:0.8b', fetch: fetcher }).ask(state, questions))
        .rejects.toBeInstanceOf(PartialAnswersError);
    }
  });

  it('requires an explicit decision model ID', () => {
    expect(() => new SystemOneClient({ model: '' })).toThrow(/localModel/);
  });
});
