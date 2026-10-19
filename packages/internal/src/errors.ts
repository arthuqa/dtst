/** Every failure an agent sees has a stable `code`, a message and, where possible, a one-line fix. */

export type ErrorCode =
  | "CONFIG"
  | "BAD_INPUT"
  | "NOT_FOUND"
  | "AUTH"
  | "CREDITS"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "UNSUPPORTED"
  | "PROVIDER"
  | "CANCELLED"
  | "INTERNAL";

export class DtstError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DtstError";
  }

  get retryable(): boolean {
    if (this.code === "RATE_LIMIT" || this.code === "NETWORK") return true;
    return this.code === "PROVIDER" && this.status !== undefined && this.status >= 500;
  }

  override toString(): string {
    return `${this.code}: ${this.message}${this.hint ? `\nHint: ${this.hint}` : ""}`;
  }
}

export const badInput = (message: string, hint?: string): DtstError => new DtstError("BAD_INPUT", message, hint);

/** Map an HTTP failure from the provider onto a code + hint. */
export function httpError(status: number, message: string, retryAfterMs?: number): DtstError {
  const text = message || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new DtstError("AUTH", text, "Check OPENAI_API_KEY and that it is valid for OPENAI_BASE_URL.", status);
  }
  if (status === 402) {
    return new DtstError("CREDITS", text, "The provider account is out of credits; top it up and retry.", status);
  }
  if (status === 429) {
    return new DtstError("RATE_LIMIT", text, "Rate limited; retry shortly or lower `n`.", status, retryAfterMs);
  }
  if (status === 400 && /model/i.test(text) && /not a valid|not found|does not exist|unknown/i.test(text)) {
    return new DtstError("UNSUPPORTED", text, "Unknown model id; check it with the list tool.", status);
  }
  if (status === 404 || status === 405 || status === 501) {
    return new DtstError(
      "UNSUPPORTED",
      text,
      "Unknown endpoint or model; check the model id with the list tool.",
      status,
    );
  }
  if (status === 408 || status === 504)
    return new DtstError("TIMEOUT", text, "Retry, or raise DTST_TIMEOUT_MS.", status);
  return new DtstError("PROVIDER", text, undefined, status, retryAfterMs);
}

export function toDtstError(error: unknown): DtstError {
  if (error instanceof DtstError) return error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (err.name === "AbortError") return new DtstError("CANCELLED", "Request cancelled.");
  if (err.name === "TimeoutError") {
    return new DtstError("TIMEOUT", "The provider did not answer in time.", "Raise DTST_TIMEOUT_MS, or retry.");
  }
  const code = (err as { code?: string }).code ?? (err.cause as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return new DtstError("NOT_FOUND", err.message);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new DtstError("BAD_INPUT", err.message, "Choose a writable location, e.g. inside the workspace.");
  }
  if (err.message === "fetch failed" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(`${err.message} ${code}`)) {
    return new DtstError("NETWORK", `Cannot reach the provider (${code ?? err.message}).`, "Check OPENAI_BASE_URL.");
  }
  return new DtstError("INTERNAL", err.message);
}
