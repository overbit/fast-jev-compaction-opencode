import { estimateTokens, type JevAsker, type JevQuestions, type JevResponse, type JevState } from "./core.js"

export interface TypeSafeOptions {
  apiKey: string
  model?: string
  baseUrl?: string
}

export function typeSafeAsker(options: TypeSafeOptions): JevAsker {
  return {
    async ask(state, questions) {
      const response = await fetch(options.baseUrl ?? "https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: options.model ?? "jev-latest", state, questions }),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`Jev request failed (${response.status}): ${text.slice(0, 200)}`)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error("Jev returned malformed JSON") }
      if (!parsed || typeof parsed !== "object" || !("answers" in parsed)) {
        throw new Error("Jev response is missing answers")
      }
      return parsed as JevResponse
    },
  }
}

export interface LocalOptions {
  baseUrl?: string
  model?: string
  concurrency?: number
  contextTokens?: number
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

function prompt(state: JevState, question: string): string {
  return `You are a decision function. Read the state, then answer the question by choosing exactly one option.

[State]
${JSON.stringify(state)}

[Question]
${question}

[Options]
A. yes
B. no

Answer:`
}

function parseLogprobs(body: any): number {
  const top = body?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs
  if (!Array.isArray(top) || top.length === 0) {
    throw new Error("local classifier returned no top_logprobs")
  }
  const probs = new Map<string, number>()
  for (const item of top) {
    if (typeof item?.token !== "string" || typeof item?.logprob !== "number") continue
    probs.set(item.token.trim(), item.logprob)
  }
  const floor = Math.min(...probs.values()) - 5
  const logits = [probs.get("A") ?? floor, probs.get("B") ?? floor]
  const max = Math.max(...logits)
  const exps = logits.map((x) => Math.exp(x - max))
  return exps[0]! / (exps[0]! + exps[1]!)
}

async function localDecision(state: JevState, question: string, options: Required<LocalOptions>): Promise<number> {
  const text = prompt(state, question)
  const tokens = estimateTokens(text) + 2
  if (tokens > options.contextTokens) {
    throw new Error(`local classifier context overflow: ~${tokens} > ${options.contextTokens}`)
  }
  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: text }],
      temperature: 0,
      max_tokens: 2,
      logprobs: true,
      top_logprobs: 10,
    }),
  })
  const bodyText = await response.text()
  if (!response.ok) throw new Error(`local classifier request failed (${response.status}): ${bodyText.slice(0, 200)}`)
  let body: unknown
  try { body = JSON.parse(bodyText) } catch { throw new Error("local classifier returned malformed JSON") }
  return parseLogprobs(body)
}

export function localAsker(options: LocalOptions = {}): JevAsker {
  const resolved: Required<LocalOptions> = {
    baseUrl: options.baseUrl ?? "http://127.0.0.1:1234/v1",
    model: options.model ?? "jev-style-qwen3.5-2b-decision-mlx",
    concurrency: Math.max(1, Math.floor(options.concurrency ?? 2)),
    contextTokens: options.contextTokens ?? 64_000,
  }
  return {
    async ask(state, questions: JevQuestions): Promise<JevResponse> {
      const entries = Object.entries(questions)
      const answers: JevResponse["answers"] = {}
      let cursor = 0
      const workers = Array.from({ length: Math.min(resolved.concurrency, entries.length) }, async () => {
        while (cursor < entries.length) {
          const index = cursor++
          const [name, question] = entries[index]!
          answers[name] = { type: "noul", noul: await localDecision(state, question.instructions, resolved) }
        }
      })
      await Promise.all(workers)
      return { model: resolved.model, answers }
    },
  }
}
