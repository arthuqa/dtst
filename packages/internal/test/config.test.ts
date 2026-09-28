import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IMAGES,
  DtstError,
  configSummary,
  normalizeBaseUrl,
  redact,
  resolveConfig,
} from "@dtst/internal";
import { catchDtstError } from "./helpers";

const base = {
  OPENAI_BASE_URL: "https://api.example.com/v1",
  OPENAI_API_KEY: "sk-test-0123456789abcdef",
};

describe("resolveConfig: base URL + API key", () => {
  it("requires OPENAI_BASE_URL with an actionable hint", () => {
    const error = catchDtstError(() => resolveConfig({ env: {} }));
    expect(error).toBeInstanceOf(DtstError);
    expect(error.code).toBe("CONFIG_MISSING");
    expect(error.hint).toBeTruthy();
    expect(error.hint).toContain("OPENAI_BASE_URL");
  });

  it("requires an API key for a remote host", () => {
    const error = catchDtstError(() => resolveConfig({ env: { OPENAI_BASE_URL: "https://api.openai.com/v1" } }));
    expect(error.code).toBe("CONFIG_MISSING");
    expect(error.message).toContain("OPENAI_API_KEY");
    expect(error.hint).toBeTruthy();
  });

  it("accepts a key for a remote host", () => {
    const config = resolveConfig({ env: base });
    expect(config.baseUrl).toBe("https://api.example.com/v1");
    expect(config.apiKey).toBe(base.OPENAI_API_KEY);
    expect(config.allowNoApiKey).toBe(false);
  });

  it.each(["http://localhost:11434/v1", "http://127.0.0.1:8080/v1"])(
    "does not require a key for the local endpoint %s",
    (url) => {
      const config = resolveConfig({ env: { OPENAI_BASE_URL: url } });
      expect(config.apiKey).toBe("");
      expect(config.allowNoApiKey).toBe(true);
    },
  );

  it("allows a missing key anywhere when DTST_ALLOW_NO_API_KEY=1", () => {
    const config = resolveConfig({
      env: { OPENAI_BASE_URL: "https://api.openai.com/v1", DTST_ALLOW_NO_API_KEY: "1" },
    });
    expect(config.apiKey).toBe("");
    expect(config.allowNoApiKey).toBe(true);
  });
});

describe("normalizeBaseUrl", () => {
  it("appends /v1 to a bare host", () => {
    expect(normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
  });

  it("preserves an explicit /api/v1", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
  });

  it("removes trailing slashes", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1//")).toBe("https://api.example.com/v1");
  });

  it("strips known endpoint suffixes", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/images/generations")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/responses")).toBe("https://api.example.com/v1");
  });

  it("rejects non-http protocols and unparseable input", () => {
    const protocol = catchDtstError(() => normalizeBaseUrl("ftp://x"));
    expect(protocol.code).toBe("CONFIG_INVALID");
    const garbage = catchDtstError(() => normalizeBaseUrl("not a url"));
    expect(garbage.code).toBe("CONFIG_INVALID");
  });
});

