import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResetAwareScheduler, type ResetVerification } from "../src/reset-scheduler.js";
import { loadSchedulerCursor } from "../src/scheduler-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "provider-pulse-reset-scheduler-"));
  temporaryDirectories.push(directory);
  return join(directory, "scheduler-state.json");
}

function createScheduler(options: {
  path: string;
  now?: string;
  refreshUsage?: () => Promise<ResetVerification>;
  runHeartbeat?: () => Promise<void>;
}) {
  return new ResetAwareScheduler({
    jobs: [{ id: "weekly-job", accountId: "grok", windowId: "weekly", offsetMinutes: 2, enabled: true }],
    stateFile: options.path,
    now: () => new Date(options.now ?? "2026-08-13T06:34:00.000Z"),
    callbacks: {
      refreshUsage: options.refreshUsage ?? (async () => ({ identityMatches: true, resetAt: "2026-08-13T06:31:00.000Z" })),
      runHeartbeat: options.runHeartbeat ?? (async () => undefined),
    },
  });
}

describe("ResetAwareScheduler", () => {
  it("waits for the offset, claims the reset before execution, and runs only once", async () => {
    const path = await statePath();
    const runHeartbeat = vi.fn(async () => {
      expect((await loadSchedulerCursor(path)).jobs["weekly-job"]?.lastHandledResetAt).toBe(
        "2026-08-13T06:31:00.000Z",
      );
    });
    const scheduler = createScheduler({ path, now: "2026-08-13T06:32:59.000Z", runHeartbeat });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");
    expect(await scheduler.tick()).toEqual([]);
    expect(runHeartbeat).not.toHaveBeenCalled();

    const due = createScheduler({ path, runHeartbeat });
    await due.initialize();
    expect(await due.tick()).toMatchObject([{ outcome: "heartbeat_succeeded" }]);
    expect(await due.tick()).toEqual([]);
    expect(runHeartbeat).toHaveBeenCalledTimes(1);

    const restarted = createScheduler({ path, runHeartbeat });
    await restarted.initialize();
    expect(await restarted.tick()).toEqual([]);
    expect(runHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("updates a changed provider reset without sending a redundant heartbeat", async () => {
    const path = await statePath();
    const runHeartbeat = vi.fn(async () => undefined);
    const scheduler = createScheduler({
      path,
      refreshUsage: async () => ({ identityMatches: true, resetAt: "2026-08-20T06:31:00Z" }),
      runHeartbeat,
    });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    expect(await scheduler.tick()).toMatchObject([{ outcome: "reset_changed" }]);
    expect(runHeartbeat).not.toHaveBeenCalled();
    expect(scheduler.snapshot().jobs["weekly-job"]?.lastObservedResetAt).toBe(
      "2026-08-20T06:31:00.000Z",
    );
  });

  it("fails closed on identity mismatch and does not poll every minute", async () => {
    const path = await statePath();
    const refreshUsage = vi.fn(async () => ({ identityMatches: false, resetAt: "2026-08-13T06:31:00Z" }));
    const runHeartbeat = vi.fn(async () => undefined);
    const scheduler = createScheduler({ path, refreshUsage, runHeartbeat });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    expect(await scheduler.tick()).toMatchObject([{ outcome: "identity_mismatch" }]);
    expect(await scheduler.tick()).toEqual([]);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
    expect(runHeartbeat).not.toHaveBeenCalled();
  });

  it("never automatically retries an ambiguous failed heartbeat", async () => {
    const path = await statePath();
    const runHeartbeat = vi.fn(async () => {
      throw new Error("connection lost");
    });
    const scheduler = createScheduler({ path, runHeartbeat });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    expect(await scheduler.tick()).toMatchObject([{ outcome: "heartbeat_failed" }]);
    expect(await scheduler.tick()).toEqual([]);
    expect(runHeartbeat).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().jobs["weekly-job"]?.lastHandledResetAt).toBe(
      "2026-08-13T06:31:00.000Z",
    );

    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z", {
      markFreshObservation: true,
    });
    expect(await scheduler.tick()).toEqual([]);
    expect(runHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("re-arms a failed preflight only after an explicit fresh observation", async () => {
    const path = await statePath();
    const refreshUsage = vi
      .fn<() => Promise<ResetVerification>>()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue({ identityMatches: true, resetAt: "2026-08-13T06:31:00Z" });
    const runHeartbeat = vi.fn(async () => undefined);
    const scheduler = createScheduler({ path, refreshUsage, runHeartbeat });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    expect(await scheduler.tick()).toMatchObject([{ outcome: "verification_failed" }]);
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");
    expect(await scheduler.tick()).toEqual([]);

    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z", {
      markFreshObservation: true,
    });
    expect(await scheduler.tick()).toMatchObject([{ outcome: "heartbeat_succeeded" }]);
    expect(runHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("records the next reset discovered by the post-heartbeat refresh", async () => {
    const path = await statePath();
    const refreshUsage = vi
      .fn<() => Promise<ResetVerification>>()
      .mockResolvedValueOnce({ identityMatches: true, resetAt: "2026-08-13T06:31:00Z" })
      .mockResolvedValueOnce({ identityMatches: true, resetAt: "2026-08-20T06:31:00Z" });
    const scheduler = createScheduler({ path, refreshUsage });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    expect(await scheduler.tick()).toMatchObject([{ outcome: "heartbeat_succeeded" }]);
    expect(scheduler.snapshot().jobs["weekly-job"]).toEqual({
      lastObservedResetAt: "2026-08-20T06:31:00.000Z",
      lastHandledResetAt: "2026-08-13T06:31:00.000Z",
    });
  });

  it("coalesces concurrent timer ticks", async () => {
    const path = await statePath();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshUsage = vi.fn(async () => {
      await gate;
      return { identityMatches: true, resetAt: "2026-08-13T06:31:00Z" };
    });
    const scheduler = createScheduler({ path, refreshUsage });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    const first = scheduler.tick();
    const second = scheduler.tick();
    release?.();
    expect(await first).toEqual(await second);
    expect(refreshUsage).toHaveBeenCalledTimes(2); // verification plus post-heartbeat refresh
  });

  it("serializes a fresh observation arriving during an active heartbeat cycle", async () => {
    const path = await statePath();
    let releaseVerification: (() => void) | undefined;
    let markVerificationStarted: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const refreshUsage = vi
      .fn<() => Promise<ResetVerification>>()
      .mockImplementationOnce(async () => {
        markVerificationStarted?.();
        await verificationGate;
        return { identityMatches: true, resetAt: "2026-08-13T06:31:00Z" };
      })
      .mockResolvedValue({ identityMatches: true, resetAt: "2026-08-13T06:31:00Z" });
    const scheduler = createScheduler({ path, refreshUsage });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");

    const tick = scheduler.tick();
    await verificationStarted;
    const observe = scheduler.observeReset("weekly-job", "2026-08-20T06:31:00Z", {
      markFreshObservation: true,
    });
    releaseVerification?.();
    await Promise.all([tick, observe]);

    expect(scheduler.snapshot().jobs["weekly-job"]).toEqual({
      lastObservedResetAt: "2026-08-20T06:31:00.000Z",
      lastHandledResetAt: "2026-08-13T06:31:00.000Z",
    });
    expect((await loadSchedulerCursor(path)).jobs["weekly-job"]).toEqual(
      scheduler.snapshot().jobs["weekly-job"],
    );
  });

  it("stops its timer and waits for an active tick to settle", async () => {
    const path = await statePath();
    let releaseVerification: (() => void) | undefined;
    let markVerificationStarted: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const scheduler = createScheduler({
      path,
      refreshUsage: async () => {
        markVerificationStarted?.();
        await verificationGate;
        return { identityMatches: true, resetAt: "2026-08-13T06:31:00Z" };
      },
    });
    await scheduler.initialize();
    await scheduler.observeReset("weekly-job", "2026-08-13T06:31:00Z");
    scheduler.start();
    const tick = scheduler.tick();
    await verificationStarted;

    let stopped = false;
    const stopping = scheduler.stopAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseVerification?.();
    await Promise.all([tick, stopping]);
    expect(stopped).toBe(true);
  });
});
