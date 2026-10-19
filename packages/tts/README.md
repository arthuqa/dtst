# @dtst/tts

MCP server that turns text into speech through any OpenAI-compatible API (`/audio/speech`). Every result is saved to the audio file or folder the agent chooses.

```json
{
  "mcpServers": {
    "tts": {
      "command": "npx",
      "args": ["-y", "@dtst/tts"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "google/gemini-3.8-flash-lite-tts",
        "OPENAI_VOICE": "Laomedeia"
      }
    }
  }
}
```

**Tools:** `generate_speech` (text or a text file, voice, delivery instructions, speed, mp3 · wav · opus · aac · flac · pcm) · `list_speech_models` (with each model's voices when the provider lists them)

For all options, client setup and saving rules, see the [project README](https://github.com/arthuqa/dtst#readme). `npx @dtst/tts --help` lists the environment variables. MIT licensed.
