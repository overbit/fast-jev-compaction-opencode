import { estimateTokens } from './state.js';
import { PartialAnswersError, type JevRequest } from './request.js';
import type {
  JevAsker,
  JevQuestion,
  JevQuestions,
  JevResponse,
  JevState,
  NoulQuestion,
} from './types.js';

export const LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
export const LOCAL_MODEL = 'jev-style-qwen3.5-2b-decision-mlx';
export const LOCAL_CONCURRENCY = 2;
/** A little under LM Studio's 64K setting, which it loads as 64380 tokens. */
export const LOCAL_CONTEXT_TOKENS = 64_000;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HEADER =
  'You are a decision function. Read the state, then answer the question by choosing exactly one option.\n\n';
/** LM Studio's MLX engine refuses more than 10 candidates per position. */
const TOP_LOGPROBS = 10;
/**
 * LM Studio generates nothing for `max_tokens: 1` (and so returns no
 * logprobs); 2 yields the one decision token that is read.
 */
const MAX_TOKENS = 2;
/** Log-prob given to a declared letter outside the returned candidates. */
const MISSING_OPTION_MARGIN = 5;

/** The response of any fetch-like transport, body already read. */
export type LocalFetchResponse = { status: number; ok: boolean; text: string };
export type LocalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<LocalFetchResponse>;

/** The Jev-style decision prompt the model was trained on; it must end in `Answer:`. */
export function decisionPrompt(state: JevState, question: string, options: readonly string[]): string {
  const stateText = typeof state === 'string' ? state : JSON.stringify(state);
  const lines = options.map((option, index) => `${LETTERS[index]}. ${option}`).join('\n');
  return `${HEADER}[State]\n${stateText}\n\n[Question]\n${question}\n\n[Options]\n${lines}\n\nAnswer:`;
}

/** A `noul` question as a two-option decision; option A is `true`. */
export function noulOptions(question: NoulQuestion): [string, string] {
  return [question.criteria?.true ?? 'yes', question.criteria?.false ?? 'no'];
}

/** The LM Studio chat completion for one decision: one token, with its candidates' log-probs. */
export function buildLocalRequest(
  params: { baseUrl?: string; model?: string },
  prompt: string,
): JevRequest {
  return {
    url: `${(params.baseUrl ?? LOCAL_BASE_URL).replace(/\/+$/, '')}/chat/completions`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: params.model ?? LOCAL_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: MAX_TOKENS,
      logprobs: true,
      top_logprobs: TOP_LOGPROBS,
    }),
  };
}

export interface LocalDecision {
  /** Probability of each declared option, renormalised over the options only. */
  probabilities: number[];
  promptTokens?: number;
}

function isContextOverflow(text: string): boolean {
  return /context length|context window|context overflow/i.test(text);
}

/**
 * Reads the decision distribution from an LM Studio chat completion: the
 * log-probs of the option letters at the first generated position,
 * renormalised over the declared options. A declared letter outside the
 * returned candidates gets the lowest returned log-prob minus a margin
 * (negligible mass), as in the model's reference client.
 */
