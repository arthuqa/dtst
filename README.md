# dtst

Two MCP servers, on any OpenAI-compatible API:

| Package | Run it | What it gives the model |
| --- | --- | --- |
| **`@dtst/img`** | `npx -y @dtst/img` | Generate and edit images, saved to the file you ask for. |
| **`@dtst/txt`** | `npx -y @dtst/txt` | Write text, read files/URLs as context, look at images. |

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # or https://api.openai.com/v1, a gateway, ...
OPENAI_API_KEY=sk-...
OPENAI_MODEL=meta/muse-image                   # the model THIS server uses
```

Each server has its own `env` block, so `img` can use an image model while
`txt` uses a text model. Optional: `DEBUG=true` for verbose logs on stderr.

## Add to your client

This entry works as-is in Claude Desktop, Cursor, Windsurf, Cline and Roo
Code:

```json
{
  "mcpServers": {
    "img": {
      "command": "npx",
      "args": ["-y", "@dtst/img"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "meta/muse-image"
      }
    }
  }
}
```

| Client | Where it goes | Key |
| --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `mcpServers` (add `"type": "stdio"`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Cline | `~/.cline/mcp.json` | `mcpServers` |
| Roo Code | `.roo/mcp.json` | `mcpServers` |
| VS Code (Copilot) | `.vscode/mcp.json` | `servers` + `"type": "stdio"` |
| Zed | Zed `settings.json` | `context_servers` |
| JetBrains | Settings → Tools → AI Assistant → MCP → Add → STDIO | paste the JSON above |

### opencode

`opencode.json` — `command` is an array and env vars use `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "img": {
      "type": "local",
      "command": ["npx", "-y", "@dtst/img"],
      "environment": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "meta/muse-image"
      },
      "enabled": true
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.img]
command = "npx"
args = ["-y", "@dtst/img"]

[mcp_servers.img.env]
OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_API_KEY = "sk-..."
OPENAI_MODEL = "meta/muse-image"
```

### Command-line clients

```bash
claude mcp add --transport stdio img \
  --env OPENAI_API_KEY=sk-... --env OPENAI_MODEL=meta/muse-image \
  -- npx -y @dtst/img

codex mcp add img --env OPENAI_MODEL=meta/muse-image -- npx -y @dtst/img

