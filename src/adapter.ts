import type { Message as CompactMessage, ToolResult, ToolUse } from "./core.js"

type OpenCodePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; result: { type: string; value: unknown } }
  | { type: string; [key: string]: unknown }

export interface OpenCodeMessage {
  role: string
  content: OpenCodePart[]
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input }
}

function resultText(result: { type: string; value: unknown }): string {
  if (typeof result.value === "string") return result.value
  try {
    return JSON.stringify(result.value)
  } catch {
    return String(result.value)
  }
}

export function toCompactMessages(messages: readonly OpenCodeMessage[]): CompactMessage[] {
  return messages.flatMap((message) => {
    const texts: string[] = []
    const toolUses: ToolUse[] = []
    const toolResults: ToolResult[] = []

    for (const part of message.content ?? []) {
      if ((part.type === "text" || part.type === "reasoning") && typeof (part as any).text === "string") {
        texts.push((part as any).text)
      } else if (part.type === "tool-call") {
        const p = part as Extract<OpenCodePart, { type: "tool-call" }>
        toolUses.push({ tool_use_id: p.id, tool: p.name, input: objectInput(p.input) })
      } else if (part.type === "tool-result") {
        const p = part as Extract<OpenCodePart, { type: "tool-result" }>
        toolResults.push({
          tool_use_id: p.id,
          text: resultText(p.result),
          isError: p.result.type === "error",
        })
      }
    }

    if (!texts.length && !toolUses.length && !toolResults.length) return []

    return [{
      role: message.role === "assistant" ? "assistant" : "user",
      text: texts.join("\n"),
      toolUses,
      ...(toolResults.length ? { toolResults } : {}),
    }]
  })
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify("[unserializable]")
  }
}

/**
 * Encodes the selected transcript as a deterministic compaction checkpoint.
 * Text and tool-result bodies are copied verbatim; only structural labels are added.
 */
export function serializeCompaction(messages: readonly CompactMessage[]): string {
  const sections: string[] = [
    "# Fast JEV Compaction",
    "",
    "The following retained conversation is authoritative. It was selected, not summarized.",
  ]

  for (const message of messages) {
    sections.push("", `<message role="${message.role}">`)
    if (message.text) {
      sections.push("<text>", message.text, "</text>")
    }
    for (const tool of message.toolUses) {
      sections.push(
        `<tool_call id="${tool.tool_use_id}" name="${tool.tool}">`,
        json(tool.input),
        "</tool_call>",
      )
    }
    for (const result of message.toolResults ?? []) {
      sections.push(
        `<tool_result id="${result.tool_use_id}" error="${result.isError ? "true" : "false"}">`,
        result.text,
        "</tool_result>",
      )
    }
    sections.push("</message>")
  }

  return sections.join("\n")
}
