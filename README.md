# dtst

Two small MCP servers that work with any OpenAI-compatible API (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama and others).

| Server          | Tools                                                 | Purpose                                                    |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| **`@dtst/img`** | `generate_image` · `edit_image` · `list_image_models` | Create and edit images, saved to the path the agent picks. |
| **`@dtst/txt`** | `generate_text` · `read_files` · `list_text_models`   | Hand writing tasks to a second model, grounded in files.   |

## Quick start

Add both servers to your MCP client:

```json
{
  "mcpServers": {
    "img": {
      "command": "npx",
      "args": ["-y", "@dtst/img"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_IMAGE_MODEL": "meta/muse-image"
      }
    },
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

| Client         | Config file                                                       | Notes                           |
| -------------- | ----------------------------------------------------------------- | ------------------------------- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | Windows: `%APPDATA%\Claude\…`   |
| Cursor         | `~/.cursor/mcp.json` or `.cursor/mcp.json`                        |                                 |
| Windsurf       | `~/.codeium/windsurf/mcp_config.json`                             |                                 |
| VS Code        | `.vscode/mcp.json`                                                | top-level key `servers`         |
| Zed            | `settings.json`                                                   | top-level key `context_servers` |

<details>
<summary><b>Claude Code · Codex · opencode</b></summary>

```bash
claude mcp add img -e OPENAI_API_KEY=sk-... -e OPENAI_IMAGE_MODEL=openai/gpt-image-1 -- npx -y @dtst/img
```

```toml
# ~/.codex/config.toml
[mcp_servers.img]
command = "npx"
args = ["-y", "@dtst/img"]
env = { OPENAI_API_KEY = "sk-...", OPENAI_IMAGE_MODEL = "openai/gpt-image-1" }
```

```json
// opencode.json
{
  "mcp": {
    "img": { "type": "local", "command": ["npx", "-y", "@dtst/img"], "environment": { "OPENAI_API_KEY": "sk-..." } }
  }
}
```

</details>

## Configuration

| Variable             | Default                     | Purpose                                              |
| -------------------- | --------------------------- | ---------------------------------------------------- |
| `OPENAI_BASE_URL`    | `https://api.openai.com/v1` | API root, used exactly as given                      |
| `OPENAI_API_KEY`     | —                           | Required unless the endpoint is local or on your LAN |
| `OPENAI_MODEL`       | —                           | Text model for `txt`; fallback image model for `img` |
| `OPENAI_IMAGE_MODEL` | `OPENAI_MODEL`              | Image model for `img`                                |
| `DTST_WORKSPACE`     | client root, else cwd       | Base folder for relative paths                       |
| `DTST_IMAGE_API`     | `auto`                      | Force a protocol: `images`, `openrouter` or `chat`   |
| `DTST_TIMEOUT_MS`    | `300000`                    | Timeout for each request                             |
| `DEBUG`              | off                         | `1` turns on verbose logs (stderr)                   |

Both servers also read a `.env` file in their working directory. Since `img` and `txt` read separate model variables, one `.env` can configure both.

## Tools

### `@dtst/img`

| `generate_image` · `edit_image`   | Description                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `prompt` **required**             | What to draw, or what to change                                              |
| `images` **required for edit**    | Input images: paths, globs, URLs, data URLs or base64 (up to 16)             |
| `mask` (edit only)                | PNG; its transparent pixels mark the area to change (OpenAI images API only) |
| `model`                           | Override the default model for one call                                      |
| `n`                               | Number of images, 1–10                                                       |
| `size`                            | `1024x1536`, or a tier: `1K`, `2K`, `4K`, `auto`                             |
| `aspect_ratio`                    | `1:1`, `16:9`, `9:16`, …                                                     |
| `quality` · `background` · `seed` | Passed to the provider when it supports them                                 |
| `format`                          | `png`, `jpeg` or `webp`; if omitted, taken from the `output` extension       |
| `output`                          | File (`art/hero.png`) or folder (`art/`) to save to                          |
| `overwrite`                       | Replace existing files (default `false`)                                     |
| `inline`                          | Include a preview of each image in the reply (default `true`)                |

`list_image_models { query?, limit? }` shows each model's id, which protocol it uses, and the sizes, ratios and limits it accepts (when the provider publishes them).

### `@dtst/txt`

| `generate_text`                                             | Description                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `prompt` and/or `messages`                                  | One-shot task, or an earlier conversation `[{ role, content }]`             |
| `files`                                                     | Context: files, folders, globs, URLs. Images are attached for vision models |
| `system`                                                    | Persona, audience, tone or length                                           |
| `model` · `max_tokens` · `temperature` · `reasoning_effort` | Sampling controls                                                           |
| `json`                                                      | Return a single JSON value (JSON mode)                                      |
| `output` · `overwrite`                                      | Save the reply to a file (`.md` by default)                                 |

`read_files { sources, max_bytes? }` returns text and images directly to the calling agent. `list_text_models { query?, limit? }` shows context size, vision support and price.

## How files are saved

- Relative paths are resolved against the workspace: `DTST_WORKSPACE`, otherwise the client's first [root](https://modelcontextprotocol.io/specification/2025-06-18/client/roots), otherwise the working directory.
- Existing files are never replaced unless `overwrite: true`. A free name is chosen instead: `hero.png` → `hero-1.png`.
- When `n > 1`, files are numbered `hero-1.png`, `hero-2.png`, …
- If the provider returns a different format than the extension you asked for, the extension is corrected (bytes are never mislabelled).
- Every saved file is returned as an absolute path, a `resource_link`, and `structuredContent`. To iterate on an image, pass that path to `edit_image`.

Example agent flow:

```text
generate_image { "prompt": "red panda astronaut", "n": 2, "output": "art/" }
  → art/red-panda-astronaut-1.png, art/red-panda-astronaut-2.png
edit_image     { "prompt": "add a sunset", "images": ["art/red-panda-astronaut-1.png"], "output": "art/final.webp" }
generate_text  { "prompt": "Write alt text for this image", "files": ["art/final.webp"] }
```

## Development

```bash
npm install
npm run check              # lint · format · typecheck · unit tests · build · package verification
npm run test:integration   # live calls via .env (costs a few cents); add `img` or `txt` to run one server
```

Releases: `npm run release -- <img|txt|both> <patch|minor|major> --push` tags the release, and `.github/workflows/publish.yml` publishes it, via npm trusted publishing or an `NPM_TOKEN` secret.

MIT licensed.
