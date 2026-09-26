export type Role = "user" | "assistant"

export interface ToolUse {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
}

export interface ToolResult {
  tool_use_id: string
  text: string
  isError?: boolean
}

export interface Message {
  role: Role
  text: string
  toolUses: ToolUse[]
  toolResults?: ToolResult[]
}

export interface JevState {
  context: string
  goal: string
  history: Array<{
    i: number
    role: Role
    text: string
    tool_calls?: Array<{ id: string; tool: string; input: string; result: string }>
  }>
}

export interface JevQuestion {
  type: "noul"
  instructions: string
}

export type JevQuestions = Record<string, JevQuestion>

export interface JevResponse {
  model?: string
  answers: Record<string, { type?: "noul"; noul: number }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}

export interface CompactOptions {
  goal?: string
  keepThreshold?: number
  preserveRecentMessages?: number
  maxStateTokens?: number
  maxRequestTokens?: number
  truncateHeadChars?: number
}

export interface CompactResult {
  messages: Message[]
  decisions: Array<{
    id: string
    tool: string
    keepCall: number
    keepResult: number
    action: "keep" | "drop_result" | "drop_call"
    reason: "pinned" | "kept" | "result_dropped" | "call_dropped"
  }>
  stats: {
    messagesBefore: number
    messagesAfter: number
    charsBefore: number
    charsAfter: number
    calls: number
    kept: number
    resultsDropped: number
    callsDropped: number
    pinned: number
    stateTokens: number
    requests: number
  }
}

interface ToolCall {
  id: string
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  callIndex: number
  resultIndex: number
  resultChars: number
  isError: boolean
  pinned: boolean
}

const DEFAULTS = {
  keepThreshold: 0.5,
  preserveRecentMessages: 0,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
}

const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. history is the conversation being replaced, oldest first. Tool outputs are represented by short result notes. Each question asks whether a tool call, or the full output of that call, still needs to stay verbatim. Anything not kept is deleted, but tools can be run again."

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6)
    } else tokens += 0.9
  }
  return Math.ceil(tokens)
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "user" && message.text.trim() && !(message.toolResults?.length))
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join("\n")
}

function collectToolCalls(messages: readonly Message[], preserveRecentMessages: number): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>()
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, { index, result })
  })

  const calls: ToolCall[] = []
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id)
      if (!found) continue
      const pinned = callIndex === 0 ||
        callIndex >= messages.length - preserveRecentMessages ||
        found.index >= messages.length - preserveRecentMessages
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned,
      })
    }
  })
  return calls
}

function buildState(messages: readonly Message[], calls: readonly ToolCall[], goal: string, maxStateTokens: number) {
  const byMessage = new Map<number, ToolCall[]>()
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? []
    list.push(call)
    byMessage.set(call.callIndex, list)
  }

  const make = (inputLimit: number, textLimit: number): JevState => ({
    context: STATE_CONTEXT,
    goal,
    history: messages.flatMap((message, i) => {
      const tool_calls = (byMessage.get(i) ?? []).map((call) => ({
        id: call.id,
        tool: call.tool,
        input: truncate(stringify(call.input), inputLimit),
        result: `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`,
      }))
      const text = truncate(message.text, textLimit)
      if (!text.trim() && tool_calls.length === 0) return []
      return [{ i, role: message.role, text, ...(tool_calls.length ? { tool_calls } : {}) }]
    }),
  })

  for (const [inputLimit, textLimit] of [[1000, 4000], [200, 2000], [60, 800], [60, 300]] as const) {
    const state = make(inputLimit, textLimit)
    const tokens = estimateTokens(JSON.stringify(state))
    if (tokens <= maxStateTokens) return { state, tokens }
  }
  throw new Error(`history too large for Jev after truncation (limit ${maxStateTokens} tokens)`)
}

function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  }
}

function answer(response: JevResponse, name: string): number {
  const value = response.answers[name]?.noul
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Jev answer for ${name}`)
  return value
}

function resultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${isError ? " (error)" : ""}; re-run the tool if needed]`
}

