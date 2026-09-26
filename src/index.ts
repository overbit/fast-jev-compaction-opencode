import { Plugin } from "@opencode/plugin"
import { serializeCompaction, toCompactMessages, type OpenCodeMessage } from "./adapter.js"
import { localAsker, typeSafeAsker } from "./backends.js"
import { compact, reductionRatio, type CompactOptions, type JevAsker } from "./core.js"

type Backend = "typesafe" | "local"

interface PluginOptions extends CompactOptions {
  backend?: Backend
  apiKey?: string
  baseUrl?: string
  model?: string
  concurrency?: number
  contextTokens?: number
  minReductionRatio?: number
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function resolveOptions(input: Record<string, unknown>): PluginOptions {
  const backend = input.backend === "local" ? "local" : "typesafe"
  return {
    backend,
    apiKey: stringOption(input.apiKey),
    baseUrl: stringOption(input.baseUrl),
    model: stringOption(input.model),
    concurrency: numberOption(input.concurrency, 2),
    contextTokens: numberOption(input.contextTokens, 64_000),
    minReductionRatio: numberOption(input.minReductionRatio, 0.25),
    keepThreshold: numberOption(input.keepThreshold, 0.5),
    preserveRecentMessages: numberOption(input.preserveRecentMessages, 0),
    maxStateTokens: numberOption(input.maxStateTokens, 25_000),
    maxRequestTokens: numberOption(input.maxRequestTokens, 30_000),
    truncateHeadChars: numberOption(input.truncateHeadChars, 300),
    goal: stringOption(input.goal),
  }
}

function createAsker(options: PluginOptions): JevAsker {
  if (options.backend === "local") {
    return localAsker({
      baseUrl: options.baseUrl,
      model: options.model,
      concurrency: options.concurrency,
      contextTokens: options.contextTokens,
    })
  }

  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured")
  return typeSafeAsker({
    apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
  })
}

export default Plugin.define({
  id: "fast-jev-compaction",
  async setup(ctx) {
    const options = resolveOptions(ctx.options as Record<string, unknown>)

    await ctx.session.hook("compaction", async (event) => {
      try {
        const messages = toCompactMessages(event.messages as unknown as OpenCodeMessage[])
        const result = await compact(messages, createAsker(options), options)

        if (reductionRatio(result) < (options.minReductionRatio ?? 0.25)) return

        event.result = {
          summary: serializeCompaction(result.messages),
          metadata: {
            "fast-jev-compaction": {
              backend: options.backend,
              reductionRatio: reductionRatio(result),
              ...result.stats,
            },
          },
        }
      } catch {
        // Leaving result unset deliberately falls back to OpenCode's normal compaction.
      }
    })
  },
})

export * from "./adapter.js"
export * from "./backends.js"
export * from "./core.js"
