import { Buffer } from 'node:buffer';

import { PartialAnswersError, noulAnswer, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/** LM Studio's default base URL; Ollama uses http://127.0.0.1:11434/v1. */
export const LOCAL_SYSTEM_ONE_BASE_URL = 'http://127.0.0.1:1234/v1';

/** Keep the full JSON payload below Ollama's 64 KiB text/schema limit. */
export const SYSTEM_ONE_MAX_REQUEST_BYTES = 60 * 1024;
export const SYSTEM_ONE_MAX_QUESTIONS = 64;

/** Accept an origin, a /v1 base URL, or a complete /v1/systemone URL. */
export function systemOneEndpoint(baseUrl = LOCAL_SYSTEM_ONE_BASE_URL): string {
  const url = baseUrl.replace(/\/+$/, '');
  if (url.endsWith('/v1/systemone')) return url;
  if (url.endsWith('/v1')) return `${url}/systemone`;
  return `${url}/v1/systemone`;
}

export interface SystemOneClientOptions {
  /** Model ID as listed by the local decision server; required. */
  model: string;
  baseUrl?: string;
  /** Optional bearer token for an authenticated local server or proxy. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Conservative Ollama-compatible cap (overridable in tests). */
  maxRequestBytes?: number;
  maxQuestions?: number;
}

export type SystemOneBatch = { body: string; names: string[] };

/** Split questions by UTF-8 request bytes and count; keep the state shared. */
export function systemOneBatches(
  model: string,
  state: JevState,
  questions: JevQuestions,
  maxRequestBytes = SYSTEM_ONE_MAX_REQUEST_BYTES,
  maxQuestions = SYSTEM_ONE_MAX_QUESTIONS,
): SystemOneBatch[] {
  const batches: SystemOneBatch[] = [];
  let current: JevQuestions = {};
  let names: string[] = [];
  const bodyOf = (items: JevQuestions) => JSON.stringify({ model, state, questions: items });
  const flush = () => {
    if (names.length === 0) return;
    batches.push({ body: bodyOf(current), names });
    current = {};
    names = [];
  };

  for (const [name, question] of Object.entries(questions)) {
    if (question.type !== 'noul') {
      throw new Error('local System One compaction supports only noul questions');
    }
    const next = { ...current, [name]: question };
    if (names.length >= maxQuestions || Buffer.byteLength(bodyOf(next), 'utf8') > maxRequestBytes) {
      flush();
    }
    const candidate = { ...current, [name]: question };
    if (Buffer.byteLength(bodyOf(candidate), 'utf8') > maxRequestBytes) {
      throw new Error(
        `local System One context overflow: state and one question exceed ${maxRequestBytes} bytes; lower maxStateTokens`,
      );
    }
    current = candidate;
    names.push(name);
  }
  flush();
  return batches;
}

/** One state and many decisions per request, unlike the legacy chat backend. */
export class SystemOneClient implements JevAsker {
  private readonly model: string;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetcher: typeof fetch;
  private readonly maxRequestBytes: number;
  private readonly maxQuestions: number;

  constructor(options: SystemOneClientOptions) {
    this.model = options.model.trim();
    this.url = systemOneEndpoint(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
    this.maxRequestBytes = options.maxRequestBytes ?? SYSTEM_ONE_MAX_REQUEST_BYTES;
    this.maxQuestions = options.maxQuestions ?? SYSTEM_ONE_MAX_QUESTIONS;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.model) throw new Error('backend=systemone requires localModel');
    const batches = systemOneBatches(
      this.model,
      state,
      questions,
      this.maxRequestBytes,
      this.maxQuestions,
    );
    const answers: JevResponse['answers'] = {};
    let inputTokens = 0;
    let outputTokens = 0;

    for (const batch of batches) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
        const response = await this.fetcher(this.url, {
          method: 'POST',
          headers,
          body: batch.body,
        });
        const result = parseJevResponse(response.status, response.ok, await response.text());
        for (const name of batch.names) {
          const probability = noulAnswer(result.answers, name);
          if (probability < 0 || probability > 1) {
            throw new Error(`invalid System One noul probability for ${name}`);
          }
          answers[name] = { type: 'noul', noul: probability };
        }
        inputTokens += result.usage?.input_tokens ?? 0;
        outputTokens += result.usage?.output_tokens ?? 0;
      } catch (error) {
        // No decision is discarded without both answers; preserve partial work.
        throw new PartialAnswersError(
          error instanceof Error ? error.message : String(error),
          { ...answers },
        );
      }
    }

    return {
      model: this.model,
      answers,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}
