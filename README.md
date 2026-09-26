# fast-jev-compaction-opencode

OpenCode v2 port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).

Instead of asking the session model to rewrite old context into a summary, this plugin asks a fast classifier which tool calls and tool results still matter. Retained user/assistant text and retained tool output are copied into the OpenCode compaction checkpoint rather than paraphrased.

## Backends

- **TypeSafe Jev** — System One API, compatible with the original plugin.
- **Local** — an OpenAI-compatible `/chat/completions` endpoint with token logprobs, such as LM Studio. This follows the approach in [lkntfnd/fast-jev-compaction-local](https://github.com/lkntfnd/fast-jev-compaction-local).

The local default model name is `jev-style-qwen3.5-2b-decision-mlx`; override it with the `model` option to match the model identifier exposed by your server.

## Install

From GitHub while the package is not published:

```jsonc
{
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "typesafe"
      }
    }
  ]
}
```

For a local checkout:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "model": "jev-style-qwen3.5-2b-decision-mlx"
      }
    }
  ]
}
```

## TypeSafe configuration

Set the key in the environment that launches OpenCode:

```sh
export TYPESAFE_API_KEY=...
```

Or pass `apiKey` as a plugin option.

## LM Studio / local configuration

Load a Jev-style decision model in LM Studio with an OpenAI-compatible server and logprobs enabled.

```jsonc
{
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "model": "jev-style-qwen3.5-2b-decision-mlx",
        "concurrency": 2,
        "contextTokens": 64000
      }
    }
  ]
}
```

For every Jev `noul` question, the local backend sends one prompt with choices `A. yes` / `B. no`, requests `top_logprobs`, and converts the A/B token log probabilities into the keep probability.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `backend` | `typesafe` | `typesafe` or `local` |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `baseUrl` | backend-specific | TypeSafe endpoint or OpenAI-compatible base URL |
| `model` | backend-specific | Classifier model ID |
| `concurrency` | `2` | Local decisions in flight |
| `contextTokens` | `64000` | Local prompt token ceiling |
| `keepThreshold` | `0.5` | Minimum probability to keep call/result |
| `preserveRecentMessages` | `0` | Messages inside the compaction input that are pinned; OpenCode keeps its recent tail separately |
| `maxStateTokens` | `25000` | Estimated classifier-state ceiling |
| `maxRequestTokens` | `30000` | Estimated TypeSafe request ceiling |
| `truncateHeadChars` | `300` | Characters kept when only a result is dropped |
| `minReductionRatio` | `0.25` | Below this saving, fall back to normal OpenCode compaction |
| `goal` | last 3 user prompts | Explicit task description sent to the classifier |

## How it integrates with OpenCode v2

OpenCode v2 exposes a `session.hook("compaction")` hook. The hook receives the transcript OpenCode intends to replace. This plugin maps that transcript into the fast-JEV message shape, scores completed tool calls/results, drops stale calls or truncates stale results, and writes the selected transcript to `event.result.summary`. Setting `event.result` skips the normal compaction model call.

If the classifier is unavailable, malformed, or produces less than `minReductionRatio`, the plugin leaves `event.result` unset so OpenCode performs its normal compaction.

The checkpoint adds structural tags around messages and tool calls, but retained text and tool-result bodies are not rewritten.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

CI runs all three checks on pushes and pull requests.

## Attribution

The pruning design is derived from `tamaratran/fast-jev-compaction`. The local OpenAI-compatible logprob approach is derived from `lkntfnd/fast-jev-compaction-local`. Both reference projects are MIT licensed; see `NOTICE`.

## License

MIT.
