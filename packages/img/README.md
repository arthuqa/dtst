# @dtst/img

MCP server and CLI for generating and editing images through any
OpenAI-compatible API (OpenAI, OpenRouter, LiteLLM, vLLM, …). Images are
written to the file you ask for and returned inline for vision-capable clients.

```bash
npx -y @dtst/img    # MCP stdio server
```

Tools: `generate_image`, `edit_image`, `list_image_models`.

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible root
OPENAI_API_KEY=sk-...
OPENAI_MODEL=meta/muse-image                   # an IMAGE model
```

Optional: `DEBUG=true` for verbose stderr logs, `DTST_WORKSPACE=/path` to
resolve relative output paths, `DTST_OUTPUT_DIR=out` for a default
destination. A `.env` file next to your project is picked up automatically.

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

| Client            | Where it goes                                                                                                                      | Key                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Claude Desktop    | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers`                         |
| Cursor            | `~/.cursor/mcp.json` or `.cursor/mcp.json`                                                                                         | `mcpServers` (add `"type": "stdio"`) |
| Windsurf          | `~/.codeium/windsurf/mcp_config.json`                                                                                              | `mcpServers`                         |
| Cline             | `~/.cline/mcp.json`                                                                                                                | `mcpServers`                         |
| Roo Code          | `.roo/mcp.json`                                                                                                                    | `mcpServers`                         |
| VS Code (Copilot) | `.vscode/mcp.json`                                                                                                                 | `servers` + `"type": "stdio"`        |
| Zed               | Zed `settings.json`                                                                                                                | `context_servers`                    |
| JetBrains         | Settings → Tools → AI Assistant → MCP → Add → STDIO                                                                                | paste the JSON above                 |

Use an image model: `meta/muse-image`, `google/gemini-3.1-flash-image`,
`openai/gpt-image-1`, `dall-e-3`. `img models` lists what your endpoint offers.

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

## Tools

### `generate_image`

| param                | type                                | what it does                                                                                                    |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `prompt`             | required, string                    | What to draw — subject, composition, lighting, medium. Up to 30,000 chars.                                      |
| `model`              | string                              | One-off override of `OPENAI_MODEL`.                                                                             |
| `n`                  | int 1–10                            | How many images. Default 1.                                                                                     |
| `size`               | string                              | Explicit pixels (`1024x1024`, `1536x1024`, any `WxH` the provider allows) or a tier (`1K`, `2K`, `4K`, `auto`). |
| `aspect_ratio`       | string                              | For providers taking a ratio instead of pixels: `16:9`, `1:1`, `4:5`, `auto`, …                                 |
| `quality`            | string                              | `low`, `medium`, `high`, `xhigh`, `max`, `auto` (DALL·E also `standard`, `hd`).                                 |
| `output_format`      | `png` \| `jpeg` \| `webp`           | Encoding of the saved file.                                                                                     |
| `background`         | `transparent` \| `opaque` \| `auto` | `transparent` needs png/webp.                                                                                   |
| `output_compression` | int 0–100                           | Compression for jpeg/webp.                                                                                      |
| `seed`               | int                                 | Reproducible results where the provider supports it.                                                            |
| `style`              | string                              | Style guidance appended to the prompt, e.g. `watercolour, 35mm`.                                                |
| `negative_prompt`    | string                              | Things to avoid.                                                                                                |
| `output_path`        | string                              | Exact file **or** directory to write to. Wins over `output_dir`.                                                |
| `output_dir`         | string                              | Directory to write into.                                                                                        |
| `filename`           | string                              | Preferred name; the extension follows the returned image type.                                                  |
| `overwrite`          | boolean                             | `false` (default) appends `-1`, `-2`, … instead of clobbering.                                                  |
| `save`               | boolean                             | `false` = generate without touching the disk. Default `true`.                                                   |
| `inline`             | boolean                             | `false` = skip the base64 preview in the response. Default `true`.                                              |

### `edit_image`

| param                                                                                                                                    | type                    | what it does                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                                                                                                                 | required, string        | The change to apply.                                                                                                                |
| `images`                                                                                                                                 | required, string[] 1–16 | Inputs: file paths, globs (`assets/*.png`), http(s) URLs, `data:` URLs, raw base64, or `dtst://artifact/<id>` from an earlier call. |
| `mask`                                                                                                                                   | string                  | Mask image; transparent pixels mark the region to regenerate. OpenAI images-API backends only.                                      |
| `input_fidelity`                                                                                                                         | `high` \| `low`         | How strongly to preserve input details (gpt-image models).                                                                          |
| `model`, `n`, `size`, `aspect_ratio`, `quality`, `output_format`, `background`, `output_compression`, `seed`, `style`, `negative_prompt` |                         | Same as `generate_image`.                                                                                                           |
| `output_path`, `output_dir`, `filename`, `overwrite`, `save`, `inline`                                                                   |                         | Same saving controls.                                                                                                               |

### `list_image_models`

| param               | type             | what it does                                          |
| ------------------- | ---------------- | ----------------------------------------------------- |
| `query`             | string           | Substring filter over model id, name and description. |
| `limit`             | int 1–500        | Maximum results (default 50).                         |
| `output_modalities` | `image` \| `any` | `image` (default) lists models that emit images.      |

## How an agent uses it

```text
list_image_models { "query": "muse", "limit": 5 }

generate_image {
  "prompt": "a red panda astronaut, studio lighting, 35mm photo",
  "n": 3, "output_dir": "assets/hero", "filename": "hero", "output_format": "webp"
}
// → /abs/assets/hero.webp, hero-1.webp, hero-2.webp + dtst://artifact/<id> for each

edit_image {
  "prompt": "add a warm sunset behind the panda",
  "images": ["dtst://artifact/<id>"],
  "output_path": "assets/hero/hero-sunset.webp"
}
```

## Saving to a local file

Images are written to disk by default. `output_path` wins over `output_dir`;
`filename` sets the name and the extension is added from the returned type.
Relative paths resolve against `DTST_WORKSPACE` (default: the directory the
server was started in), or `DTST_OUTPUT_DIR` when set. `overwrite: false`
(default) never clobbers — it appends `-1`, `-2`, … `save: false` skips the
disk entirely, `inline: false` skips the base64 preview.

```text
generate_image { "prompt": "…", "output_path": "~/Desktop/panda.png" }
generate_image { "prompt": "…", "n": 3, "output_dir": "out", "filename": "icon" }
generate_image { "prompt": "…", "save": false, "inline": false }   // preview only
```

Writes are atomic, and each result carries the absolute path, a `file://`
resource link and a `dtst://artifact/<id>` URI for later calls in the same session.
`DTST_ALLOWED_WRITE_ROOTS=/a:/b` confines writes to those directories.

## CLI

The same operations without an MCP client:

```bash
img generate "a red panda astronaut, studio lighting" --out-dir out
img edit "make it a watercolour" -i out/panda.png --out out/panda-water.png
img models
img --help
```

MIT licensed.
