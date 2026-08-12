import { describe, expect, it } from "vitest";

import { StatusStore, aggregateHealth } from "./status-store.js";
import type { AppConfig } from "./types.js";

const config: AppConfig = {
  version: 1,
  server: { host: "127.0.0.1", port: 4317 },
  paths: { stateDirectory: "/tmp/state", probeDirectory: "/tmp/probes" },
  polling: {
    automaticIntervalMinutes: null,
    startupCheck: false,
    maxConcurrency: 1,
    staleAfterMinutes: 240,
  },
  accounts: [
    {
      id: "grok-main",
      label: "Grok main",
      provider: "grok",
      expectedIdentity: { email: "expected@example.com" },
      usageSource: { adapter: "grok-tmux", credentialSurfaceId: "grok-native" },
    },
  ],
  credentialSurfaces: [
    { id: "grok-native", kind: "native-grok", home: "/tmp/grok", executable: "grok" },
  ],
  heartbeatJobs: [
    {
      id: "grok-heartbeat",
      accountId: "grok-main",
      credentialSurfaceId: "grok-native",
      executor: "native-grok",
      model: "grok-4",
      reasoning: "low",
      prompt: "OK",
      trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
      timeoutSeconds: 60,
      enabled: false,
    },
  ],
};

describe("StatusStore", () => {
  it("starts runtime status unknown and disabled without invented history", () => {
    const snapshot = new StatusStore(config).snapshot(new Date("2026-08-11T12:00:00Z"));
    expect(snapshot).toMatchObject({
      generatedAt: "2026-08-11T12:00:00.000Z",
      health: "unknown",
      accounts: [{ usage: { health: "unknown", identity: { match: "unknown" } } }],
      heartbeats: [{ health: "disabled", enabled: false }],
    });
  });

  it("exposes the configured provider for generic Pi heartbeat jobs", () => {
    const piConfig = structuredClone(config);
    piConfig.credentialSurfaces.push({
      id: "pi-grok",
      kind: "pi",
      home: "/tmp/pi-grok",
      executable: "pi",
    });
    piConfig.heartbeatJobs = [{
      ...piConfig.heartbeatJobs[0]!,
      id: "pi-grok-heartbeat",
      credentialSurfaceId: "pi-grok",
      executor: "pi",
      provider: "xai",
    }];
    expect(new StatusStore(piConfig).snapshot().heartbeats[0]).toMatchObject({
      executor: "pi",
      provider: "xai",
    });
  });

  it("isolates stored state and returned snapshots from caller mutation", () => {
    const store = new StatusStore(config);
    const updated = store.updateAccount("grok-main", (account) => {
      account.usage.health = "healthy";
      return account;
    });
    updated.usage.health = "unhealthy";
    const snapshot = store.snapshot();
    snapshot.accounts[0]!.usage.health = "stale";
    expect(store.getAccount("grok-main")?.usage.health).toBe("healthy");
  });
});

describe("aggregateHealth", () => {
  it("uses explicit severity and ignores disabled jobs", () => {
    expect(aggregateHealth(["healthy", "disabled"])).toBe("healthy");
    expect(aggregateHealth(["healthy", "running"])).toBe("running");
    expect(aggregateHealth(["running", "stale"])).toBe("stale");
    expect(aggregateHealth(["stale", "unhealthy"])).toBe("unhealthy");
  });
});
