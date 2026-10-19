# @dtst/img

MCP server for generating and editing images through any OpenAI-compatible API. Every result is saved to the file or folder the agent chooses.

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
    }
  }
}
```

**Tools:** `generate_image` · `edit_image` · `list_image_models`

**Protocols:** OpenAI `/images/*`, OpenRouter `/images`, and image output over `/chat/completions`. The right one is chosen automatically.

For all options, client setup and saving rules, see the [project README](https://github.com/arthuqa/dtst#readme). `npx @dtst/img --help` lists the environment variables. MIT licensed.
