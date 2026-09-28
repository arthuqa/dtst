# @dtst/img

MCP server **and** CLI for generating and editing images through any
OpenAI-compatible API — OpenAI, OpenRouter, LiteLLM, vLLM, or a local gateway.
It writes files exactly where the agent asks, reports what it produced, and
keeps credentials out of logs.

```bash
npx @dtst/img --help          # CLI
npx @dtst/img                 # MCP stdio server (what MCP clients run)
```

## Quick start

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible root
export OPENAI_API_KEY=sk-...
export OPENAI_IMAGE_MODEL=google/gemini-3.1-flash-image

npx @dtst/img generate "a red panda astronaut, studio lighting" --out-dir ./out
npx @dtst/img models --query image --limit 20
```

`.env` files are discovered from the working directory upwards, so a project
`.env` is enough when an MCP client (Claude Desktop, opencode, Cursor, …)
launches the server without inheriting your shell environment.

## MCP client configuration

```json
{
  "mcpServers": {
    "img": {
      "command": "npx",
      "args": ["-y", "@dtst/img"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_IMAGE_MODEL": "google/gemini-3.1-flash-image",
        "DTST_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

`DTST_WORKSPACE` is optional but recommended: relative `output_path` /
`output_dir` values resolve against it instead of the client's working
directory, which is not always the project root.

## Tools

| Tool | Purpose |
| --- | --- |
| `generate_image` | Text → image, `n` images per call, saved to a caller-chosen path. |
| `edit_image` | Image(s) + instruction → edited image. Accepts 1–16 inputs as paths, globs, URLs, data URLs, base64 or `dtst://artifact/<id>` URIs. |
| `list_image_models` | Which image models the endpoint offers and which protocol they use. |

Every generation returns, in one response:

- an inline `image` content block when the file is small enough (so vision-capable
  clients can see the result without a second read),
- a `resource_link` plus an embedded resource for each saved file,
- absolute paths, byte sizes, dimensions, mime types and a `dtst://artifact/<id>`
  URI in `structuredContent`,
- token/cost usage when the provider reports it.

Artifacts written by the server can be read back over MCP resources at
`dtst://artifact/<id>`.

## Saving to a location the agent chooses

```
output_path   exact file or directory (wins over output_dir)
output_dir    directory, file name derived from the prompt
filename      preferred name; the extension follows the returned image type
overwrite     false (default) appends -1, -2, … instead of clobbering
save          false for a preview that never touches the disk
inline        false to skip the inline base64 payload
```

Relative paths resolve against `DTST_WORKSPACE` (default: the process working
directory). Writes are atomic (temp file + `fsync` + rename). Set
`DTST_ALLOWED_WRITE_ROOTS=/path/a:/path/b` to confine the server to a set of
directories.

## Wire protocols (why this works with more than OpenAI)

| Backend | Endpoint | Used for |
| --- | --- | --- |
| `images` | `POST /images/generations`, `POST /images/edits` (multipart, supports masks) | OpenAI, Azure-style gateways, LiteLLM |
| `openrouter` | `POST /images` (JSON, `input_references`, no mask) | OpenRouter's dedicated image API |
| `chat` | `POST /chat/completions` with `modalities: ["image","text"]` | Image models that only expose the chat route |

`DTST_IMG_BACKEND=auto` (default) starts with the right protocol for the host
and transparently retries the other one when a provider answers
"this model cannot be used with … endpoint" (which is exactly what OpenRouter
returns for models that belong to the other route). Force a protocol with
`DTST_IMG_BACKEND=images|openrouter|chat`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_BASE_URL` | – (required) | API root. `/v1` is added when missing; endpoint suffixes are stripped. |
| `OPENAI_API_KEY` | – (required) | Bearer token. Optional for localhost endpoints unless `DTST_ALLOW_NO_API_KEY=0`. |
| `OPENAI_IMAGE_MODEL` | – | Default model for every call. |
| `DTST_IMG_BACKEND` | `auto` | `auto`, `images`, `openrouter` or `chat`. |
| `DTST_WORKSPACE` | cwd | Root for relative output paths. |
| `DTST_OUTPUT_DIR` | workspace | Default output directory. |
| `DTST_ALLOWED_WRITE_ROOTS` | – | Colon-separated allow-list for writes. |
| `DTST_MAX_IMAGE_BYTES` | 26214400 | Per-image input/output limit. |
| `DTST_MAX_IMAGES` | 16 | Maximum input images per edit call. |
| `DTST_TIMEOUT_MS` | 600000 | Per-request timeout. |
| `DTST_MAX_RETRIES` | 2 | Retries for 408/409/429/5xx, honouring `Retry-After`. |
| `DTST_EXTRA_HEADERS` / `DTST_EXTRA_BODY` | – | JSON objects merged into every request (provider knobs). |
| `DTST_HTTP_REFERER`, `DTST_APP_TITLE` | – | Attribution headers for OpenRouter. |
| `DTST_LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info`, `debug`. stderr only — stdout is the MCP channel. |
| `DTST_ENV_FILE` | – | Explicit `.env` path. |

## CLI

```bash
img generate "a paper boat on a puddle" -n 2 --size 1024x1024 --out-dir out
img edit "make it snow" -i out/boat.webp --out out/boat-snow.webp
img models --query gemini --json
img config                     # effective configuration, secrets redacted
img serve                      # run the MCP server explicitly
```

Results go to stdout (paths by default, `--json` for structured output);
diagnostics go to stderr. Exit codes: `0` success, `1` runtime/provider error,
`2` usage error.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `CONFIG_MISSING: OPENAI_BASE_URL is not set` | Export it, or put it in a `.env` next to the project. MCP clients do not inherit your shell. |
| `PROVIDER_UNSUPPORTED … cannot be used with the chat/completions endpoint` | The model belongs to another route. `auto` already retries; if you forced a backend, unset `DTST_IMG_BACKEND`. |
| `400 unknown parameter` | The provider rejects an optional parameter; the server retries once with a minimal body, then reports the provider's message. |
| Images look cropped or oddly sized | Providers clamp sizes. Prefer `size` for OpenAI-style models, `aspect_ratio`/`resolution` for OpenRouter models. |
| Output landed in the wrong directory | Set `DTST_WORKSPACE`, or pass an absolute `output_path`. |

## Development

This package is part of the [`arthuqa/dtst`](https://github.com/arthuqa/dtst)
monorepo. From the repository root:

```bash
npm install
npm run typecheck && npm test && npm run build
node scripts/integration-test.mjs img   # real provider calls, spends credit
```

MIT licensed.
