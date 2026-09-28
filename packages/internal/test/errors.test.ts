import { describe, expect, it } from "vitest";
import { DtstError, isDtstError, toDtstError } from "@dtst/internal";

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("toDtstError", () => {
  it("maps 401 to PROVIDER_AUTH", () => {
    const mapped = toDtstError(statusError("Unauthorized", 401));
    expect(mapped.code).toBe("PROVIDER_AUTH");
    expect(mapped.status).toBe(401);
    expect(mapped.hint).toBeTruthy();
  });

  it("maps 404 to PROVIDER_UNSUPPORTED", () => {
    const mapped = toDtstError(statusError("model not found", 404));
    expect(mapped.code).toBe("PROVIDER_UNSUPPORTED");
    expect(mapped.status).toBe(404);
  });

  it("maps 429 to a retryable PROVIDER_RATE_LIMIT", () => {
    const mapped = toDtstError(statusError("rate limited", 429));
    expect(mapped.code).toBe("PROVIDER_RATE_LIMIT");
    expect(mapped.retryable).toBe(true);
  });

  it("maps 500 to a retryable PROVIDER_ERROR", () => {
    const mapped = toDtstError(statusError("server exploded", 500));
    expect(mapped.code).toBe("PROVIDER_ERROR");
    expect(mapped.retryable).toBe(true);
  });

  it("maps AbortError to CANCELLED", () => {
    const mapped = toDtstError(namedError("AbortError", "The operation was aborted."));
    expect(mapped.code).toBe("CANCELLED");
  });

  it("maps APIConnectionTimeoutError to PROVIDER_TIMEOUT", () => {
    const mapped = toDtstError(namedError("APIConnectionTimeoutError", "Request timed out."));
    expect(mapped.code).toBe("PROVIDER_TIMEOUT");
    expect(mapped.retryable).toBe(true);
  });

  it("maps a connection-refused message to NETWORK", () => {
    const mapped = toDtstError(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
    expect(mapped.code).toBe("NETWORK");
    expect(mapped.retryable).toBe(true);
  });

  it("passes an existing DtstError through unchanged", () => {
    const original = new DtstError("BAD_INPUT", "nope", { hint: "fix it" });
    expect(toDtstError(original)).toBe(original);
    expect(isDtstError(original)).toBe(true);
  });

  it("falls back to INTERNAL for unknown errors", () => {
    expect(toDtstError(new Error("mystery")).code).toBe("INTERNAL");
    expect(toDtstError("string failure").code).toBe("INTERNAL");
  });
});

describe("DtstError.format", () => {
  it("includes the code, message and hint", () => {
    const error = new DtstError("PROVIDER_ERROR", "boom", { status: 502, hint: "retry later" });
    const formatted = error.format();
    expect(formatted).toContain("PROVIDER_ERROR");
    expect(formatted).toContain("boom");
    expect(formatted).toContain("HTTP 502");
    expect(formatted).toContain("Hint: retry later");
  });
});
