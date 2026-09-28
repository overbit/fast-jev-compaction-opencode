# fast-jev-compaction-opencode

Fast JEV compaction for OpenCode V2.

This ports [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) to the OpenCode V2 plugin API and keeps the OpenAI-compatible local backend approach from [lkntfnd/fast-jev-compaction-local](https://github.com/lkntfnd/fast-jev-compaction-local).

Instead of asking a model to rewrite old context, the plugin asks JEV which completed tool calls/results are still needed. Retained user/assistant text and retained tool output are carried into the checkpoint without a model-generated summary.

## Install

Install the package with OpenCode V2:

```sh
opencode plugin add github:overbit/fast-jev-compaction-opencode
```

The package exposes:

- the server plugin at the package root / `./server`;
- the CLI companion at `./tui`, so it appears in OpenCode's Plugins UI.

Because the repository is private, Git on the machine running OpenCode must already have credentials that can read `overbit/fast-jev-compaction-opencode`.

### TypeSafe JEV

TypeSafe is the default backend:

```sh
export TYPESAFE_API_KEY=...
```

No plugin options are required.

### Local / LM Studio

OpenCode V2 uses the `plugins` config key and object-form options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local"
      }
    }
  ]
}
```

Defaults:

- endpoint: `http://127.0.0.1:1234/v1`
- model: `jev-style-qwen3.5-2b-decision-mlx`
- concurrency: `2`
- local context ceiling: `64000`

The current LM Studio adapter uses the older Jev-Style Qwen3.5 2B decision model because it
exposes the next-token `top_logprobs` that this plugin reads. The newer Jev-Style v3
0.8B/2B releases use their own scoring runtime; the model author explicitly notes that
stock LM Studio can load those weights but cannot produce the v3 decision scores. Do not
set `localModel` to a v3 checkpoint with this backend unless a future LM Studio/runtime
exposes the required scoring protocol.

References:

- [Jev-Style runtime and model compatibility](https://github.com/lawrence3699/jev-style)
- [Jev-Style Qwen3.5 2B v1 GGUF](https://huggingface.co/chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-GGUF)
- [local LM Studio reference implementation](https://github.com/lkntfnd/fast-jev-compaction-local)

#### Minimum machine requirements

The model is small by current LLM standards, but the loaded context also consumes memory.
Published v1 GGUF weight sizes are about **1.3 GB (Q4_K_M)**, **2.1 GB (Q8_0)** and
**3.9 GB (BF16)**. The figures below are conservative deployment guidance for this plugin,
not official hardware guarantees from the model author:

| Setup | Practical minimum | Suggested plugin settings |
| --- | --- | --- |
| CPU-only / low-memory laptop | 8 GB system RAM, modern 4-core CPU, Q4_K_M | `localConcurrency: 1`, `localContextTokens: 8000-16000` |
| Small discrete GPU | 4 GB VRAM + 8 GB system RAM, Q4_K_M | `localConcurrency: 1`, `localContextTokens: 16000` |
| Recommended general setup | 16 GB RAM/unified memory or 8 GB+ VRAM | `localConcurrency: 2`, `localContextTokens: 32000-64000` |
| Apple Silicon | M1 or newer; 16 GB unified memory recommended | MLX build in LM Studio, `localConcurrency: 2` |

A GPU is **not required**. CPU inference works, but compaction can be noticeably slower
because fast-JEV may make two classifier decisions for each eligible completed tool call.
For the default `64000` context ceiling, use substantially more memory than the model
weights alone require; on an 8 GB machine, lower `localContextTokens` first.

`localContextTokens` is only the plugin-side safety ceiling. It must be no higher than
the context length actually loaded in LM Studio. If LM Studio is configured for 16K,
set the plugin to `16000` (or slightly below) instead of leaving the 64K default.

The classifier needs `logprobs` with `top_logprobs`, because it decides by reading the
probability distribution over the option letters. A model that answers in
`reasoning_content` instead returns `logprobs: null` and cannot drive it, regardless of
endpoint or authentication. The documented 2B v1 model above is the supported default for
this LM Studio adapter. If compaction falls back on every run, check the `reason` in the
log first.

Override the endpoint/model when needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "localBaseUrl": "http://127.0.0.1:1234/v1",
        "localModel": "my-jev-model"
      }
    }
  ]
}
```

`localBaseUrl` must include the OpenAI-compatible path prefix (`/v1` for LM Studio). A
proxy that authenticates also needs `localApiKey`, which is sent as
`Authorization: Bearer`:

```jsonc
{
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "localBaseUrl": "http://127.0.0.1:8080/v1",
        "localModel": "jev-style-qwen3.5-2b-decision",
        "localApiKey": "{env:MODEL_PROXY_API_KEY}"
      }
    }
  ]
}
```

The proxy must pass `logprobs` and `top_logprobs` through untouched, and must not inject
`tools` or force streaming; an LM Studio backend rejects `logprobs` in that combination.
A router that namespaces model ids (a `provider/model` prefix) will also read that prefix
as a provider to authenticate for and answer 401, so use the bare model id.

`localApiKey` is separate from the TypeSafe `apiKey` so a TypeSafe credential is never
sent to a local endpoint or proxy. It is never written to the plugin log; the
`initialized` line reports only `apiKey: set` or `apiKey: none`.

## Updating from the earlier V1 build

Earlier revisions of this repository used the OpenCode V1 package `@opencode-ai/plugin`. OpenCode 2 rejects that module shape.

Remove the cached git package once:

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/github:overbit/fast-jev-compaction-opencode"
```