function chars(message: Message): number {
  return message.text.length +
    message.toolUses.reduce((sum, tool) => sum + stringify(tool.input).length, 0) +
    (message.toolResults ?? []).reduce((sum, result) => sum + result.text.length, 0)
}

export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const keepThreshold = options.keepThreshold ?? DEFAULTS.keepThreshold
  const preserveRecentMessages = Math.max(0, Math.floor(options.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages))
  const maxStateTokens = options.maxStateTokens ?? DEFAULTS.maxStateTokens
  const maxRequestTokens = options.maxRequestTokens ?? DEFAULTS.maxRequestTokens
  const truncateHeadChars = Math.max(0, Math.floor(options.truncateHeadChars ?? DEFAULTS.truncateHeadChars))
  const calls = collectToolCalls(messages, preserveRecentMessages)
  const candidates = calls.filter((call) => !call.pinned)
  const { state, tokens: stateTokens } = candidates.length
    ? buildState(messages, calls, options.goal ?? goalFromMessages(messages), maxStateTokens)
    : { state: { context: STATE_CONTEXT, goal: "", history: [] }, tokens: 0 }

  const decisions = new Map<string, CompactResult["decisions"][number]>()
  for (const call of calls.filter((call) => call.pinned)) {
    decisions.set(call.tool_use_id, {
      id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: "keep", reason: "pinned",
    })
  }

  let requests = 0
  let batch: ToolCall[] = []
  let batchTokens = 0
  const flush = async () => {
    if (!batch.length) return
    const questions = Object.assign({}, ...batch.map(questionsFor))
    requests++
    const response = await asker.ask(state, questions)
    for (const call of batch) {
      const keepCall = answer(response, `call_${call.id}`)
      const keepResult = answer(response, `result_${call.id}`)
      const action = keepResult >= keepThreshold ? "keep" : keepCall >= keepThreshold ? "drop_result" : "drop_call"
      const reason = action === "keep" ? "kept" : action === "drop_result" ? "result_dropped" : "call_dropped"
      decisions.set(call.tool_use_id, { id: call.id, tool: call.tool, keepCall, keepResult, action, reason })
    }
    batch = []
    batchTokens = 0
  }

  for (const call of candidates) {
    const qTokens = estimateTokens(JSON.stringify(questionsFor(call)))
    if (stateTokens + qTokens + 20 > maxRequestTokens) {
      throw new Error(`state leaves no room for Jev questions (~${stateTokens}/${maxRequestTokens} tokens)`)
    }
    if (batch.length && stateTokens + batchTokens + qTokens + 20 > maxRequestTokens) await flush()
    batch.push(call)
    batchTokens += qTokens
  }
  await flush()

  const output: Message[] = []
  for (const message of messages) {
    const toolUses = message.toolUses.filter((tool) => decisions.get(tool.tool_use_id)?.action !== "drop_call")
    const toolResults = (message.toolResults ?? [])
      .filter((result) => decisions.get(result.tool_use_id)?.action !== "drop_call")
      .map((result) => decisions.get(result.tool_use_id)?.action === "drop_result"
        ? { ...result, text: resultText(result.text, result.isError ?? false, truncateHeadChars) }
        : result)

    if (!message.text.trim() && toolUses.length === 0 && toolResults.length === 0) continue
    output.push({ role: message.role, text: message.text, toolUses, ...(toolResults.length ? { toolResults } : {}) })
  }

  const list = [...decisions.values()]
  return {
    messages: output,
    decisions: list,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: output.length,
      charsBefore: messages.reduce((sum, message) => sum + chars(message), 0),
      charsAfter: output.reduce((sum, message) => sum + chars(message), 0),
      calls: calls.length,
      kept: list.filter((d) => d.reason === "kept").length,
      resultsDropped: list.filter((d) => d.reason === "result_dropped").length,
      callsDropped: list.filter((d) => d.reason === "call_dropped").length,
      pinned: list.filter((d) => d.reason === "pinned").length,
      stateTokens,
      requests,
    },
  }
}

export function reductionRatio(result: Pick<CompactResult, "stats">): number {
  return result.stats.charsBefore === 0
    ? 0
    : (result.stats.charsBefore - result.stats.charsAfter) / result.stats.charsBefore
}
