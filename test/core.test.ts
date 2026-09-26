import { describe, expect, it } from "vitest"
import { compact } from "../src/core.js"
import { serializeCompaction, toCompactMessages } from "../src/adapter.js"

describe("compaction", () => {
  it("drops a tool call and result without rewriting text", async () => {
    const messages = [
      { role: "user" as const, text: "fix it", toolUses: [] },
      { role: "assistant" as const, text: "checking", toolUses: [{ tool_use_id: "c1", tool: "read", input: { path: "a.ts" } }] },
      { role: "user" as const, text: "", toolUses: [], toolResults: [{ tool_use_id: "c1", text: "old output" }] },
    ]
    const result = await compact(messages, {
      async ask(_state, questions) {
        return {
          answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.1 }])),
        }
      },
    })
    expect(result.messages.map((m) => m.text)).toEqual(["fix it", "checking"])
    expect(result.stats.callsDropped).toBe(1)
  })
})

describe("OpenCode adapter", () => {
  it("preserves selected text and tool data in the checkpoint", () => {
    const compact = toCompactMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "exact text" },
          { type: "tool-call", id: "c1", name: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "exact result" } }],
      },
    ])
    const summary = serializeCompaction(compact)
    expect(summary).toContain("exact text")
    expect(summary).toContain("exact result")
    expect(summary).toContain('name="read"')
  })
})