Then reinstall:

```sh
opencode plugin add github:overbit/fast-jev-compaction-opencode
```

If the package is already configured, run the appropriate OpenCode V2 update/re-add command after clearing the cache, then restart the OpenCode service/TUI.

## How the V2 integration works

The server entrypoint is a real OpenCode V2 definition:

```ts
Plugin.define({
  id: "fast-jev-compaction-opencode",
  async setup(ctx) {
    await ctx.session.hook("compaction", async (event) => {
      // classify old tool calls/results with JEV
      // set event.result.summary on a useful reduction
    })
  }
})
```

On a compaction request:

1. OpenCode supplies the transcript through the V2 `compaction` session hook.
2. The transcript is adapted to the upstream fast-JEV core.
3. JEV classifies completed tool calls/results.
4. Calls/results are kept, result-truncated, or removed using the upstream policy.
5. When the reduction reaches `minReductionRatio`, the plugin sets `event.result.summary` itself, so OpenCode skips its normal summary-model call.
6. If JEV fails or the reduction is too small, the hook leaves `event.result` unset and OpenCode performs its normal compaction.

OpenCode V2 currently accepts a compaction result as a summary string, not an arbitrary replacement message list. The plugin therefore serializes the retained transcript deterministically into the checkpoint rather than asking another model to summarize it.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `backend` | `typesafe` | `typesafe` or `local` |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | TypeSafe JEV model |
| `baseUrl` | TypeSafe System One | Remote TypeSafe endpoint |
| `localBaseUrl` | `http://127.0.0.1:1234/v1` | OpenAI-compatible local endpoint |
| `localModel` | `jev-style-qwen3.5-2b-decision-mlx` | Local model id |
| `localApiKey` | none | Bearer token for `localBaseUrl`; needed when a proxy fronts the model |

`localBaseUrl` must include the OpenAI-compatible path prefix (`/v1` for LM Studio).
Omitting it is the most common misconfiguration, and it fails quietly: LM Studio's
router answers the unknown route with `200` and an error envelope, so the failure
surfaces as a classifier refusal rather than a bad-config error.
| `localConcurrency` | `2` | Parallel local decisions |
| `localContextTokens` | `64000` | Local decision prompt ceiling |
| `keepThreshold` | `0.5` | Minimum probability to keep a call/result |
| `preserveRecentMessages` | `6` | Newest adapted messages never pruned |
| `maxStateTokens` | `25000` | JEV state ceiling |
| `maxRequestTokens` | `30000` | Remote request ceiling |
| `truncateHeadChars` | `300` | Head retained when only a result is dropped |
| `minReductionRatio` | `0.25` | Fall back to normal OpenCode compaction below this reduction |

