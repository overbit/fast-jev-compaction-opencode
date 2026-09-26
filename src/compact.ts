import { noulAnswer, PartialAnswersError } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/**
 * A compaction in which some requests failed. `result` applies only the
 * answers that came back; every call without both answers keeps its default
 * of 1, so nothing is dropped without a judgment.
 */
export class PartialCompactionError extends Error {
  constructor(
    message: string,
    readonly result: CompactResult,
  ) {
    super(message);
    this.name = 'PartialCompactionError';
  }
}

function partialAnswers(
  batch: readonly ToolCall[],
  answers: PartialAnswersError['answers'],
): Map<string, CallAnswer> {
  const valid = (name: string): number | undefined => {
    try {
      return noulAnswer(answers, name);
    } catch {
      return undefined;
    }
  };
  const partial = new Map<string, CallAnswer>();
  for (const call of batch) {
    const keepCall = valid(`call_${call.id}`);
    const keepResult = valid(`result_${call.id}`);
    if (keepCall === undefined && keepResult === undefined) continue;
    partial.set(call.tool_use_id, { keepCall: keepCall ?? 1, keepResult: keepResult ?? 1 });
  }
  return partial;
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.tool_use_id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** What the classifier answered about a transcript's candidate calls. */
export interface Classification {
  /** Keep probabilities by `tool_use_id`; a call missing here is kept. */
  answers: Map<string, CallAnswer>;
  /** Requests that failed; their batches' answered questions are still in `answers`. */
  failures: unknown[];
  /** The asker stopped at its deadline before every question was answered. */
  timedOut: boolean;
  candidates: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
}

/**
 * Asks the classifier, for every tool call outside the pinned first and
 * newest messages, whether the call and whether its result must stay. The
 * whole history (results omitted, fitted into `maxStateTokens`) is sent as
 * state with every batch of questions. Failed batches are collected, not
 * thrown; a history that cannot be fitted throws.
 */
export async function classifyCalls(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<Classification> {
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const classification: Classification = {
    answers: new Map(),
    failures: [],
    timedOut: false,
    candidates: candidates.length,
    stateTokens: 0,
    stateStage: '',
    requests: 0,
  };
  if (candidates.length === 0) return classification;
  const state = fitState(messages, calls, resolved);
  classification.stateTokens = state.tokens;
  classification.stateStage = state.stage;
  const batches = batchCalls(candidates, state.tokens, resolved);
  classification.requests = batches.length;
  const settled = await Promise.allSettled(
    batches.map((batch) => askBatch(asker, state.state, batch)),
  );
  settled.forEach((outcome, index) => {
    let map: Map<string, CallAnswer> | undefined;
    if (outcome.status === 'fulfilled') map = outcome.value;
    else {
      const reason: unknown = outcome.reason;
      if (reason instanceof PartialAnswersError) {
        map = partialAnswers(batches[index]!, reason.answers);
        if (reason.timedOut) classification.timedOut = true;
        else classification.failures.push(reason);
      } else classification.failures.push(reason);
    }
    for (const [id, answer] of map ?? []) classification.answers.set(id, answer);
  });
  return classification;
}

/**
 * Applies answers (by `tool_use_id`) to a transcript: every call without an
 * answer keeps its default of 1, so nothing is dropped without a judgment.
 * The answers may come from an earlier classification of a transcript this
 * one extends; pinning is decided on this one.
 */
export function compactWithAnswers(
  messages: readonly Message[],
  classification: Pick<Classification, 'answers'> & Partial<Classification>,
  options: CompactOptions = {},
  started: number = Date.now(),
): CompactResult {
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const decisions = calls.map((call) =>
    decideCall(
      call,
      classification.answers.get(call.tool_use_id) ?? { keepCall: 1, keepResult: 1 },
      resolved,
    ),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: classification.stateTokens ?? 0,
      stateStage: classification.stateStage ?? '',
      requests: classification.requests ?? 0,
      ms: Date.now() - started,
    },
  };
}

/**
 * Compacts a transcript: `classifyCalls`, then `compactWithAnswers`. Throws
 * when the history cannot be fitted; when a request fails the error is a
 * `PartialCompactionError` whose `result` applies the answers that did come
 * back. An asker that stops at its deadline is not a failure: the calls it
 * did not reach are kept.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const classification = await classifyCalls(messages, asker, options);
  const result = compactWithAnswers(messages, classification, options, started);
  const [first] = classification.failures;
  if (classification.failures.length > 0) {
    throw new PartialCompactionError(
      `${first instanceof Error ? first.message : String(first)} (${classification.answers.size}/${classification.candidates} calls decided)`,
      result,
    );
  }
  return result;
}
