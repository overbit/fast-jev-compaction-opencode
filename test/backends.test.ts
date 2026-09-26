import { afterEach, describe, expect, it, vi } from "vitest"
import { localAsker, typeSafeAsker } from "../src/backends.js"

afterEach(() => vi.unstubAllGlobals())

describe("TypeSafe backend", () => {
  it("sends System One state and questions", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe("jev-latest")
      expect(body.state.goal).toBe("ship")
      return new Response(JSON.stringify({ answers: { keep: { noul: 0.9 } } }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)

    const response = await typeSafeAsker({ apiKey: "test" }).ask(
      { context: "ctx", goal: "ship", history: [] },
      { keep: { type: "noul", instructions: "keep?" } },
    )
    expect(response.answers.keep?.noul).toBe(0.9)
  })
})

describe("local backend", () => {
  it("derives noul probability from OpenAI-compatible logprobs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          logprobs: {
            content: [{
              top_logprobs: [
                { token: "A", logprob: -0.1 },
                { token: "B", logprob: -2.0 },
              ],
            }],
          },
        }],
      }), { status: 200 }),
    ))

    const response = await localAsker({ concurrency: 1 }).ask(
      { context: "ctx", goal: "ship", history: [] },
      { keep: { type: "noul", instructions: "keep?" } },
    )
    expect(response.answers.keep?.noul).toBeGreaterThan(0.8)
  })
})
