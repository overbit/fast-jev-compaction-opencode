# fast-jev-compaction-opencode

Verbatim JEV-guided context pruning for OpenCode 2.x.

This is an OpenCode port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), with the OpenAI-compatible local classifier approach from [lkntfnd/fast-jev-compaction-local](https://github.com/lkntfnd/fast-jev-compaction-local).

Instead of summarizing tool history, the plugin asks a decision model whether each completed tool call and its full result still matter. User and assistant text is kept verbatim. A tool result may be kept, truncated, or removed together with its call.

## Install

Add the plugin directly to `opencode.json`. No wrapper plugin file and no `.opencode/package.json` are required.

### TypeSafe JEV

Set the API key:

```sh
export TYPESAFE_API_KEY=...
```

Then add:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:overbit/fast-jev-compaction-opencode"]
}
```

That is the complete TypeSafe installation.

### Local / LM Studio

With LM Studio listening on its default OpenAI-compatible URL and the default JEV-style model loaded:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "github:overbit/fast-jev-compaction-opencode",
      {
        "backend": "local"
      }
    ]
  ]
}
```

The local defaults are:

- URL: `http://127.0.0.1:1234/v1`
- model: `jev-style-qwen3.5-2b-decision-mlx`
- concurrency: `2`
- context window: `64000`

The reference local model is `chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-MLX-bf16`.

To override the endpoint or model:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "github:overbit/fast-jev-compaction-opencode",
      {
        "backend": "local",
        "localBaseUrl": "http://127.0.0.1:1234/v1",
        "localModel": "my-jev-model"
      }
    ]
  ]
}
```

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

The plugin exposes a dedicated OpenCode `./server` package entrypoint, so OpenCode can install and load the GitHub package directly from the `plugin` field.

The current OpenCode host plugin API exposes `experimental.chat.messages.transform`, which is used here to prune completed tool history before model calls.

The separate `@opencode-ai/plugin/v2/promise` extension surface currently does not expose session/message compaction hooks, so this project targets the supported OpenCode 2.x host plugin API.

By default, OpenCode's built-in automatic compaction remains enabled as a safety fallback. After verifying the JEV backend in your environment, set `disableBuiltinAutoCompaction: true` if you want this plugin to be the only automatic context-pruning mechanism.

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
npm run build
```

The tests do not contact TypeSafe or LM Studio.

## License and attribution

MIT. See `NOTICE` for upstream attribution.