export function parseLocalResponse(
  status: number,
  ok: boolean,
  text: string,
  optionCount: number,
): LocalDecision {
  if (!ok) {
    if (isContextOverflow(text)) {
      throw new Error(`local classifier context overflow (${status}): ${text.slice(0, 200)}`);
    }
    throw new Error(`local classifier request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('local classifier returned malformed JSON');
  }
  const body = parsed as {
    choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: unknown }> | null } | null }>;
    usage?: { prompt_tokens?: unknown };
  } | null;
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  if (!choice) throw new Error('local classifier response has no choices');
  if (!choice.logprobs) {
    throw new Error('local classifier returned no logprobs; the server must support top_logprobs');
  }
  const top = choice.logprobs.content?.[0]?.top_logprobs;
  if (!Array.isArray(top) || top.length === 0) {
    throw new Error('local classifier returned no candidate tokens for the decision');
  }
  const candidates = new Map<string, number>();
  for (const entry of top) {
    const { token, logprob } = (entry ?? {}) as { token?: unknown; logprob?: unknown };
    if (typeof token !== 'string' || typeof logprob !== 'number' || !Number.isFinite(logprob)) {
      throw new Error('local classifier returned malformed logprobs');
    }
    const key = token.trim();
    const seen = candidates.get(key);
    // Two spellings of one letter (`A`, ` A`) share its probability mass.
    candidates.set(
      key,
      seen === undefined
        ? logprob
        : Math.max(seen, logprob) + Math.log1p(Math.exp(-Math.abs(seen - logprob))),
    );
  }
  const letters = [...LETTERS.slice(0, optionCount)];
  if (!letters.some((letter) => candidates.has(letter))) {
    throw new Error(
      `local classifier answered none of the options ${letters.join('/')} (top token ${JSON.stringify(
        (top[0] as { token?: unknown }).token,
      )})`,
    );
  }
  const floor = Math.min(...candidates.values()) - MISSING_OPTION_MARGIN;
  const logits = letters.map((letter) => candidates.get(letter) ?? floor);
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  const promptTokens = body?.usage?.prompt_tokens;
  return {
    probabilities: exps.map((value) => value / sum),
    ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
  };
}

function noulQuestion(name: string, question: JevQuestion): NoulQuestion {
  if (question.type !== 'noul') {
    throw new Error(`local classifier supports only noul questions (${name} is ${question.type})`);
  }
  return question;
}

/** Most options one decision can declare: LM Studio returns at most 10 candidates. */
export const MAX_OPTIONS = TOP_LOGPROBS;

/** `high` work (a tool call, a compaction in progress) runs before any queued `low` work. */
export type Priority = 'high' | 'low';

/** Runs a task when a slot is free; one scheduler can be shared by several askers. */
export type Scheduler = <T>(task: () => Promise<T>, priority?: Priority) => Promise<T>;

/**
 * A scheduler running at most `limit` tasks at once: queued `high` tasks
 * first, each priority in the order it was queued.
 */
export function createScheduler(limit: number): Scheduler {
  limit = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Record<Priority, Array<() => void>> = { high: [], low: [] };
  return async (task, priority = 'high') => {
    if (active >= limit) await new Promise<void>((resolve) => waiting[priority].push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const nextTask = waiting.high.shift() ?? waiting.low.shift();
      if (nextTask) nextTask();
      else active--;
    }
  };
}

// The hooks environment has timers but its type library does not declare them.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/** Resolves `work`, or rejects once `deadline` (epoch ms) passes; `work` keeps running. */
function beforeDeadline<T>(work: Promise<T>, deadline: number | undefined, what: string): Promise<T> {
  if (deadline === undefined) return work;
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(
      () => reject(new DeadlineError(`${what} did not finish within its time budget`)),
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([work, expired]).finally(() => timers.clearTimeout(timer));
}

/** The asker's deadline passed before the work finished. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

export interface LocalJevAskerOptions {
  /** OpenAI-compatible base URL; defaults to LM Studio's `http://127.0.0.1:1234/v1`. */
  baseUrl?: string;
  /** Defaults to `jev-style-qwen3.5-2b-decision-mlx`. */
  model?: string;
  /** Decisions in flight at once, across every `ask`. Default 2; ignored with `scheduler`. */
  concurrency?: number;
  /** A scheduler shared with other askers, so one cap covers them all. */
  scheduler?: Scheduler;
  /** Queue priority of this asker's requests. Default `high`. */
  priority?: Priority;
  /**
   * Epoch ms after which `ask` stops, answering with what it has
   * (`PartialAnswersError` with `timedOut`), and `decide` fails. A request
   * already sent keeps its queue slot until the server answers.
   */
  deadline?: number;
  /** Once aborted, no new request is sent; like the deadline, `ask` answers with what it has. */
  signal?: AbortSignal;
  /** Estimated token ceiling for one prompt. Default 64000. */
  contextTokens?: number;
  /** The transport: `fetchText` (global `fetch`) or a host's, like `$.http.fetch`. */
  fetch: LocalFetch;
}

/**
 * Answers Jev `noul` questions with a local Jev-style decision model served
 * by LM Studio. Every question is one prompt (state, question, options A/B);
 * its `noul` is the probability of option A. Nothing leaves the configured
 * base URL, and no API key is involved.
 */
export interface ChoiceDecision {
  /** The most probable option. */
  choice: string;
  /** Probability of each option, in the order given, summing to 1. */
  probabilities: number[];
  promptTokens?: number;
}

function validOptions(options: unknown): string[] {
  if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
    throw new Error(`options must be an array of 2 to ${MAX_OPTIONS} strings`);
  }
  if (!options.every((option) => typeof option === 'string' && option.trim().length > 0)) {
    throw new Error('every option must be a non-empty string');
  }
  if (new Set(options.map((option: string) => option.trim())).size !== options.length) {
    throw new Error('options must be unique');
  }
  return options as string[];
}

export class LocalJevAsker implements JevAsker {
  readonly baseUrl: string;
  readonly model: string;
  readonly concurrency: number;
  readonly contextTokens: number;
  private readonly fetcher: LocalFetch;
  private readonly schedule: Scheduler;
  private readonly priority: Priority;
  private readonly deadline: number | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(options: LocalJevAskerOptions) {
    this.baseUrl = options.baseUrl ?? LOCAL_BASE_URL;
    this.model = options.model ?? LOCAL_MODEL;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? LOCAL_CONCURRENCY));
    this.contextTokens = options.contextTokens ?? LOCAL_CONTEXT_TOKENS;
    if (!(this.contextTokens > 0)) {
      throw new Error(`local classifier contextTokens must be positive (got ${this.contextTokens})`);
    }
    this.fetcher = options.fetch;
    this.schedule = options.scheduler ?? createScheduler(this.concurrency);
    this.priority = options.priority ?? 'high';
    this.deadline = options.deadline;
    this.signal = options.signal;
  }

  private expired(): boolean {
    return (
      this.signal?.aborted === true || (this.deadline !== undefined && Date.now() >= this.deadline)
    );
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const entries = Object.entries(questions).map(
      ([name, question]) => [name, noulQuestion(name, question)] as const,
    );
    const answers: JevResponse['answers'] = {};
    let failure: unknown;
    let stopped = false;
    let inputTokens = 0;
    let decided = 0;
    const work = Promise.all(
      entries.map(([name, question]) =>
        this.schedule(async () => {
          if (failure !== undefined || stopped || this.expired()) return;
          try {
            const decision = await this.request(state, question.instructions, noulOptions(question));
            if (stopped) return;
            answers[name] = { type: 'noul', noul: decision.probabilities[0]! };
            inputTokens += decision.promptTokens ?? 0;
            decided++;
          } catch (error) {
            failure ??= error;
          }
        }, this.priority),
      ),
    );
    try {
      await beforeDeadline(work, this.deadline, 'local classifier batch');
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error;
      stopped = true;
    }
    if (failure !== undefined) {
      throw new PartialAnswersError(
        failure instanceof Error ? failure.message : String(failure),
        { ...answers },
      );
    }
    if (stopped || decided < entries.length) {
      throw new PartialAnswersError(
        `local classifier ${this.signal?.aborted ? 'stopped' : 'time budget reached'} (${decided}/${entries.length} questions answered)`,
        { ...answers },
        true,
      );
    }
    return {
      model: this.model,
      answers,
      usage: { input_tokens: inputTokens, output_tokens: decided },
    };
  }

  /**
   * One decision among 2 to 10 mutually exclusive options, through the shared
   * queue: the probability of each option, renormalised over the options.
   */
  async decide(state: JevState, question: string, options: readonly string[]): Promise<ChoiceDecision> {
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('question must be a non-empty string');
    }
    const declared = validOptions(options);
    const decision = await beforeDeadline(
      this.schedule(() => this.request(state, question, declared), this.priority),
      this.deadline,
      'local classifier decision',
    );
    let best = 0;
    decision.probabilities.forEach((p, index) => {
      if (p > decision.probabilities[best]!) best = index;
    });
    return {
      choice: declared[best]!,
      probabilities: decision.probabilities,
      ...(decision.promptTokens === undefined ? {} : { promptTokens: decision.promptTokens }),
    };
  }

  private async request(
    state: JevState,
    question: string,
    options: readonly string[],
  ): Promise<LocalDecision> {
    const prompt = decisionPrompt(state, question, options);
    const tokens = estimateTokens(prompt) + MAX_TOKENS;
    if (tokens > this.contextTokens) {
      throw new Error(
        `local classifier context overflow: prompt ~${tokens} tokens exceeds ${this.contextTokens}`,
      );
    }
    const request = buildLocalRequest({ baseUrl: this.baseUrl, model: this.model }, prompt);
    let response: LocalFetchResponse;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (error) {
      throw new Error(
        `local classifier unreachable at ${request.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return parseLocalResponse(response.status, response.ok, response.text, options.length);
  }
}
