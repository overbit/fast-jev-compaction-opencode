# fast-jev-compaction-opencode

[![CI](https://github.com/overbit/fast-jev-compaction-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/overbit/fast-jev-compaction-opencode/actions/workflows/ci.yml)
[![OpenCode](https://img.shields.io/badge/OpenCode-v2-111827)](https://opencode.ai/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**JEV-guided context compaction for OpenCode V2.**

Instead of asking a generative model to rewrite old conversation history into a summary,
this plugin asks a decision model which completed tool calls and outputs are still useful.

**Keep what matters. Drop what can be re-read or re-run.**

This project ports the core approach from
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
to the OpenCode V2 plugin API, with hosted JEV and a working local LM Studio backend.

> Status: experimental. The compaction strategy is intentionally conservative and falls
> back to OpenCode's native compaction when classification fails or the reduction is too
> small to justify an override.
>
> Supported today: hosted TypeSafe JEV and the LM Studio-compatible Jev-Style 2B v1
> classifier. Jev-Style 0.8B v3 is documented below, but direct use of its scoring runtime
> is not yet implemented by this plugin.

## Why this exists

Coding agents accumulate a lot of context that is useful briefly and expensive later:
source reads, searches, test output, build logs, directory listings, diffs, and other tool
results.

Traditional compaction asks an LLM to rewrite that history into a shorter summary. That
can work well, but rewriting introduces a different failure mode: exact paths, commands,
constraints, errors, or other details may be shortened, merged, or omitted.

fast-jev-compaction takes a narrower approach:

- **classify instead of summarize** — JEV decides whether old tool history still matters;
- **preserve retained text** — retained user/assistant text and retained tool output are
  copied into the checkpoint rather than rewritten by another model;
- **protect recent work** — the newest messages are pinned by default;
- **fail open** — classifier errors or weak reductions fall back to native OpenCode
  compaction;
- **run hosted or local** — use TypeSafe JEV or an OpenAI-compatible local decision model.

The plugin is most useful for long, tool-heavy coding sessions. If a session contains few
completed tool calls, there may be little or nothing for JEV to remove.

## How it works

```text
OpenCode session
      │
      ▼
pair completed tool calls + results
      │
      ▼
protect first + recent messages
      │
      ▼
build compact JEV state
      │
      ▼
ask: keep call? keep full result?
      │
      ▼
 keep │ truncate result │ drop call + result
      │
      ▼
deterministic checkpoint
      │
      └── classifier failure / weak reduction ──► native OpenCode compaction
```

For every eligible completed tool call, JEV receives two yes/no (`noul`) questions:

```text
Tool call t1 (read) should stay in the history:
knowing this call was made, with its input, still matters
for what the assistant does next
```

```text
The full output of tool call t1 (read, 8421 chars)
should stay in the history verbatim:
the assistant still needs its contents and re-running
the tool would not do
```

With the default `keepThreshold: 0.5`:

| Decision | Result |
| --- | --- |
| full result probability >= threshold | keep call + full result |
| call probability >= threshold | keep call + truncate result |
| both below threshold | remove call + result |
| call is pinned | always keep |

The classifier sees the surrounding conversation and the tool call/input, but large tool
outputs are replaced in the JEV state with notes such as `ok, 8421 chars (omitted)`.
This keeps the decision prompt bounded while still giving the model the context needed to
judge whether the result is likely to matter later.

## Quick start

### 1. Install

```sh
opencode plugin add github:overbit/fast-jev-compaction-opencode
```

The package exposes:

- `./server` — the OpenCode V2 compaction plugin;
- `./tui` — a lightweight companion so the package appears in OpenCode's Plugins UI.

### 2. Choose a backend

#### Hosted JEV — simplest setup

TypeSafe JEV is the default backend:

```sh
export TYPESAFE_API_KEY=...
```

No plugin options are required.

#### Local LM Studio — supported today

The working local backend uses an OpenAI-compatible
`/chat/completions + top_logprobs` endpoint.

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

The local model must expose `logprobs` and `top_logprobs`. The plugin reads the
probability distribution over the decision letters; generated prose alone is not enough.

## Backend status

| Backend | Model / runtime | Status | Notes |
| --- | --- | --- | --- |
| TypeSafe | `jev-latest` | **Supported** | Default hosted backend |
| LM Studio / OpenAI-compatible | Jev-Style Qwen3.5 2B v1 | **Supported** | Uses `/chat/completions + top_logprobs` |
| Jev-Style runtime | 0.8B Decision v3 | **Not wired directly yet** | Requires the model's dedicated scoring runtime / System One-compatible API |

The newer
[`chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF`](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF)
is attractive for a future direct local backend because it is much smaller, but it does
not expose its decision scores through ordinary LM Studio/Ollama/chat generation. See
[Local models](#local-models).

## Design goals

### Non-generative pruning

JEV makes retention decisions. It does not generate a replacement summary of the
conversation.

### Conservative by default

The first message and the newest `preserveRecentMessages` messages are pinned. The
default is `6`.

Calls without completed results are never candidates.

### Safe fallback

Nothing is dropped without a classifier answer. If a request fails, unanswered calls
default to keep. If the overall reduction is below `minReductionRatio`, the plugin
leaves OpenCode's compaction result untouched so native compaction can run.

### Observable

The plugin writes its own diagnostics file with:

- resolved backend/model;
- number of adapted messages;
- completed, pinned, and candidate calls;
- classifier request/response status;
- reduction ratio;
- final override/fallback reason.

Default log:

```text
~/.local/share/opencode/log/fast-jev-compaction.log
```

Override it with `logFile`.

## Local models

### Current supported local path: LM Studio + 2B v1

The implemented `backend: "local"` adapter sends one classification prompt per JEV
question to an OpenAI-compatible chat endpoint.

The request is effectively:

```json
{
  "model": "jev-style-qwen3.5-2b-decision-mlx",
  "messages": [
    {
      "role": "user",
      "content": "[State] ... [Question] ... [Options] A. yes B. no ... Answer:"
    }
  ],
  "temperature": 0,
  "max_tokens": 2,
  "logprobs": true,
  "top_logprobs": 10
}
```

The plugin renormalizes the log-probabilities of the answer letters into the JEV
probability.

For this older 2B model, a practical baseline is **8 GB system RAM** with a quantized
build and `localConcurrency: 1`. **16 GB RAM/unified memory or 8 GB+ VRAM** is a
comfortable target for larger contexts and concurrency 2.

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
        "localModel": "jev-style-qwen3.5-2b-decision-mlx"
      }
    }
  ]
}
```

`localBaseUrl` must include the OpenAI-compatible path prefix (`/v1` for LM Studio).

A proxy that authenticates can use a separate local bearer token:

```jsonc
{
  "plugins": [
    {
      "package": "github:overbit/fast-jev-compaction-opencode",
      "options": {
        "backend": "local",
        "localBaseUrl": "http://127.0.0.1:8080/v1",
        "localModel": "jev-style-qwen3.5-2b-decision-mlx",
        "localApiKey": "{env:MODEL_PROXY_API_KEY}"
      }
    }
  ]
}
```

`localApiKey` is intentionally separate from the TypeSafe `apiKey`. The plugin never
logs the credential itself.

### Jev-Style 0.8B Decision v3 — direct backend pending

The newer
[`chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF`](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF)
is a 0.8B Qwen3.5 decision model with a substantially smaller footprint:

| Quantization | Model file | Notes |
| --- | ---: | --- |
| Q4_K_M | 0.53 GB | smallest practical build |
| Q8_0 | 0.81 GB | higher precision, still compact |
| F16 | 1.52 GB | full-precision GGUF reference |

Published runtime limits:

- up to **25,600 input tokens per decision**;
- **32,768-token runtime context** to leave room for questions/options/readout.

A GPU is not required. Practical guidance for running the classifier alongside OpenCode:

| Setup | Practical starting point |
| --- | --- |
| CPU-only | 4-core 64-bit CPU, **4 GB free RAM**, Q4_K_M |
| General laptop / desktop | **8 GB RAM**, Q4_K_M or Q8_0 |
| Apple Silicon | M1+, **8 GB unified memory**; 16 GB recommended for a full dev workload |
| Discrete GPU | **2 GB VRAM minimum**, **4 GB+ recommended** |
| Long 20K-25.6K states | **16 GB system/unified RAM** or **4-8 GB+ VRAM** |

The weight file is only part of memory use. Runtime state, tokenizer, KV/cache, OpenCode,
and any locally hosted coding model all need additional memory.

#### Important compatibility note

v3 is not a normal chat classifier. Its decision scores come from dedicated verdict slots.

Stock LM Studio, Ollama, normal llama.cpp chat generation, and `mlx_lm.generate` can
load the weights, but ordinary generation does not expose the scores required by the v3
model.

Use the model author's runtime:

```sh
# CPU / CUDA / Linux / Windows
pip install "jev-style[torch]"

# Apple silicon
pip install "jev-style[mlx]"

jev-style serve
```

That server exposes a System One-compatible endpoint, normally:

```text
http://127.0.0.1:8765/v1/systemone
```

**The plugin does not yet have a direct local System One backend.** Do not point the
current `backend: "local"` LM Studio adapter at the v3 model and expect correct
classification.

References:

- [Jev-Style 0.8B v3 GGUF](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF)
- [Jev-Style runtime](https://github.com/lawrence3699/jev-style)
- [original fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
- [LM Studio local reference implementation](https://github.com/lkntfnd/fast-jev-compaction-local)

## OpenCode V2 integration

The server entrypoint is a native OpenCode V2 plugin:

```ts
Plugin.define({
  id: "fast-jev-compaction-opencode",
  async setup(ctx) {
    await ctx.session.hook("compaction", async (event) => {
      // classify old tool calls/results with JEV
      // set event.result.summary when the reduction is useful
    })
  }
})
```

On a compaction request:

1. OpenCode supplies the transcript to the V2 compaction hook.
2. The plugin adapts the transcript to the fast-JEV message model.
3. Completed tool calls are paired with their results.
4. JEV classifies eligible calls/results.
5. The plugin rebuilds the retained transcript.
6. If reduction reaches `minReductionRatio`, the plugin supplies its own checkpoint.
7. Otherwise OpenCode's normal compaction path remains available.

### Current OpenCode limitation

OpenCode V2 currently lets a compaction plugin provide a **summary string**, not an
arbitrary replacement message list.

That means this port cannot yet hand OpenCode the pruned structured messages directly.
Instead, it serializes the retained transcript deterministically into the compaction
checkpoint. Retained text is not model-rewritten, but the original message/tool structure
is flattened into that checkpoint string.

This is the biggest difference between the ideal upstream fast-JEV behavior and what the
current OpenCode V2 compaction hook can express.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `backend` | `typesafe` | `typesafe` or `local` |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | TypeSafe JEV model |
| `baseUrl` | TypeSafe System One | Remote TypeSafe endpoint |
| `localBaseUrl` | `http://127.0.0.1:1234/v1` | OpenAI-compatible local endpoint |
| `localModel` | `jev-style-qwen3.5-2b-decision-mlx` | Current LM Studio-compatible local model |
| `localApiKey` | none | Optional bearer token for a proxied local endpoint |
| `localConcurrency` | `2` | Parallel local decisions |
| `localContextTokens` | `64000` | Local prompt safety ceiling; must not exceed the context loaded in the server |
| `keepThreshold` | `0.5` | Minimum probability to retain a call/result |
| `preserveRecentMessages` | `6` | Newest adapted messages that are always pinned |
| `maxStateTokens` | `25000` | JEV state ceiling |
| `maxRequestTokens` | `30000` | Remote request ceiling |
| `truncateHeadChars` | `300` | Characters retained when only a result is dropped |
| `minReductionRatio` | `0.25` | Fall back to native compaction below this reduction |
| `logFile` | OpenCode data log path | Override diagnostics file |

## Troubleshooting

<details>
<summary><strong>/compact does not contact the local model</strong></summary>

A request is only necessary when there is at least one **completed tool call outside the
pinned recent-message window**.

With the default `preserveRecentMessages: 6`, a short session can run `/compact`
without sending anything to LM Studio. This is expected.

For a deterministic smoke test:

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

Complete at least one tool call, then run `/compact`.

The log should show at least one candidate and classifier request.

</details>

<details>
<summary><strong>Local classifier falls back</strong></summary>

Each compaction ends with a `compaction outcome` line.

| Reason | Meaning |
| --- | --- |
| `no-eligible-completed-tool-calls` | Nothing outside the pinned window |
| `server-error-envelope` | Endpoint returned an error envelope, sometimes with HTTP 2xx |
| `http-request-failed` | Server rejected the request |
| `endpoint-unreachable` | Nothing is listening at the configured endpoint |
| `context-overflow` | Prompt exceeded the model's context |
| `model-has-no-logprobs` | Model returned no usable probability distribution |
| `invalid-classifier-response` | Missing `logprobs/top_logprobs` |
| `malformed-classifier-response` | Response was not a valid chat completion |
| `classifier-error` | Other classifier error; inspect the logged server diagnostic |

A proxy must preserve `logprobs` and `top_logprobs` and must not rewrite the request
into an incompatible tools/streaming form.

</details>

<details>
<summary><strong>Invalid V2 TUI plugin module</strong></summary>

This normally means OpenCode has cached an older V1 revision.

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/github:overbit/fast-jev-compaction-opencode"
opencode plugin add github:overbit/fast-jev-compaction-opencode
```

Restart OpenCode afterwards.

</details>

<details>
<summary><strong>NpmInstallFailedError</strong></summary>

Verify Git/GitHub access to the repository and clear stale package cache if needed.

The package intentionally avoids npm lifecycle fields that trigger OpenCode's git
dependency preparation path.

</details>

## Updating from the earlier V1 build

Earlier revisions used `@opencode-ai/plugin`. OpenCode 2 requires the V2
`@opencode/plugin` module shape.

If upgrading from an old cached revision:

```sh
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/github:overbit/fast-jev-compaction-opencode"
opencode plugin add github:overbit/fast-jev-compaction-opencode
```

Then restart OpenCode.

## Development

### GitHub Pages developer guide

The dependency-free site lives in [`site/`](site/). Preview it locally:

```sh
npm run site:check
npm run site:serve
```

Open `http://localhost:4173`. The illustrative retention review makes no model
requests; backend instructions and copy buttons run entirely in the browser.
Both backend instructions remain available when JavaScript is disabled.

To publish, set **Settings → Pages → Build and deployment → Source** to
**GitHub Actions**. The [`GitHub Pages` workflow](.github/workflows/pages.yml)
validates changes on pull requests and deploys only `site/` on matching pushes
to `main` or a manual run from `main`. No API key or custom deployment secret is
needed. After enabling Pages, run the workflow once or push a site change.

The default project URL is
`https://overbit.github.io/fast-jev-compaction-opencode/`.
All site assets use relative paths so the guide also works under a project URL
in a fork. The self-hosted Geist fonts include their SIL Open Font License in
`site/assets/OFL.txt`.

```sh
npm install
npm run typecheck
npm test
npm run compile
```

Tests do not contact TypeSafe or LM Studio.

## Credits

This project is an OpenCode V2 port of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).

Local OpenAI-compatible classifier behavior was also informed by
[lkntfnd/fast-jev-compaction-local](https://github.com/lkntfnd/fast-jev-compaction-local).

Jev-Style local decision models and runtimes are maintained in
[lawrence3699/jev-style](https://github.com/lawrence3699/jev-style).

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
