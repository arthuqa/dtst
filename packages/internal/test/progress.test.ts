import { describe, expect, it } from "vitest";
import { NOOP_SIGNAL, abortSignal, createProgress, throwIfAborted } from "@dtst/internal";

describe("createProgress", () => {
  it("is disabled without a progress token or sender", async () => {
    const reporter = createProgress({});
    expect(reporter.enabled).toBe(false);
    await expect(reporter.report(1, 2, "x")).resolves.toBeUndefined();
    await expect(reporter.done()).resolves.toBeUndefined();
  });

  it("is disabled when no sender is provided", () => {
    expect(createProgress({ _meta: { progressToken: "t" } }).enabled).toBe(false);
  });

  it("emits an immediate update and throttles subsequent ones", async () => {
    const notifications: Array<{ params: Record<string, unknown> }> = [];
    const reporter = createProgress(
      {
        _meta: { progressToken: "t" },
        sendNotification: async (notification: unknown) => {
          notifications.push(notification as { params: Record<string, unknown> });
        },
      },
      { minIntervalMs: 10 },
    );
    expect(reporter.enabled).toBe(true);

    await reporter.report(1, 10, "first");
    await reporter.report(2, 10, "second");
    await reporter.done("finished");

    expect(notifications).toHaveLength(3);
    expect(notifications.map((entry) => entry.params["progress"])).toEqual([1, 2, 2]);
    expect(notifications[2]?.params["message"]).toBe("finished");
  });

  it("done() always emits at least once", async () => {
    const sent: unknown[] = [];
    const reporter = createProgress(
      { _meta: { progressToken: 7 }, sendNotification: async (notification: unknown) => sent.push(notification) },
      { minIntervalMs: 10 },
    );
    await reporter.done();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { params: { progressToken: unknown; progress: number } }).params).toMatchObject({
      progressToken: 7,
      progress: 1,
    });
  });

  it("swallows a rejecting sendNotification", async () => {
    const reporter = createProgress(
      { _meta: { progressToken: "t" }, sendNotification: async () => Promise.reject(new Error("transport down")) },
      { minIntervalMs: 10 },
    );
    await expect(reporter.report(1)).resolves.toBeUndefined();
    await expect(reporter.done()).resolves.toBeUndefined();
  });
});

describe("abortSignal / throwIfAborted", () => {
  it("returns a no-op signal when the request has none", () => {
    expect(abortSignal(undefined)).toBe(NOOP_SIGNAL);
    expect(abortSignal({})).toBe(NOOP_SIGNAL);
  });

  it("returns the request signal when present", () => {
    const controller = new AbortController();
    expect(abortSignal({ signal: controller.signal })).toBe(controller.signal);
  });

  it("does nothing for a live signal and throws for an aborted one", () => {
    expect(() => throwIfAborted(NOOP_SIGNAL)).not.toThrow();

    const controller = new AbortController();
    controller.abort(new Error("boom"));
    expect(() => throwIfAborted(controller.signal)).toThrowError("boom");
  });
});
