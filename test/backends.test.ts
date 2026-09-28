import { afterEach, describe, expect, it, vi } from 'vitest';

import { JevClient } from '../src/client.js';
import { LocalJevAsker, buildLocalRequest, decisionPrompt, parseLocalResponse } from '../src/local.js';

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

  describe('refusals', () => {
    it('names the reasoning_content case, where the model answers but sends no distribution', () => {
      // A model that answers in `reasoning_content` returns 200 with
      // `logprobs: null`; nothing to read, and the endpoint is not at fault.
      expect(() =>
        parseLocalResponse(
          200,
          true,
          JSON.stringify({
            choices: [{ message: { content: '', reasoning_content: 'yes no' }, logprobs: null }],
          }),
          2,
        ),
      ).toThrow(/must emit top_logprobs.*reasoning_content/s);
    });

    it('reads a 200 error envelope as a refusal, not a malformed response', () => {
      // LM Studio's router answers an unknown route with 200 and this body.
      expect(() =>
        parseLocalResponse(
          200,
          true,
          JSON.stringify({ error: 'Unexpected endpoint or method. (POST /chat/completions)' }),
          2,
        ),
      ).toThrow(/error envelope \(200\) server: Unexpected endpoint or method/);
    });

    it('reads a nested OpenAI-style error object', () => {
      expect(() =>
        parseLocalResponse(
          400,
          false,
          JSON.stringify({ error: { message: 'logprobs is not supported with tools + stream' } }),
          2,
        ),
      ).toThrow(/request failed \(400\) server: logprobs is not supported/);
    });

    it('still reports malformed JSON when the body is not JSON at all', () => {
      expect(() => parseLocalResponse(200, true, '<html>hi</html>', 2)).toThrow(
        'local classifier returned malformed JSON',
      );
    });

    it('redacts the prompt scaffolding a server echoes back', () => {
    const echoed = JSON.stringify({
      error: { message: `bad request, prompt was: ${decisionPrompt({ context: 'a secret plan' }, 'keep?', ['yes', 'no'])}` },
    });

    expect(() => parseLocalResponse(400, false, echoed, 2)).toThrow(/server: bad request, prompt was: \[prompt omitted\]/);
    try {
      parseLocalResponse(400, false, echoed, 2);
    } catch (e) {
      expect(String(e)).not.toContain('a secret plan');
    }
  });

  it('keeps a non-JSON failure body in the message', () => {
      expect(() => parseLocalResponse(502, false, '<html>bad gateway</html>', 2)).toThrow(
        /request failed \(502\): <html>bad gateway<\/html>/,
      );
    });
  });

  it('sends a bearer token only when one is configured', () => {
    const withKey = buildLocalRequest({ apiKey: 'sk-local' }, 'hi');
    expect(withKey.headers.authorization).toBe('Bearer sk-local');

    const withoutKey = buildLocalRequest({}, 'hi');
    expect(withoutKey.headers.authorization).toBeUndefined();
  });

  it('sends the configured bearer token through the asker transport', async () => {
    const seen: Record<string, string>[] = [];
    const asker = new LocalJevAsker({
      apiKey: 'sk-proxy',
      concurrency: 1,
      fetch: async (_url, init) => {
        seen.push(init.headers);
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({
            choices: [
              { logprobs: { content: [{ top_logprobs: [{ token: 'A', logprob: -0.1 }, { token: 'B', logprob: -2 }] }] } },
            ],
          }),
        };
      },
    });

    await asker.ask(
      { context: 'ctx', goal: 'ship', history: [] },
      { keep: { type: 'noul', instructions: 'keep?' } },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe('Bearer sk-proxy');
  });
});
