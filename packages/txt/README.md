# @dtst/txt

MCP server and CLI for writing text through any OpenAI-compatible API. It
reads files, globs, directories, URLs or earlier results as context, and can
look at one or many images.

```bash
npx -y @dtst/txt    # MCP stdio server
```

Tools: `write_text`, `chat`, `read_context`, `list_models`.

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible root
OPENAI_API_KEY=sk-...
OPENAI_MODEL=openai/gpt-6-luna                 # a TEXT model
```

Optional: `DEBUG=true` for verbose stderr logs, `DTST_WORKSPACE=/path` to
resolve relative paths, `DTST_OUTPUT_DIR=out` for a default destination. A
`.env` file next to your project is picked up automatically.

## Add to your client

This entry works as-is in Claude Desktop, Cursor, Windsurf, Cline and Roo
Code:

```json
{
  "mcpServers": {
    "txt": {
      "command": "npx",
      "args": ["-y", "@dtst/txt"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "openai/gpt-6-luna"
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

Use a text model: `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`,
`qwen/qwen3.8-max`. `txt models --vision` lists models that accept images.

### opencode

`opencode.json` — `command` is an array and env vars use `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "txt": {
      "type": "local",
      "command": ["npx", "-y", "@dtst/txt"],
      "environment": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "openai/gpt-6-luna"
      },
      "enabled": true
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.txt]
command = "npx"
args = ["-y", "@dtst/txt"]

[mcp_servers.txt.env]
OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_API_KEY = "sk-..."
OPENAI_MODEL = "openai/gpt-6-luna"
```

### Command-line clients

```bash
claude mcp add --transport stdio txt \
  --env OPENAI_API_KEY=sk-... --env OPENAI_MODEL=openai/gpt-6-luna \
  -- npx -y @dtst/txt

codex mcp add txt --env OPENAI_MODEL=openai/gpt-6-luna -- npx -y @dtst/txt

gemini mcp add -e OPENAI_MODEL=openai/gpt-6-luna txt npx -y @dtst/txt
```

## Tools

### `write_text`

One-shot writing: draft, summarise, rewrite, translate, extract.

| param | type | what it does |
| --- | --- | --- |
| `instructions` | required, string | The task, e.g. `Summarise these release notes as 5 bullets for a non-technical reader`. Placed **last** in the prompt, which models follow best. |
| `input` | string | Inline source material to transform (short texts). |
| `context` | object | Reference material: `{ files, dirs, urls, text, artifacts }`. |
| `context.files` | string[] | Paths, globs, `file://` URIs or `dtst://artifact/<id>`. |
| `context.dirs` | string[] | Directories (non-recursive, capped at 64 files). |
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
| `format` | `text` \| `markdown` \| `json` | `json` switches on JSON mode; the content is not validated for you. |
| `verbosity` | `concise` \| `balanced` \| `detailed` | How much detail to produce. |
| `stream` | boolean | Stream from the provider and report progress. Default `false` (most compatible). |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save` | | Saving controls (see below). Text is returned inline either way. |

### `chat`

Multi-turn conversation; stateless, so send the whole history.

| param | type | what it does |
| --- | --- | --- |
| `messages` | required, array | Oldest first: `[{ "role": "user" \| "assistant" \| "system", "content": "…" }]`. The last user turn is answered. |
| `images` | string[] ≤16 | Attached to the **last user turn**. |
| `model`, `system`, `max_tokens`, `temperature`, `top_p`, `stop`, `reasoning_effort`, `format`, `verbosity`, `stream` | | Same as `write_text`. |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save` | | Same saving controls. |

### `read_context`

Brings reference material into the conversation as text + image content.

| param | type | what it does |
| --- | --- | --- |
| `files` | string[] | Paths, globs, `file://` URIs, artifact URIs. |
| `dirs` | string[] | Directories (non-recursive, ≤64 files). |
| `urls` | string[] | http(s) URLs returning text, JSON or an image. |
| `text` | string[] | Inline snippets passed through. |
| `images` | string[] ≤16 | Image sources to load as image content. |
| `max_bytes_per_source` | int 1024–8388608 | Per-source budget (default 262144); longer files are truncated with a marker. |
| `include_content` | boolean | `false` returns only sizes and paths. Default `true`. |

### `list_models`

| param | type | what it does |
| --- | --- | --- |
| `query` | string | Substring filter over model id and name. |
| `limit` | int 1–1000 | Maximum results (default 100). |

## How an agent uses it

```text
read_context { "files": ["docs/*.md"], "max_bytes_per_source": 65536 }

write_text {
  "instructions": "Summarise what changed in 3.2 as 5 bullets, then list breaking changes",
  "context": { "files": ["docs/release-3.2.md"] },
  "verbosity": "concise", "format": "markdown",
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

Context reads are budgeted per source and in total, and every block is fenced
and labelled as untrusted data so file contents cannot smuggle in
instructions. Anything skipped is reported back instead of being dropped.

## Saving to a local file

Text is returned inline; it is also written when you give it a destination.
`output_path` wins over `output_dir`; `filename` sets the name and the
extension comes from `format` (`.md`, `.json`). Relative paths resolve against
`DTST_WORKSPACE` (default: the directory the server was started in), or
`DTST_OUTPUT_DIR` when set. `overwrite: false` (default) appends `-1`, `-2`, …
instead of clobbering; `save: true` forces a write even without a destination.

```text
write_text { "instructions": "…", "output_path": "reports/summary.md" }
write_text { "instructions": "…", "format": "json", "output_dir": "data", "filename": "extract" }
chat       { "messages": [ … ], "save": true, "filename": "reply.md" }
```

Writes are atomic, and each result carries the absolute path, a `file://`
resource link and a `dtst://artifact/<id>` URI that later calls in the same session can use
as `context.artifacts`.

## CLI

```bash
txt write "Summarise RELEASE.md in five bullets" --context RELEASE.md
txt write "Describe these screenshots" -i "shots/*.png" --format markdown
txt chat "Explain this stack trace" -i screenshot.png
txt read src/*.ts --json
txt models --vision
txt --help
```

MIT licensed.
