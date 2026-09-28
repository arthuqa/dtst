/**
 * MCP progress + cancellation helpers.
 *
 * The SDK hands every tool handler a `RequestHandlerExtra` carrying the
 * client's `progressToken` and an `AbortSignal`. Progress notifications are
 * coalesced: long provider calls report often, and flooding the transport is
 * worse than a smooth stream of updates.
 */

import { logger } from "./log";

export interface McpRequestExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  sendNotification?: (notification: unknown) => Promise<void>;
}

export const NOOP_SIGNAL = new AbortController().signal;

export interface ProgressReporter {
  /** True when the client asked for progress on this request. */
  readonly enabled: boolean;
  report(progress: number, total?: number, message?: string): Promise<void>;
  /** Final update; marks the operation complete even if the interval has not elapsed. */
  done(message?: string): Promise<void>;
}

const NOOP_PROGRESS: ProgressReporter = {
  enabled: false,
  async report() {},
  async done() {},
};

const MIN_INTERVAL_MS = 250;

export function createProgress(extra: unknown, options: { minIntervalMs?: number } = {}): ProgressReporter {
  const request = (extra ?? {}) as McpRequestExtra;
  const token = request._meta?.progressToken;
  const send = request.sendNotification;
  if (token === undefined || typeof send !== "function") return NOOP_PROGRESS;

  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  let lastSentAt = 0;
  let lastProgress = -1;
  let queue: Promise<void> = Promise.resolve();

  const sendUpdate = async (
    progress: number,
    total: number | undefined,
    message: string | undefined,
  ): Promise<void> => {
    const params: Record<string, unknown> = { progressToken: token, progress };
    if (total !== undefined) params["total"] = total;
    if (message) params["message"] = message;
    try {
      await send({ method: "notifications/progress", params });
    } catch (error) {
      logger.debug("progress notification failed", { error });
    }
  };

  const report = async (progress: number, total?: number, message?: string): Promise<void> => {
    const now = Date.now();
    const waited = now - lastSentAt;
    if (waited < minIntervalMs) {
      queue = queue.then(async () => {
        const remaining = minIntervalMs - (Date.now() - lastSentAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        lastSentAt = Date.now();
        lastProgress = progress;
        await sendUpdate(progress, total, message);
      });
      return queue;
    }
    queue = queue.then(async () => {
      lastSentAt = Date.now();
      lastProgress = progress;
      await sendUpdate(progress, total, message);
    });
    return queue;
  };

  return {
    enabled: true,
    report,
    async done(message?: string) {
      const next = lastProgress < 0 ? 1 : lastProgress;
      await report(next, next, message ?? "done");
    },
  };
}

export function abortSignal(extra: unknown): AbortSignal {
  const signal = (extra as McpRequestExtra | undefined)?.signal;
  return signal ?? NOOP_SIGNAL;
}

export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Throw the canonical cancellation error when the client went away. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("Request cancelled by the client.");
  }
}
