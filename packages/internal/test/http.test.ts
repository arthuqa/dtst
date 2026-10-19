import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { DtstError, httpError, toDtstError } from "../src/errors";
import { api, download } from "../src/http";
import { type FakeProvider, fakeProvider } from "./helpers";

let provider: FakeProvider;
const config = () => readConfig({ OPENAI_BASE_URL: provider.url, OPENAI_API_KEY: "sk-test-123456" });

beforeEach(async () => {
  provider = await fakeProvider();
});
afterEach(() => provider.close());

describe("api", () => {
  it("sends auth and JSON, returns parsed data", async () => {
    provider.on("POST /chat/completions", ({ json }) => ({ json: { echo: json } }));
    const result = await api<{ echo: unknown }>(config(), "/chat/completions", { json: { a: 1 } });
    expect(result.echo).toEqual({ a: 1 });
    expect(provider.requests[0]?.headers["authorization"]).toBe("Bearer sk-test-123456");
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    provider.on("GET /models", () =>
      ++calls < 3 ? { status: 429, headers: { "retry-after": "0" }, json: {} } : { json: { ok: true } },
    );
    await expect(api(config(), "/models")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("does not retry client errors and maps them to codes", async () => {
    provider.on("GET /models", { status: 401, json: { error: { message: "bad key" } } });
    const error = await api(config(), "/models").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "AUTH", message: "bad key", status: 401 });
    expect(provider.requests).toHaveLength(1);
  });

  it("treats an error object inside a 200 body as a failure", async () => {
    provider.on("GET /models", { json: { error: { code: 402, message: "Insufficient credits" } } });
    await expect(api(config(), "/models")).rejects.toMatchObject({ code: "CREDITS" });
  });

  it("honours cancellation", async () => {
    provider.on("GET /models", () => new Promise((resolve) => setTimeout(() => resolve({ json: {} }), 500)));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(api(config(), "/models", { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("download", () => {
  it("truncates or rejects oversized bodies", async () => {
    provider.on("GET /big", { body: Buffer.alloc(5000, 97) });
    const truncated = await download(`${provider.url}/big`, { maxBytes: 1000, truncate: true });
    expect(truncated).toMatchObject({ truncated: true });
    expect(truncated.data.length).toBe(1000);
    await expect(download(`${provider.url}/big`, { maxBytes: 1000 })).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("errors", () => {
  it("maps statuses to codes with hints", () => {
    expect(httpError(402, "x").code).toBe("CREDITS");
    expect(httpError(404, "x").code).toBe("UNSUPPORTED");
    expect(httpError(400, "foo/bar is not a valid model ID").code).toBe("UNSUPPORTED");
    expect(httpError(400, "bad request").code).toBe("PROVIDER");
    expect(httpError(503, "x").retryable).toBe(true);
    expect(httpError(501, "x").retryable).toBe(false);
    expect(httpError(401, "x").toString()).toMatch(/^AUTH: x\nHint: /);
  });

  it("maps thrown values", () => {
    expect(toDtstError(Object.assign(new Error("gone"), { code: "ENOENT" })).code).toBe("NOT_FOUND");
    expect(toDtstError(new TypeError("fetch failed")).code).toBe("NETWORK");
    expect(toDtstError("weird")).toBeInstanceOf(DtstError);
  });
});