## Troubleshooting

Diagnostics go to `~/.local/share/opencode/log/fast-jev-compaction.log` (override with
`logFile`). Plugin `console` output is not captured by OpenCode, so the log file is the
only place these appear. Successful server load prints the resolved configuration:

```text
2026-09-28T13:36:39.605Z [INFO] [fast-jev-compaction-opencode] initialized {"backend":"local","endpoint":"http://127.0.0.1:1234/v1","model":"jev-style-qwen3.5-2b-decision-mlx","apiKey":"none","preserveRecentMessages":6}
```

A local request is only necessary when there is at least one **completed tool call outside
the pinned recent-message window**. With the default `preserveRecentMessages: 6`, a short
session can therefore run `/compact` without contacting LM Studio; this is expected
upstream fast-JEV behavior, not a failed hook.

Each compaction ends in one `compaction outcome` line. `outcome: override` means the plugin
replaced OpenCode's summary; anything else fell back to normal compaction.

| `reason` | Meaning |
| --- | --- |
| `no-eligible-completed-tool-calls` | Nothing outside the pinned window; no request was needed |
| `server-error-envelope` | The endpoint answered a 2xx with an error; usually a missing `/v1` in `localBaseUrl` |
| `http-request-failed` | The server refused; read `server` for its own message |
| `endpoint-unreachable` | Nothing is listening at `localBaseUrl` |
| `context-overflow` | The prompt exceeded the model's context window |
| `model-has-no-logprobs` | The model answered in `reasoning_content` and sent `logprobs: null`; it cannot drive the classifier, so `localModel` must change |
| `invalid-classifier-response` | No `logprobs`/`top_logprobs` in the reply; the endpoint cannot serve this classifier |
| `malformed-classifier-response` | The reply was not a chat completion at all |
| `classifier-error` | Unclassified; the `server` field carries the message |

For a deterministic LM Studio smoke test, temporarily make every completed call eligible and accept any reduction:

```jsonc
{
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "preserveRecentMessages": 0,
        "minReductionRatio": 0
      }
    }
  ]
}
```

Run at least one tool call to completion and then run `/compact`. The log should show
`"candidates":1` (or more) and `"outcome":"override"`, while LM Studio receives the
decision requests. Restore the normal preservation/reduction settings after the smoke
test.

The classifier needs `logprobs` with `top_logprobs`, because it reads the probability
distribution over the option letters. A proxy in front of the model that injects `tools`
or forces streaming will break it, and the server will say so:

```text
[WARN] [fast-jev-compaction-opencode] compaction outcome {"outcome":"fallback","reason":"http-request-failed","status":"400","server":"[400]: Engine protocol predict request returned 400: {\"error\":{\"code\":400,\"message\":\"logprobs is not supported with tools + stream\"}}"}
```

Point `localBaseUrl` straight at the model server in that case. The logged `server` text
is the server's own diagnostic, length-capped and with the prompt scaffolding redacted;
the rest of the response body is never written to the log.

If the Plugins UI reports `Invalid V2 TUI plugin module`, clear the cached package and reinstall; that error identifies an older V1 revision.

If installation fails with `NpmInstallFailedError`, verify GitHub access first. The package intentionally contains no npm/git preparation lifecycle scripts because OpenCode's git installer can fail on those before plugin loading.

## Development

```sh
npm install
npm run typecheck
npm test
npm run compile
```

Tests do not contact TypeSafe or LM Studio.

## License and attribution

MIT. See `NOTICE` for upstream attribution.
