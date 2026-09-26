# fast-jev-compaction-opencode

Verbatim JEV-guided context pruning for OpenCode 2.x.

This is an OpenCode port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), with the OpenAI-compatible local classifier approach from [lkntfnd/fast-jev-compaction-local](https://github.com/lkntfnd/fast-jev-compaction-local).

Instead of summarizing tool history, the plugin asks a decision model whether each completed tool call and its full result still matter. User and assistant text is kept verbatim. A tool result may be kept, truncated, or removed together with its call.

## Backends

### TypeSafe JEV

Default backend. Set `TYPESAFE_API_KEY` in the environment, or pass `apiKey`.

```ts
import { FastJevCompaction } from "fast-jev-compaction-opencode"

export const FastJev = (ctx: Parameters<typeof FastJevCompaction>[0]) =>
  FastJevCompaction(ctx, {
    backend: "typesafe",
    model: "jev-latest"
  })
```

### Local / LM Studio

Uses an OpenAI-compatible `/v1/chat/completions` endpoint and reads option probabilities from `top_logprobs`.

```ts
import { FastJevCompaction } from "fast-jev-compaction-opencode"

export const FastJev = (ctx: Parameters<typeof FastJevCompaction>[0]) =>
  FastJevCompaction(ctx, {
    backend: "local",
    localBaseUrl: "http://127.0.0.1:1234/v1",
    localModel: "jev-style-qwen3.5-2b-decision-mlx",
    localConcurrency: 2,
    localContextTokens: 64000
  })
```

The local backend is compatible with LM Studio and other OpenAI-compatible servers that return token log probabilities. The reference local model is `chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-MLX-bf16`.

## Install from GitHub

OpenCode can load TypeScript plugins from `.opencode/plugins/`. Add this package as a config-directory dependency:

```json
{
  "dependencies": {
    "fast-jev-compaction-opencode": "github:overbit/fast-jev-compaction-opencode"
  }
}
```

Save that as `.opencode/package.json`, then create `.opencode/plugins/fast-jev.ts` using one of the examples above. OpenCode installs config-directory dependencies with Bun at startup.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `backend` | `typesafe` | `typesafe` or `local` |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | TypeSafe JEV model |
| `baseUrl` | TypeSafe System One | Remote endpoint |
| `localBaseUrl` | `http://127.0.0.1:1234/v1` | OpenAI-compatible local endpoint |
| `localModel` | `jev-style-qwen3.5-2b-decision-mlx` | Local model id |
| `localConcurrency` | `2` | Parallel local decisions |
| `localContextTokens` | `64000` | Local decision prompt ceiling |
| `keepThreshold` | `0.5` | Minimum probability to keep call/result |
| `preserveRecentMessages` | `6` | Newest messages never pruned |
| `maxStateTokens` | `25000` | JEV state ceiling |
| `maxRequestTokens` | `30000` | Remote request ceiling |
| `truncateHeadChars` | `300` | Head retained when only a result is dropped |
| `minReductionRatio` | `0.25` | Ignore low-value pruning passes |
| `disableBuiltinAutoCompaction` | `false` | Disable OpenCode's automatic summarizing compaction |

## OpenCode 2.x integration

The current OpenCode host plugin API exposes `experimental.chat.messages.transform`, which is used here to prune completed tool history before model calls.

The separate `@opencode-ai/plugin/v2/promise` extension surface currently does not expose session/message compaction hooks, so this project intentionally targets the OpenCode 2.x host plugin API rather than relying on a nonexistent v2 compaction hook.

By default, OpenCode's built-in automatic compaction remains enabled as a safety fallback. After verifying the JEV backend in your environment, set `disableBuiltinAutoCompaction: true` if you want this plugin to be the only automatic context-pruning mechanism. Manual OpenCode compaction remains OpenCode-controlled.

If TypeSafe JEV or the local server fails, the transform leaves the message history unchanged.

## Behavior

The pruning algorithm is inherited from the upstream implementation:

1. Pair completed tool calls with their results.
2. Keep the first and newest configured messages pinned.
3. Build a fitted state containing the conversation with tool results omitted.
4. Ask whether each call still matters and whether its full result must remain verbatim.
5. Keep the result, truncate only the result, or remove the call and result.
6. Preserve ordinary user and assistant text unchanged.

## Development

```sh
npm install
npm run typecheck
npm test
```

The tests do not contact TypeSafe or LM Studio.

## License and attribution

MIT. See `NOTICE` for upstream attribution.