describe("resolveConfig: numeric and enum validation", () => {
  it.each([
    ["DTST_TIMEOUT_MS", "abc"],
    ["DTST_MAX_RETRIES", "99"],
    ["DTST_MAX_IMAGES", "0"],
  ])("rejects invalid %s", (key, value) => {
    const error = catchDtstError(() => resolveConfig({ env: { ...base, [key]: value } }));
    expect(error.code).toBe("CONFIG_INVALID");
  });

  it("rejects an unknown image backend", () => {
    const error = catchDtstError(() => resolveConfig({ env: { ...base, DTST_IMG_BACKEND: "bogus" } }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("DTST_IMG_BACKEND");
  });

  it("rejects an unknown text API surface", () => {
    const error = catchDtstError(() => resolveConfig({ env: { ...base, DTST_TXT_API: "bogus" } }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("DTST_TXT_API");
  });

  it("applies defaults", () => {
    const config = resolveConfig({ env: base });
    expect(config.imageBackend).toBe("auto");
    expect(config.textApi).toBe("chat");
    expect(config.maxImages).toBe(DEFAULT_MAX_IMAGES);
    expect(config.extraBody).toEqual({});
  });
});

describe("resolveConfig: mapping of optional variables", () => {
  it("splits DTST_ALLOWED_WRITE_ROOTS into absolute paths", () => {
    const config = resolveConfig({ env: { ...base, DTST_ALLOWED_WRITE_ROOTS: "/a:/b" } });
    expect(config.allowedWriteRoots).toHaveLength(2);
    expect(config.allowedWriteRoots[0]).toBe(path.resolve("/a"));
    expect(config.allowedWriteRoots[1]).toBe(path.resolve("/b"));
    expect(config.allowedWriteRoots.every((entry) => path.isAbsolute(entry))).toBe(true);
  });

  it("maps model and output directory variables", () => {
    const config = resolveConfig({
      env: {
        ...base,
        OPENAI_MODEL: "text-model",
        OPENAI_IMAGE_MODEL: "image-model",
        DTST_OUTPUT_DIR: "out",
      },
    });
    expect(config.textModel).toBe("text-model");
    expect(config.imageModel).toBe("image-model");
    expect(config.outputDir).toBe("out");
  });

  it("parses DTST_EXTRA_BODY and DTST_EXTRA_HEADERS as JSON objects", () => {
    const config = resolveConfig({
      env: { ...base, DTST_EXTRA_BODY: '{"seed":7}', DTST_EXTRA_HEADERS: '{"x-test":"1"}' },
    });
    expect(config.extraBody).toEqual({ seed: 7 });
    expect(config.headers["x-test"]).toBe("1");
  });

  it("rejects malformed DTST_EXTRA_BODY and DTST_EXTRA_HEADERS", () => {
    expect(catchDtstError(() => resolveConfig({ env: { ...base, DTST_EXTRA_BODY: "{" } })).code).toBe("CONFIG_INVALID");
    expect(catchDtstError(() => resolveConfig({ env: { ...base, DTST_EXTRA_BODY: "[1]" } })).code).toBe("CONFIG_INVALID");
    expect(catchDtstError(() => resolveConfig({ env: { ...base, DTST_EXTRA_HEADERS: "nope" } })).code).toBe("CONFIG_INVALID");
  });
});

describe("configSummary and secret redaction", () => {
  it("never exposes the API key", () => {
    const key = "sk-live-abcdefghijklmnop";
    const config = resolveConfig({ env: { OPENAI_BASE_URL: "https://api.example.com/v1", OPENAI_API_KEY: key } });
    const summary = configSummary(config);
    expect(summary["apiKey"]).toBe("set");
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it("masks the key that resolveConfig registered", () => {
    const key = "sk-live-abcdefghijklmnop";
    resolveConfig({ env: { OPENAI_BASE_URL: "https://api.example.com/v1", OPENAI_API_KEY: key } });
    const redacted = redact(`the key is ${key}, keep it safe`);
    expect(redacted).not.toContain(key);
    expect(redacted).toContain("«redacted»");
  });

  it("reports a missing key for a local endpoint that allows it", () => {
    const config = resolveConfig({ env: { OPENAI_BASE_URL: "http://localhost:11434/v1" } });
    expect(configSummary(config)["apiKey"]).toBe("not required for this endpoint");
  });
});

describe("attribution headers", () => {
  it("adds X-Title for OpenRouter hosts only", () => {
    const openrouter = resolveConfig({ env: base, cwd: process.cwd() });
    // Re-resolve against the OpenRouter host to check the header logic.
    const orConfig = resolveConfig({
      env: { ...base, OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
    });
    expect(orConfig.headers["X-Title"]).toBe("dtst");
    expect(openrouter.headers["X-Title"]).toBeUndefined();
  });

  it("honours DTST_APP_TITLE on OpenRouter hosts", () => {
    const config = resolveConfig({
      env: { ...base, OPENAI_BASE_URL: "https://openrouter.ai/api/v1", DTST_APP_TITLE: "my-app" },
    });
    expect(config.headers["X-Title"]).toBe("my-app");
    expect(config.attribution.title).toBe("my-app");
  });
});