gemini mcp add -e OPENAI_MODEL=meta/muse-image img npx -y @dtst/img
```

Any other MCP client works the same way: run `npx -y @dtst/img`, pass the three
variables through its env mechanism, and leave stdout alone (both servers log
to stderr only).

---

# Tools

Parameter tables below are the complete tool schemas. `required` marks fields
the model must send; everything else is optional.

## `@dtst/img`

### `generate_image`

Creates images from a prompt and writes them to disk.

| param | type | what it does |
| --- | --- | --- |
| `prompt` | required, string | What to draw — subject, composition, lighting, medium. Up to 30,000 chars. |
| `model` | string | One-off model override. Defaults to this server's `OPENAI_MODEL`. |
| `n` | int 1–10 | How many images. Default 1. Some backends loop sequentially. |
| `size` | string | Explicit pixels (`1024x1024`, `1536x1024`, any `WxH` the provider allows) or a tier (`1K`, `2K`, `4K`, `auto`). |
| `aspect_ratio` | string | For providers that take a ratio instead of pixels: `16:9`, `1:1`, `4:5`, `auto`, … |
| `quality` | string | `low`, `medium`, `high`, `xhigh`, `max`, `auto` (DALL·E also accepts `standard`, `hd`). |
| `output_format` | `png` \| `jpeg` \| `webp` | Encoding of the saved file. Default: whatever the provider returns. |
| `background` | `transparent` \| `opaque` \| `auto` | `transparent` requires png/webp. |
| `output_compression` | int 0–100 | Compression for jpeg/webp. |
| `seed` | int | Reproducible results, where the provider supports it. |
| `style` | string | Style guidance appended to the prompt, e.g. `watercolour, soft light, 35mm`. |
| `negative_prompt` | string | Things to avoid; appended as an exclusion list. |
| `output_path` | string | Exact file **or** directory to write to. Wins over `output_dir`. |
| `output_dir` | string | Directory to write into. |
| `filename` | string | Preferred name; the extension follows the returned image type. |
| `overwrite` | boolean | `false` (default) keeps existing files and appends `-1`, `-2`, … |
| `save` | boolean | `false` = generate without touching the disk. Default `true`. |
| `inline` | boolean | `false` = skip the base64 preview in the response. Default `true`. |

### `edit_image`

Applies an instruction to existing image(s).

| param | type | what it does |
| --- | --- | --- |
| `prompt` | required, string | The change, e.g. `replace the background with a sunset beach`. |
| `images` | required, string[] 1–16 | Inputs: file paths, globs (`assets/*.png`), http(s) URLs, `data:` URLs, raw base64, or `dtst://artifact/<id>` from an earlier call. |
| `mask` | string | Mask image; transparent pixels mark the region to regenerate. OpenAI images-API backends only. |
| `input_fidelity` | `high` \| `low` | How strongly to preserve input details (gpt-image models). |
| `model`, `n`, `size`, `aspect_ratio`, `quality`, `output_format`, `background`, `output_compression`, `seed`, `style`, `negative_prompt` | | Same meaning as in `generate_image`. |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save`, `inline` | | Same saving controls as in `generate_image`. |

### `list_image_models`

| param | type | what it does |
| --- | --- | --- |
| `query` | string | Substring filter over model id, name and description. |
| `limit` | int 1–500 | Maximum results (default 50). |
| `output_modalities` | `image` \| `any` | `image` (default) lists models that emit images; `any` also shows chat models. |

## `@dtst/txt`

### `write_text`

One-shot writing: draft, summarise, rewrite, translate, extract.

| param | type | what it does |
| --- | --- | --- |
| `instructions` | required, string | The task, e.g. `Summarise these release notes as 5 bullets for a non-technical reader`. Placed **last** in the prompt, which models follow best. |
| `input` | string | Inline source material to transform (short texts). |
| `context` | object | Reference material to read: `{ files, dirs, urls, text, artifacts }`. |
| `context.files` | string[] | Paths, globs, `file://` URIs or `dtst://artifact/<id>`. |
| `context.dirs` | string[] | Directories (non-recursive, capped). |
| `context.urls` | string[] | http(s) URLs returning text, JSON or an image. |
| `context.text` | string[] | Inline snippets treated as context. |
| `context.artifacts` | string[] | Artifacts from earlier calls. |
| `images` | string[] ≤16 | Images for vision models: paths, globs, URLs, data URLs, base64, artifact URIs. |
| `model` | string | One-off override of `OPENAI_MODEL`. |
| `system` | string | Extra system guidance (persona, audience, constraints). |
| `max_tokens` | int 1–200000 | Output budget. Raise it for reasoning models. |
| `temperature` | number 0–2 | Sampling temperature. |
| `top_p` | number 0–1 | Nucleus sampling. |
| `stop` | string[] ≤4 | Stop sequences. |
| `reasoning_effort` | string | `low`, `medium`, `high` for models that support it. |
| `format` | `text` \| `markdown` \| `json` | `json` switches on JSON mode and decodes nothing else — validate the result. |
| `verbosity` | `concise` \| `balanced` \| `detailed` | How much detail to produce. |
| `stream` | boolean | Stream from the provider and report progress. Default `false` (most compatible). |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save` | | Saving controls (see below). Text is returned inline either way. |

### `chat`

Multi-turn conversation; stateless, so send the whole history.

| param | type | what it does |
| --- | --- | --- |
| `messages` | required, array | Oldest first: `[{ "role": "user" \| "assistant" \| "system", "content": "…" }]`. The last user turn is what gets answered. |
| `images` | string[] ≤16 | Attached to the **last user turn**. |
| `model`, `system`, `max_tokens`, `temperature`, `top_p`, `stop`, `reasoning_effort`, `format`, `verbosity`, `stream` | | Same as `write_text`. |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save` | | Same saving controls. |

### `read_context`

Pulls reference material into the conversation and returns it as text + images.

| param | type | what it does |
| --- | --- | --- |
| `files` | string[] | Paths, globs, `file://` URIs, artifact URIs. |
| `dirs` | string[] | Directories to read (non-recursive, ≤64 files). |
| `urls` | string[] | http(s) URLs returning text, JSON or an image. |
| `text` | string[] | Inline snippets passed through. |
| `images` | string[] ≤16 | Image sources to load as image content. |
| `max_bytes_per_source` | int 1024–8388608 | Per-source budget (default 262144). Longer files are truncated with a marker. |
| `include_content` | boolean | `false` returns only sizes and paths. Default `true`. |

### `list_models`

| param | type | what it does |
| --- | --- | --- |
| `query` | string | Substring filter over model id and name. |
| `limit` | int 1–1000 | Maximum results (default 100). |

---

# How an agent uses these tools

Every tool returns text plus structured content, and failures come back as
`isError` with a stable code and a one-line fix, so the model can correct
itself without a human.

**Image request → file.** The agent chains three calls and never needs to know
the filesystem layout:

```text
// 1. what can this endpoint do?
list_image_models { "query": "muse", "limit": 5 }

// 2. make three variants straight into the folder the user named
generate_image {
  "prompt": "a red panda astronaut, studio lighting, 35mm photo",
  "n": 3, "output_dir": "assets/hero", "filename": "hero", "output_format": "webp"
}
// → /abs/assets/hero.webp, /abs/assets/hero-1.webp, /abs/assets/hero-2.webp
//   plus dtst://artifact/a1b2c3 for each file

// 3. iterate on one of them by artifact URI (no path bookkeeping)
edit_image {
  "prompt": "add a warm sunset behind the panda",
  "images": ["dtst://artifact/a1b2c3"],
  "output_path": "assets/hero/hero-sunset.webp"
}
```

**Writing request → grounded text.** The agent reads first, then writes with
that context, then saves:

```text
read_context { "files": ["docs/*.md"], "max_bytes_per_source": 65536 }

write_text {
  "instructions": "Summarise what changed in 3.2 as 5 bullets, then list breaking changes",
  "context": { "files": ["docs/release-3.2.md"] },
  "verbosity": "concise",
  "format": "markdown",
  "output_path": "reports/release-summary.md"
}

chat {
  "messages": [
    { "role": "user", "content": "What does this screenshot show?" },
    { "role": "assistant", "content": "A stack trace from the worker pool." },
    { "role": "user", "content": "Which line is the root cause?" }
  ],
  "images": ["shots/error.png"]
}
```

Rules the models are instructed to follow, and that you can rely on:

- Pass `output_path` / `output_dir` / `filename` whenever the user named a
  destination; otherwise files land in the workspace root (or `DTST_OUTPUT_DIR`).
- Use `dtst://artifact/<id>` to feed one call's output into the next call in the same session.
- Ask for several options with `n` instead of generating one image at a time.
- Read before writing: `read_context` / `context.files` keeps answers grounded
  in the workspace instead of invented.

# Saving to a local file

Images are written to disk by default; text is returned inline unless you give
it a destination. The same four fields control both servers:

| field | meaning |
| --- | --- |
| `output_path` | Exact file (or directory) to write to. **Wins over `output_dir`.** |
| `output_dir` | Directory to write into; the file name is derived from the prompt/instructions. |
| `filename` | Preferred name. The extension is added from the returned type (`.webp`, `.png`, `.md`, `.json`). |
| `overwrite` | `false` (default) never clobbers: `hero.png`, `hero-1.png`, `hero-2.png`. `true` replaces. |
| `save` | `@dtst/img`: `false` previews without writing (default `true`). `@dtst/txt`: `true` forces a write (default: write only when a destination is given). |

Examples:

```text
// exactly this file
generate_image { "prompt": "…", "output_path": "~/Desktop/panda.png" }

// three files in a folder, named by me
generate_image { "prompt": "…", "n": 3, "output_dir": "out", "filename": "icon" }
// → out/icon.webp, out/icon-1.webp, out/icon-2.webp

// show me first, save nothing (and skip the inline bytes)
generate_image { "prompt": "…", "save": false, "inline": false }

// write the report where the project keeps reports
write_text { "instructions": "…", "output_path": "reports/summary.md" }
```

Where relative paths land:

- `DTST_WORKSPACE` (default: the directory the server was started in) is the
  root for relative paths.
- `DTST_OUTPUT_DIR` makes a directory the default destination, so
  `generate_image { "prompt": "…" }` writes there instead of the root.
- `DTST_ALLOWED_WRITE_ROOTS=/a:/b` (optional) refuses any write outside those
  directories.

Every write is atomic (temp file + fsync + rename) and reported back as an
absolute path, a `file://` resource link the client can read, and a
`dtst://artifact/<id>` URI for chaining into a later call in the same session. `save: false` and
`inline: false` in `@dtst/img` and the absence of a destination in `@dtst/txt`
mean nothing is written at all.

## Development

```bash
npm install
npm run check            # typecheck + unit tests + build + package verification
npm run build            # dist/index.js + dist/cli.js

# live checks against a real provider (spends a few cents)
npm run test:integration                        # both servers
node scripts/integration-test.mjs img           # one server
node scripts/integration-test.mjs txt
```

Releasing: own the `@dtst` scope on npm, then either configure a trusted
publisher (npmjs.com → package → Settings → Trusted Publisher → GitHub Actions,
`arthuqa` / `dtst` / `publish.yml`) or add an `NPM_TOKEN` repository secret.
Then `npm run release -- both patch --push` tags and publishes; the workflow
also supports a manual dry run.

MIT licensed.
