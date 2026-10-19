import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, isLocalHost, readConfig } from "../src/config";
import { DtstError } from "../src/errors";

describe("readConfig", () => {
  it("defaults to the OpenAI API", () => {
    const config = readConfig({ OPENAI_API_KEY: "sk-test-123456" });
    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      imageApi: "auto",
      speechApi: "auto",
      timeoutMs: 300_000,
      openRouter: false,
    });
    expect(config.headers).toEqual({});
  });

  it("keeps the base URL path as given (no /v1 appended)", () => {
    const config = readConfig({
      OPENAI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      OPENAI_API_KEY: "key-123456789",
    });
    expect(config.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });

  it("reads models, workspace and OpenRouter attribution", () => {
    const config = readConfig({
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_API_KEY: "sk-or-123456",
      OPENAI_MODEL: "openai/gpt-6-luna",
      OPENAI_IMAGE_MODEL: "meta/muse-image",
      OPENAI_SPEECH_MODEL: "google/gemini-3.8-flash-lite-tts",
      OPENAI_VOICE: "Laomedeia",
      DTST_SPEECH_API: "FISH",
      DTST_WORKSPACE: "~/work",
    });
    expect(config).toMatchObject({
      openRouter: true,
      textModel: "openai/gpt-6-luna",
      imageModel: "meta/muse-image",
      speechModel: "google/gemini-3.8-flash-lite-tts",
      voice: "Laomedeia",
      speechApi: "fish",
      workspace: "~/work",
    });
    expect(config.headers["X-Title"]).toBe("dtst");
  });

  it("requires an API key except for local endpoints", () => {
    expect(() => readConfig({})).toThrow(/OPENAI_API_KEY/);
    expect(readConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1" }).apiKey).toBe("");
  });

  it("rejects invalid values with a CONFIG error", () => {
    const attempt = (env: NodeJS.ProcessEnv): unknown => {
      try {
        readConfig({ OPENAI_API_KEY: "sk-123456789", ...env });
      } catch (error) {
        return error;
      }
    };
    for (const env of [
      { OPENAI_BASE_URL: "not a url" },
      { DTST_IMAGE_API: "magic" },
      { DTST_SPEECH_API: "magic" },
      { DTST_TIMEOUT_MS: "5" },
    ]) {
      const error = attempt(env);
      expect(error).toBeInstanceOf(DtstError);
      expect((error as DtstError).code).toBe("CONFIG");
    }
  });
});

describe("isLocalHost", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "box.local", "[::1]"])(
    "%s is local",
    (host) => {
      expect(isLocalHost(host)).toBe(true);
    },
  );
  it.each(["openrouter.ai", "172.32.0.1", "8.8.8.8"])("%s is remote", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});
