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
        "localBaseUrl": "http://127.0.0.1:20128/v1",
        "localModel": "lm-studio/jev-style-qwen3.5-2b-decision",
        "localApiKey": "{env:OMNIROUTE_API_KEY}"
      }
    }
  ]
}
```

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
| `localConcurrency` | `2` | Parallel local decisions |
| `localContextTokens` | `64000` | Local decision prompt ceiling |
| `keepThreshold` | `0.5` | Minimum probability to keep a call/result |
| `preserveRecentMessages` | `6` | Newest adapted messages never pruned |
| `maxStateTokens` | `25000` | JEV state ceiling |
| `maxRequestTokens` | `30000` | Remote request ceiling |
| `truncateHeadChars` | `300` | Head retained when only a result is dropped |
| `minReductionRatio` | `0.25` | Fall back to normal OpenCode compaction below this reduction |

## Troubleshooting

Successful server load prints an initialization line. For the local backend it includes the selected LM Studio endpoint and model, for example:

```text
[fast-jev-compaction-opencode] initialized backend=local endpoint=http://127.0.0.1:1234/v1 model=jev-style-qwen3.5-2b-decision-mlx preserveRecentMessages=6 minReductionRatio=25%
```

Every OpenCode V2 compaction now logs hook entry and the classifier outcome. A local request is only necessary when there is at least one **completed tool call outside the pinned recent-message window**. With the default `preserveRecentMessages: 6`, a short session can therefore run `/compact` without contacting LM Studio; this is expected upstream fast-JEV behavior, not a failed hook.

A no-request compaction is explicit in the server log:

```text
[fast-jev-compaction-opencode] classifier not called session=... reason=no-eligible-completed-tool-calls preserveRecentMessages=6
```

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

Run at least one tool call to completion and then run `/compact`. The log should show `backend=local`, `candidates=1` (or more), and `jevBatches=1` (or more), while LM Studio receives the decision requests. Restore the normal preservation/reduction settings after the smoke test.

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
