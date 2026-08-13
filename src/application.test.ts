import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ProviderPulseApplication,
  RuntimeDependencyError,
  validateRuntimeDependencies,
  type UsageProbeResult,
} from "./application.js";
import { writeSchedulerCursorAtomic } from "./scheduler-state.js";
import type { AppConfig, UsageWindow } from "./types.js";
import { loadUsageBaselineState } from "./usage-baseline-state.js";

describe("ProviderPulseApplication", () => {
  it("coalesces account checks and keeps status reads side-effect free", async () => {
    const deferred = withResolvers<UsageProbeResult>();
    const probe = vi.fn(() => deferred.promise);
    const app = new ProviderPulseApplication(await testConfig(), {
      usageProbe: probe,
      createOperationId: idSequence(),
    });

    expect(app.getStatus().accounts[0]?.usage.health).toBe("unknown");
    expect(app.getStatus().accounts[0]?.usage.health).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();

    const first = app.checkUsage("codex-one");
    const second = app.checkUsage("codex-one");
    expect(second).toMatchObject({ operationId: first.operationId, coalesced: true });
    expect(app.getStatus().accounts[0]?.usage.health).toBe("running");

    deferred.resolve(successfulUsage("person@example.com"));
    await vi.waitFor(() => expect(app.getStatus().accounts[0]?.usage.health).toBe("healthy"));
    expect(probe).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("persists baselines and rebases only the provider window that resets", async () => {
    const config = await testConfig();
    let now = new Date("2026-08-12T14:00:00.000Z");
    let windows: UsageWindow[] = [
      {
        id: "session",
        label: "Current session",
        remainingPercent: 100,
        resetsAt: "2026-08-12T18:00:00.000Z",
      },
      {
        id: "weekly",
        label: "Current week",
        remainingPercent: 80,
        resetsAt: "2026-08-17T12:00:00.000Z",
      },
    ];
    const usageProbe = vi.fn(async () => successfulUsage("person@example.com", windows));
    const app = new ProviderPulseApplication(config, { usageProbe, now: () => now });

    app.checkUsage("codex-one");
    await vi.waitFor(() => expect(app.getStatus().usageBaseline.metrics).toHaveLength(2));
    expect(app.getStatus().usageBaseline).toMatchObject({
      health: "healthy",
      updatedAt: "2026-08-12T14:00:00.000Z",
      metrics: [
        { metricId: "session", remainingPercent: 100, capturedAt: "2026-08-12T14:00:00.000Z" },
        { metricId: "weekly", remainingPercent: 80, capturedAt: "2026-08-12T14:00:00.000Z" },
      ],
    });

    now = new Date("2026-08-12T18:05:00.000Z");
    windows = [
      {
        id: "session",
        label: "Current session",
        remainingPercent: 100,
      },
      {
        id: "weekly",
        label: "Current week",
        remainingPercent: 70,
        resetsAt: "2026-08-17T12:00:00.000Z",
      },
    ];
    app.checkUsage("codex-one");
    await vi.waitFor(() => expect(
      app.getStatus().usageBaseline.metrics.find((metric) => metric.metricId === "session"),
    ).toMatchObject({
      remainingPercent: 100,
      capturedAt: "2026-08-12T18:05:00.000Z",
    }));
    expect(app.getStatus().usageBaseline.metrics.find((metric) => metric.metricId === "weekly"))
      .toMatchObject({
        remainingPercent: 80,
        capturedAt: "2026-08-12T14:00:00.000Z",
      });

    await vi.waitFor(() => expect(app.getStatus().accounts[0]?.usage.inFlight).toBe(false));
    await app.snapshotUsageBaseline();
    expect(app.getStatus().usageBaseline.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricId: "session", remainingPercent: 100, capturedAt: "2026-08-12T18:05:00.000Z" }),
      expect.objectContaining({ metricId: "weekly", remainingPercent: 70, capturedAt: "2026-08-12T18:05:00.000Z" }),
    ]));
    await app.close();

    const persisted = await loadUsageBaselineState(join(config.paths.stateDirectory, "usage-baseline.json"));
    expect(persisted.metrics).toHaveLength(2);
    const restarted = new ProviderPulseApplication(config, { usageProbe, now: () => now });
    await restarted.initialize();
    expect(restarted.getStatus().usageBaseline.metrics).toEqual(app.getStatus().usageBaseline.metrics);
    await restarted.close();
  });

  it("bounds check-all concurrency", async () => {
    const config = await testConfig();
    delete config.accounts[0]!.expectedIdentity;
    config.accounts.push({
      id: "codex-two",
      label: "Codex two",
      provider: "codex",
      usageSource: { adapter: "codex-app-server", credentialSurfaceId: "codex-two-native" },
    });
    config.credentialSurfaces.push({
      id: "codex-two-native",
      kind: "native-codex",
      home: "/tmp/provider-pulse-codex-two",
      executable: "codex",
    });
    config.polling.maxConcurrency = 1;
    const releases = [withResolvers<UsageProbeResult>(), withResolvers<UsageProbeResult>()];
    let active = 0;
    let maximum = 0;
    const probe = vi.fn(async () => {
      const index = active === 0 && probe.mock.calls.length === 1 ? 0 : 1;
      active += 1;
      maximum = Math.max(maximum, active);
      const result = await releases[index]!.promise;
      active -= 1;
      return result;
    });
    const app = new ProviderPulseApplication(config, { usageProbe: probe });

    expect(app.checkAll()).toHaveLength(2);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    releases[0]!.resolve(successfulUsage());
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    releases[1]!.resolve(successfulUsage());
    await vi.waitFor(() => expect(app.getStatus().accounts.every((account) => account.usage.health === "healthy")).toBe(true));
    expect(maximum).toBe(1);
    await app.close();
  });

  it("blocks a heartbeat on identity mismatch without invoking its executor", async () => {
    const config = await testConfig(true);
    const heartbeat = vi.fn(async () => ({ durationMs: 1 }));
    const app = new ProviderPulseApplication(config, {
      usageProbe: async () => successfulUsage("wrong@example.com"),
      heartbeatRunner: heartbeat,
    });

    app.runHeartbeat("codex-one-native-weekly");
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.health).toBe("unhealthy"));
    expect(app.getStatus().heartbeats[0]?.error?.code).toBe("identity_mismatch");
    expect(heartbeat).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports a configured reset window that a successful usage poll cannot produce", async () => {
    const config = await testConfig(true);
    delete config.accounts[0]!.expectedIdentity;
    let windows: UsageWindow[] = [];
    const app = new ProviderPulseApplication(config, {
      usageProbe: async () => successfulUsage(undefined, windows),
    });

    await app.initialize();
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.health).toBe("unhealthy"));
    const missingWindow = app.getStatus().heartbeats[0];
    expect(missingWindow).not.toHaveProperty("nextEligibleAt");
    expect(missingWindow).toMatchObject({
      error: {
        code: "heartbeat_reset_window_unavailable",
        message: "Usage adapter did not report configured reset window weekly",
      },
    });

    windows = [{
      id: "weekly",
      label: "Weekly",
      resetsAt: "2026-08-20T12:00:00.000Z",
    }];
    app.checkUsage("codex-one");
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.nextEligibleAt).toBe("2026-08-20T12:02:00.000Z"));
    expect(app.getStatus().heartbeats[0]).toMatchObject({ health: "unknown" });
    expect(app.getStatus().heartbeats[0]).not.toHaveProperty("error");
    await app.close();
  });

  it("runs a due reset heartbeat without deadlocking on scheduler usage observations", async () => {
    const config = await testConfig(true);
    const resetAt = "2026-08-13T06:31:00.000Z";
    const usageProbe = vi.fn(async () => successfulUsage("person@example.com", [{
      id: "weekly",
      label: "Weekly",
      durationMinutes: 10_080,
      resetsAt: resetAt,
    }]));
    const heartbeatRunner = vi.fn(async () => ({ durationMs: 2 }));
    const app = new ProviderPulseApplication(config, {
      usageProbe,
      heartbeatRunner,
      now: () => new Date("2026-08-13T06:34:00.000Z"),
      schedulerTickIntervalMilliseconds: 5,
    });

    await app.initialize();
    await vi.waitFor(() => expect(heartbeatRunner).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]).toMatchObject({
      health: "healthy",
      inFlight: false,
    }));
    await vi.waitFor(
      () => expect(app.getStatus().heartbeats[0]?.nextEligibleAt).toBe("2026-08-20T06:36:00.000Z"),
      { timeout: 3_000 },
    );
    await app.close();

    expect(usageProbe.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(heartbeatRunner).toHaveBeenCalledTimes(1);
  });

  it("treats a fully reset inactive window as eligible instead of unhealthy", async () => {
    const config = await testConfig(true);
    const resetAt = "2026-08-13T06:31:00.000Z";
    await writeSchedulerCursorAtomic(join(config.paths.stateDirectory, "scheduler-state.json"), {
      version: 1,
      jobs: {
        "codex-one-native-weekly": {
          lastObservedResetAt: resetAt,
          lastHandledResetAt: null,
        },
      },
    });
    const usageProbe = vi.fn(async () => successfulUsage("person@example.com", [{
      id: "weekly",
      label: "Weekly",
      usedPercent: 0,
      remainingPercent: 100,
      durationMinutes: 300,
    }]));
    const heartbeatRunner = vi.fn(async () => ({ durationMs: 2 }));
    const app = new ProviderPulseApplication(config, {
      usageProbe,
      heartbeatRunner,
      now: () => new Date("2026-08-13T06:34:00.000Z"),
      schedulerTickIntervalMilliseconds: 5,
    });

    await app.initialize();
    await vi.waitFor(() => expect(heartbeatRunner).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]).toMatchObject({
      health: "healthy",
      inFlight: false,
    }));
    expect(app.getStatus().heartbeats[0]).not.toHaveProperty("error");
    expect(app.getStatus().heartbeats[0]?.nextEligibleAt).toBe("2026-08-13T11:36:00.000Z");
    await app.close();

    expect(heartbeatRunner).toHaveBeenCalledTimes(1);
  });

  it("serializes usage and heartbeat work on the same credential surface", async () => {
    const config = await testConfig(true);
    delete config.accounts[0]!.expectedIdentity;
    const firstProbe = withResolvers<UsageProbeResult>();
    let probes = 0;
    const usageProbe = vi.fn(async () => {
      probes += 1;
      return probes === 1 ? firstProbe.promise : successfulUsage();
    });
    const heartbeatRunner = vi.fn(async () => ({ durationMs: 2 }));
    const app = new ProviderPulseApplication(config, { usageProbe, heartbeatRunner });

    app.checkUsage("codex-one");
    app.runHeartbeat("codex-one-native-weekly");
    await vi.waitFor(() => expect(usageProbe).toHaveBeenCalledTimes(1));
    expect(heartbeatRunner).not.toHaveBeenCalled();

    firstProbe.resolve(successfulUsage());
    await vi.waitFor(() => expect(heartbeatRunner).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(usageProbe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.lastSuccessAt).toBeDefined());
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.inFlight).toBe(false));
    await app.close();
  });

  it("runs one bulk heartbeat for jobs that differ only by reset trigger", async () => {
    const config = await testConfig(true);
    delete config.accounts[0]!.expectedIdentity;
    config.heartbeatJobs.push({
      ...config.heartbeatJobs[0]!,
      id: "codex-one-native-session",
      trigger: { type: "after-reset", windowId: "session", offsetMinutes: 2 },
    });
    const heartbeatRunner = vi.fn(async () => ({ durationMs: 2 }));
    const app = new ProviderPulseApplication(config, {
      usageProbe: async () => successfulUsage(),
      heartbeatRunner,
    });

    expect(app.heartbeatAll()).toHaveLength(1);
    await vi.waitFor(() => expect(heartbeatRunner).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it("fails closed when expected identity cannot verify a distinct heartbeat surface", async () => {
    const config = await testConfig();
    config.credentialSurfaces.push({
      id: "pi-codex-one",
      kind: "pi",
      home: "/tmp/provider-pulse-pi-codex-one",
      executable: "pi",
    });
    config.heartbeatJobs.push({
      id: "pi-codex-one-weekly",
      accountId: "codex-one",
      credentialSurfaceId: "pi-codex-one",
      executor: "pi",
      provider: "openai-codex",
      model: "gpt-5",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
      timeoutSeconds: 30,
      enabled: true,
    });
    const heartbeat = vi.fn(async () => ({ durationMs: 1 }));
    const usage = vi.fn(async () => successfulUsage("person@example.com"));
    const app = new ProviderPulseApplication(config, { usageProbe: usage, heartbeatRunner: heartbeat });

    app.runHeartbeat("pi-codex-one-weekly");
    await vi.waitFor(() => expect(app.getStatus().heartbeats[0]?.health).toBe("unhealthy"));
    expect(app.getStatus().heartbeats[0]?.error?.code).toBe("heartbeat_identity_unverifiable");
    expect(usage).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    await app.close();
  });

  it("resets the private terminal namespace at startup and shutdown and rejects actions while closing", async () => {
    const terminalCleanup = vi.fn(async () => undefined);
    const app = new ProviderPulseApplication(await testConfig(), {
      usageProbe: async () => successfulUsage(),
      terminalCleanup,
    });

    await app.initialize();
    expect(terminalCleanup).toHaveBeenCalledTimes(1);
    await app.close();
    expect(terminalCleanup).toHaveBeenCalledTimes(2);
    expect(() => app.checkUsage("codex-one")).toThrowError(/stopping/i);
    expect(() => app.runHeartbeat("missing")).toThrowError(/stopping/i);
  });
});

describe("runtime validation", () => {
  it("accepts an executable resolved from PATH and existing credential home", async () => {
    const config = await testConfig();
    const root = await mkdtemp(join(tmpdir(), "provider-pulse-runtime-"));
    const home = join(root, "home");
    const binaries = join(root, "bin");
    await Promise.all([mkdir(home), mkdir(binaries)]);
    await writeFile(join(binaries, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    const surface = config.credentialSurfaces[0]!;
    if (surface.kind === "fireworks-api") throw new Error("Expected CLI surface");
    surface.home = home;

    await expect(validateRuntimeDependencies(config, { environment: { PATH: binaries } })).resolves.toBeUndefined();
  });

  it("rejects a non-executable absolute file without disclosing its path", async () => {
    const config = await testConfig();
    const root = await mkdtemp(join(tmpdir(), "provider-pulse-runtime-"));
    const executable = join(root, "codex-secret-location");
    await writeFile(executable, "", { mode: 0o600 });
    await chmod(executable, 0o600);
    const surface = config.credentialSurfaces[0]!;
    if (surface.kind === "fireworks-api") throw new Error("Expected CLI surface");
    surface.home = root;
    surface.executable = executable;

    const error = await validateRuntimeDependencies(config).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeDependencyError);
    expect(String(error)).not.toContain(executable);
    expect(error).toMatchObject({ surfaceId: "codex-one-native", code: "executable_unavailable" });
  });

  it("requires tmux when a terminal adapter is configured", async () => {
    const config = await testConfig();
    const root = await mkdtemp(join(tmpdir(), "provider-pulse-runtime-"));
    const binary = join(root, "codex");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
    const surface = config.credentialSurfaces[0]!;
    if (surface.kind === "fireworks-api") throw new Error("Expected CLI surface");
    surface.home = root;
    surface.executable = binary;
    config.accounts[0]!.usageSource.adapter = "claude-tmux";

    await expect(validateRuntimeDependencies(config, { environment: { PATH: "" } })).rejects.toMatchObject({
      surfaceId: "tmux",
      code: "executable_unavailable",
    });
  });

  it("requires an owner-only Fireworks API credential file", async () => {
    const config = await testConfig();
    const root = await mkdtemp(join(tmpdir(), "provider-pulse-fireworks-runtime-"));
    const credentialFile = join(root, "api-key");
    await writeFile(credentialFile, "fw_test_key\n", { mode: 0o600 });
    config.credentialSurfaces = [{
      id: "fireworks-one-api",
      kind: "fireworks-api",
      credentialFile,
    }];

    await expect(validateRuntimeDependencies(config)).resolves.toBeUndefined();
    await chmod(credentialFile, 0o644);
    await expect(validateRuntimeDependencies(config)).rejects.toMatchObject({
      surfaceId: "fireworks-one-api",
      code: "credential_file_permissions_invalid",
    });
  });

  it("fails startup when Pi's offline catalog does not contain a configured provider/model", async () => {
    const config = await testConfig();
    const root = await mkdtemp(join(tmpdir(), "provider-pulse-runtime-"));
    const binary = join(root, "pi");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
    const surface = config.credentialSurfaces[0]!;
    if (surface.kind === "fireworks-api") throw new Error("Expected CLI surface");
    surface.home = root;
    surface.executable = binary;
    config.credentialSurfaces.push({ id: "pi-one", kind: "pi", home: root, executable: binary });
    config.heartbeatJobs.push({
      id: "pi-one-weekly",
      accountId: "codex-one",
      credentialSurfaceId: "pi-one",
      executor: "pi",
      provider: "openai-codex",
      model: "gpt-5",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
      timeoutSeconds: 30,
      enabled: true,
    });
    const piModelCatalogProbe = vi.fn(async () => false);

    await expect(validateRuntimeDependencies(config, { piModelCatalogProbe })).rejects.toMatchObject({
      surfaceId: "pi-one",
      code: "pi_model_unavailable",
    });
    expect(piModelCatalogProbe).toHaveBeenCalledWith(config.heartbeatJobs[0], config.credentialSurfaces[1]);
  });
});

async function testConfig(withHeartbeat = false): Promise<AppConfig> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "provider-pulse-app-"));
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 4317 },
    paths: { stateDirectory, probeDirectory: stateDirectory },
    polling: {
      automaticIntervalMinutes: null,
      startupCheck: false,
      maxConcurrency: 2,
      staleAfterMinutes: 60,
    },
    accounts: [{
      id: "codex-one",
      label: "Codex one",
      provider: "codex",
      expectedIdentity: { email: "person@example.com" },
      usageSource: { adapter: "codex-app-server", credentialSurfaceId: "codex-one-native" },
    }],
    credentialSurfaces: [{
      id: "codex-one-native",
      kind: "native-codex",
      home: "/tmp/provider-pulse-codex-one",
      executable: "codex",
    }],
    heartbeatJobs: withHeartbeat ? [{
      id: "codex-one-native-weekly",
      accountId: "codex-one",
      credentialSurfaceId: "codex-one-native",
      executor: "native-codex",
      model: "gpt-5",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
      timeoutSeconds: 30,
      enabled: true,
    }] : [],
  };
}

function successfulUsage(email?: string, windows: UsageWindow[] = []): UsageProbeResult {
  return {
    identity: email === undefined ? {} : { email },
    snapshot: { observedAt: new Date().toISOString(), windows, balances: [] },
    implementation: "fake",
    implementationVersion: "1",
  };
}

function idSequence(): () => string {
  let value = 0;
  return () => `operation-${++value}`;
}

function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
