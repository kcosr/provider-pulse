import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ConfigLoadError, loadConfig, parseConfig } from "./config.js";

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 4317 },
    paths: { stateDirectory: "/tmp/pulse-state", probeDirectory: "/tmp/pulse-probes" },
    polling: {
      automaticIntervalMinutes: null,
      startupCheck: true,
      maxConcurrency: 2,
      staleAfterMinutes: 240,
    },
    accounts: [
      {
        id: "codex-primary",
        label: "Codex primary",
        provider: "codex",
        expectedIdentity: { email: "FIRST@example.com" },
        usageSource: {
          adapter: "codex-app-server",
          credentialSurfaceId: "codex-primary-native",
        },
      },
    ],
    credentialSurfaces: [
      {
        id: "codex-primary-native",
        kind: "native-codex",
        home: "/tmp/codex-primary",
        executable: "codex",
      },
    ],
    heartbeatJobs: [],
  };
}

describe("parseConfig", () => {
  it("accepts the strict version-one contract", () => {
    expect(parseConfig(validConfig())).toMatchObject({ version: 1, accounts: [{ id: "codex-primary" }] });
  });

  it("accepts namespaced normalized usage-window IDs", () => {
    const config = validConfig();
    config.heartbeatJobs = [{
      id: "codex-primary-reset",
      accountId: "codex-primary",
      credentialSurfaceId: "codex-primary-native",
      executor: "native-codex",
      model: "gpt-5.3-codex",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "codex:primary", offsetMinutes: 2 },
      timeoutSeconds: 120,
      enabled: true,
    }];

    expect(parseConfig(config).heartbeatJobs[0]?.trigger.windowId).toBe("codex:primary");
  });

  it("rejects unknown fields", () => {
    expect(() => parseConfig({ ...validConfig(), ignored: true })).toThrow(/Unrecognized key/);
  });

  it("rejects duplicate IDs and missing cross references", () => {
    const config = validConfig();
    const account = (config.accounts as Record<string, unknown>[])[0];
    config.accounts = [account, { ...account }];
    config.credentialSurfaces = [];
    expect(() => parseConfig(config)).toThrow(/duplicate ID|unknown credential surface/);
  });

  it("rejects an adapter paired with the wrong provider or surface kind", () => {
    const config = validConfig();
    (config.accounts as Record<string, unknown>[])[0] = {
      ...(config.accounts as Record<string, unknown>[])[0],
      provider: "claude",
    };
    expect(() => parseConfig(config)).toThrow(/not valid for provider/);
  });

  it("requires Pi-specific provider and matching executor surfaces", () => {
    const config = validConfig();
    (config.credentialSurfaces as Record<string, unknown>[]).push({
      id: "pi-primary",
      kind: "pi",
      home: "/tmp/pi-primary",
      executable: "pi",
    });
    config.heartbeatJobs = [
      {
        id: "pi-weekly",
        accountId: "codex-primary",
        credentialSurfaceId: "pi-primary",
        executor: "pi",
        model: "model-1",
        reasoning: "low",
        prompt: "Reply OK.",
        trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
        timeoutSeconds: 120,
        enabled: true,
      },
    ];
    expect(() => parseConfig(config)).toThrow(/provider/);
  });

  it("rejects a native heartbeat executor for a different account provider", () => {
    const config = validConfig();
    (config.credentialSurfaces as Record<string, unknown>[]).push({
      id: "claude-native",
      kind: "native-claude",
      home: "/tmp/claude-native",
      executable: "claude",
    });
    config.heartbeatJobs = [{
      id: "wrong-native-provider",
      accountId: "codex-primary",
      credentialSurfaceId: "claude-native",
      executor: "native-claude",
      model: "claude-fable-5",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "weekly", offsetMinutes: 2 },
      timeoutSeconds: 120,
      enabled: true,
    }];

    expect(() => parseConfig(config)).toThrow(/not valid for provider codex/);
  });

  it("accepts a Fireworks API account with a stable remote account ID", () => {
    const config = validConfig();
    config.accounts = [{
      id: "fireworks-personal",
      label: "Fireworks personal",
      provider: "fireworks",
      expectedIdentity: { accountId: "account-one", email: "person@example.com" },
      usageSource: {
        adapter: "fireworks-api",
        credentialSurfaceId: "fireworks-personal-api",
      },
    }];
    config.credentialSurfaces = [{
      id: "fireworks-personal-api",
      kind: "fireworks-api",
      credentialFile: "/tmp/fireworks-api-key",
    }];

    expect(parseConfig(config)).toMatchObject({
      accounts: [{ provider: "fireworks" }],
      credentialSurfaces: [{ kind: "fireworks-api" }],
    });
  });

  it("requires a Fireworks account ID and matching API credential surface", () => {
    const config = validConfig();
    config.accounts = [{
      id: "fireworks-personal",
      label: "Fireworks personal",
      provider: "fireworks",
      expectedIdentity: { email: "person@example.com" },
      usageSource: {
        adapter: "fireworks-api",
        credentialSurfaceId: "codex-primary-native",
      },
    }];

    expect(() => parseConfig(config)).toThrow(/requires a fireworks-api|accountId/);
  });

  it("rejects heartbeat jobs for standalone Fireworks accounts", () => {
    const config = validConfig();
    config.accounts = [{
      id: "fireworks-personal",
      label: "Fireworks personal",
      provider: "fireworks",
      expectedIdentity: { accountId: "account-one" },
      usageSource: {
        adapter: "fireworks-api",
        credentialSurfaceId: "fireworks-personal-api",
      },
    }];
    config.credentialSurfaces = [
      {
        id: "fireworks-personal-api",
        kind: "fireworks-api",
        credentialFile: "/tmp/fireworks-api-key",
      },
      {
        id: "pi-primary",
        kind: "pi",
        home: "/tmp/pi-primary",
        executable: "pi",
      },
    ];
    config.heartbeatJobs = [{
      id: "fireworks-pi-heartbeat",
      accountId: "fireworks-personal",
      credentialSurfaceId: "pi-primary",
      executor: "pi",
      provider: "fireworks",
      model: "model-one",
      reasoning: "low",
      prompt: "Reply OK.",
      trigger: { type: "after-reset", windowId: "monthly-budget", offsetMinutes: 2 },
      timeoutSeconds: 30,
      enabled: true,
    }];

    expect(() => parseConfig(config)).toThrow(/do not support heartbeats/);
  });
});

describe("loadConfig", () => {
  it("wraps malformed JSON with the config path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-pulse-config-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(path, "{", "utf8");
      await expect(loadConfig(path)).rejects.toEqual(expect.any(ConfigLoadError));
      await expect(loadConfig(path)).rejects.toThrow(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
