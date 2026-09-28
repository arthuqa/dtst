/**
 * Error taxonomy for the @dtst servers.
 *
 * Every error surfaced to an agent must be actionable: `code` is a stable,
 * machine-readable identifier, `hint` tells the caller how to fix it, and
 * secrets are never included (they are scrubbed by the logger / formatter).
 */

export type ErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "BAD_INPUT"
  | "NOT_FOUND"
  | "PERMISSION"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_ERROR"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TIMEOUT"
  | "NETWORK"
  | "OUTPUT_WRITE"
  | "CANCELLED"
  | "INTERNAL";

export interface DtstErrorOptions {
  hint?: string;
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class DtstError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: DtstErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DtstError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }

  /** Human/agent readable single-line-ish rendering. */
  format(): string {
    const parts = [`${this.code}: ${this.message}`];
    if (this.status !== undefined) parts.push(`(HTTP ${this.status})`);
    if (this.hint) parts.push(`Hint: ${this.hint}`);
    return parts.join(" ");
  }
}

export function isDtstError(error: unknown): error is DtstError {
  return error instanceof DtstError;
}

export function configError(message: string, hint?: string): DtstError {
  return new DtstError("CONFIG_MISSING", message, hint === undefined ? {} : { hint });
}

export function invalidConfig(message: string, hint?: string): DtstError {
  return new DtstError("CONFIG_INVALID", message, hint === undefined ? {} : { hint });
}

export function badInput(message: string, hint?: string): DtstError {
  return new DtstError("BAD_INPUT", message, hint === undefined ? {} : { hint });
}

export function notFound(message: string, hint?: string): DtstError {
  return new DtstError("NOT_FOUND", message, hint === undefined ? {} : { hint });
}

export function outputError(message: string, options: DtstErrorOptions = {}): DtstError {
  return new DtstError("OUTPUT_WRITE", message, options);
}

export function cancelledError(message = "Operation cancelled by the client."): DtstError {
  return new DtstError("CANCELLED", message, { retryable: false });
}

/**
 * Map an arbitrary thrown value onto a DtstError so the agent always gets a
 * stable `code` plus a hint it can act on.
 */
export function toDtstError(error: unknown): DtstError {
  if (isDtstError(error)) return error;

  const err = error instanceof Error ? error : new Error(String(error));
  const status = extractStatus(err);
  const message = err.message || err.name;

  if (err.name === "AbortError" || err.name === "APIUserAbortError") {
    return new DtstError("CANCELLED", "The request was aborted.", { cause: err });
  }
  if (err.name === "APIConnectionTimeoutError" || /timed? ?out/i.test(message)) {
    return new DtstError("PROVIDER_TIMEOUT", message, {
      retryable: true,
      cause: err,
      hint: "Increase DTST_TIMEOUT_MS, or retry with a smaller request.",
    });
  }
  if (status === 401 || status === 403) {
    return new DtstError("PROVIDER_AUTH", message, {
      status,
      cause: err,
      hint: "Check OPENAI_API_KEY and OPENAI_BASE_URL. The key must be valid for that endpoint.",
    });
  }
  if (status === 429) {
    return new DtstError("PROVIDER_RATE_LIMIT", message, {
      status,
      retryable: true,
      cause: err,
      hint: "Rate limited by the provider. Retry in a few seconds or lower `n`.",
    });
  }
  if (status === 404) {
    return new DtstError("PROVIDER_UNSUPPORTED", message, {
      status,
      cause: err,
      hint: "The endpoint or model does not exist. Verify OPENAI_BASE_URL, the model name, and try `list_models`.",
    });
  }
  if (status !== undefined && status >= 400) {
    return new DtstError("PROVIDER_ERROR", message, {
      status,
      retryable: status >= 500,
      cause: err,
    });
  }
  if (err.name === "APIConnectionError" || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new DtstError("NETWORK", message, {
      retryable: true,
      cause: err,
      hint: "Could not reach OPENAI_BASE_URL. Check network access and the URL.",
    });
  }
  return new DtstError("INTERNAL", message, { cause: err });
}

function extractStatus(err: Error): number | undefined {
  const candidate = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
