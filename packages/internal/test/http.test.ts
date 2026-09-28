import { afterEach, describe, expect, it, vi } from "vitest";
import { DtstError, extractErrorMessage, fetchBinary, requestJson } from "@dtst/internal";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestJson", () => {
  it("parses a successful JSON response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestJson<{ ok: boolean }>("https://api.test/v1/thing", { maxRetries: 0 });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds, honouring a small Retry-After", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "0" });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const response = await requestJson<{ ok: boolean }>("https://api.test/v1/thing", { maxRetries: 2 });
    const elapsed = Date.now() - started;

    expect(response.json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry-After: 0 must be used instead of the ~1s exponential default.
    expect(elapsed).toBeLessThan(500);
  });

  it("throws PROVIDER_UNSUPPORTED for a 404 without retrying", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "model not found" } }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await requestJson("https://api.test/v1/thing", { maxRetries: 3 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error).toBeInstanceOf(DtstError);
    expect(error.code).toBe("PROVIDER_UNSUPPORTED");
    expect(error.status).toBe(404);
    expect(error.message).toContain("model not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 401 to PROVIDER_AUTH without retrying", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "bad key" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const error = (await requestJson("https://api.test/v1/thing", { maxRetries: 3 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("PROVIDER_AUTH");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 up to maxRetries and then throws a retryable PROVIDER_ERROR", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "boom" } }, 500, { "retry-after": "0" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await requestJson("https://api.test/v1/thing", { maxRetries: 2 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a response over maxBytes", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ big: "x".repeat(100) }));
    const error = (await requestJson("https://api.test/v1/thing", { maxRetries: 0, maxBytes: 10 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("too large");
  });
});

describe("extractErrorMessage", () => {
  it("handles the common provider shapes", () => {
    expect(extractErrorMessage({ error: { message: "boom" } }, "")).toBe("boom");
    expect(extractErrorMessage({ message: "plain" }, "")).toBe("plain");
    expect(extractErrorMessage({ error: "string error" }, "")).toBe("string error");
    expect(extractErrorMessage({ detail: "detail message" }, "")).toBe("detail message");
    expect(extractErrorMessage(undefined, "raw text")).toBe("raw text");
    expect(extractErrorMessage(undefined, "   ")).toBeUndefined();
  });
});

describe("fetchBinary", () => {
  it("downloads bytes with a content type", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } }),
    );
    const downloaded = await fetchBinary("https://api.test/i.png", { maxBytes: 10 });
    expect(downloaded.data.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(downloaded.contentType).toBe("image/png");
    expect(downloaded.finalUrl).toBe("https://api.test/i.png");
  });

  it("rejects an over-large declared response", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(Buffer.from([1]), { status: 200, headers: { "content-length": "100" } }),
    );
    const error = (await fetchBinary("https://api.test/big.png", { maxBytes: 2 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("BAD_INPUT");
  });

  it("rejects an over-large body", async () => {
    vi.stubGlobal("fetch", async () => new Response(Buffer.from([1, 2, 3, 4]), { status: 200 }));
    const error = (await fetchBinary("https://api.test/big.png", { maxBytes: 2 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("BAD_INPUT");
  });

  it("reports a failed download", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const error = (await fetchBinary("https://api.test/missing.png").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as DtstError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.status).toBe(404);
  });
});
