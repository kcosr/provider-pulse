import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderPulseApplication } from "./application.js";
import { buildServer } from "./server.js";
import type { AppConfig } from "./types.js";

const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("HTTP API", () => {
  it("serves side-effect-free status and asynchronous action receipts", async () => {
    const probe = vi.fn(async () => ({
      identity: {},
      snapshot: { observedAt: new Date().toISOString(), windows: [], balances: [] },
      implementation: "fake",
      implementationVersion: "1",
    }));
    const application = new ProviderPulseApplication(await config(), { usageProbe: probe });
    const server = await buildServer(application, {
      publicDirectory: fileURLToPath(new URL("../public/", import.meta.url)),
      host: "127.0.0.1",
      port: 4317,
    });
    servers.push(server);

    const status = await server.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "127.0.0.1:4317" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(probe).not.toHaveBeenCalled();

    const forbidden = await server.inject({
      method: "POST",
      url: "/api/accounts/codex-one/check",
      headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
    });
    expect(forbidden.statusCode).toBe(403);

    const action = await server.inject({
      method: "POST",
      url: "/api/accounts/codex-one/check",
      headers: actionHeaders(),
    });
    expect(action.statusCode).toBe(202);
    expect(action.json()).toMatchObject({ accepted: true, targetId: "codex-one", kind: "usage-check" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    const missing = await server.inject({
      method: "POST",
      url: "/api/accounts/missing/check",
      headers: actionHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "account_not_found" } });

    const page = await server.inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1:4317" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    await application.close();
  });

  it("rejects untrusted hosts and cross-origin action requests without side effects", async () => {
    const probe = vi.fn(async () => ({
      identity: {},
      snapshot: { observedAt: new Date().toISOString(), windows: [], balances: [] },
      implementation: "fake",
      implementationVersion: "1",
    }));
    const application = new ProviderPulseApplication(await config(), { usageProbe: probe });
    const server = await buildServer(application, {
      publicDirectory: fileURLToPath(new URL("../public/", import.meta.url)),
      host: "127.0.0.1",
      port: 4317,
    });
    servers.push(server);

    const reboundRead = await server.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "attacker.example" },
    });
    expect(reboundRead.statusCode).toBe(403);
    expect(reboundRead.json()).toMatchObject({ error: { code: "invalid_host" } });

    const crossOrigin = await server.inject({
      method: "POST",
      url: "/api/accounts/codex-one/check",
      headers: {
        host: "127.0.0.1:4317",
        origin: "https://attacker.example",
        "x-provider-pulse-action": "1",
      },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ error: { code: "invalid_action_origin" } });
    expect(probe).not.toHaveBeenCalled();
    await application.close();
  });
});

function actionHeaders(): Record<string, string> {
  return {
    host: "127.0.0.1:4317",
    origin: "http://127.0.0.1:4317",
    "x-provider-pulse-action": "1",
  };
}

async function config(): Promise<AppConfig> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "provider-pulse-server-"));
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 4317 },
    paths: { stateDirectory, probeDirectory: stateDirectory },
    polling: { automaticIntervalMinutes: null, startupCheck: false, maxConcurrency: 1, staleAfterMinutes: 60 },
    accounts: [{
      id: "codex-one",
      label: "Codex one",
      provider: "codex",
      usageSource: { adapter: "codex-app-server", credentialSurfaceId: "codex-one-native" },
    }],
    credentialSurfaces: [{
      id: "codex-one-native",
      kind: "native-codex",
      home: "/tmp/provider-pulse-codex-one",
      executable: "codex",
    }],
    heartbeatJobs: [],
  };
}
