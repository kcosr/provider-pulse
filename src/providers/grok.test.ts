import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { TerminalProbe, TerminalProbeSpec } from "../terminal/tmux.js";
import { GrokAdapterError, GrokUsageAdapter, parseGrokIdentity, parseGrokUsage } from "./grok.js";

const fixtureUrl = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

describe("Grok usage parser", () => {
  it("parses the native weekly pool and reset", async () => {
    const output = await readFile(fixtureUrl("grok-usage-v1.txt"), "utf8");
    const windows = parseGrokUsage(output, new Date("2026-08-11T12:00:00Z"));

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: "weekly",
      label: "Weekly limit",
      usedPercent: 42,
      remainingPercent: 58,
      durationMinutes: 10_080,
    });
    expect(windows[0]?.resetsAt).not.toBeNull();
  });

  it("parses Grok 1.0.0's current weekly limit and next-reset labels", async () => {
    const output = await readFile(fixtureUrl("grok-usage-v1-current.txt"), "utf8");
    const windows = parseGrokUsage(output, new Date("2026-08-11T12:00:00Z"));

    expect(windows).toEqual([
      {
        id: "weekly",
        label: "Weekly limit",
        usedPercent: 28,
        remainingPercent: 72,
        durationMinutes: 10_080,
        resetsAt: expect.stringMatching(/^2026-08-13T/),
      },
    ]);
  });

  it("fails explicitly on an unknown layout", () => {
    expect(() => parseGrokUsage("Weekly allowance unavailable")).toThrowError(
      expect.objectContaining({ code: "usage_parse_failed" }),
    );
  });
});

describe("Grok identity parser", () => {
  it("discards tokens and returns only safe identity fields", () => {
    const json = JSON.stringify({
      "https://auth.x.ai::example": {
        email: "person@example.com",
        principal_id: "principal_example",
        team_id: "team_example",
        auth_mode: "oauth",
        refresh_token: "do-not-leak",
        key: "also-do-not-leak",
      },
    });
    expect(parseGrokIdentity(json)).toEqual({
      email: "person@example.com",
      accountId: "principal_example",
      organizationId: "team_example",
      authMethod: "oauth",
    });
  });

  it("selects the newest same-email identity using Grok's string create_time", () => {
    const json = JSON.stringify({
      old: {
        email: "person@example.com",
        principal_id: "principal_old",
        team_id: "team_old",
        create_time: "2026-01-02T03:04:05Z",
      },
      current: {
        email: "PERSON@example.com",
        principal_id: "principal_current",
        team_id: "team_current",
        create_time: "2026-08-11T03:04:05Z",
      },
    });

    expect(parseGrokIdentity(json)).toMatchObject({
      email: "PERSON@example.com",
      accountId: "principal_current",
      organizationId: "team_current",
    });
  });

  it("fails closed when one home contains different identities", () => {
    const json = JSON.stringify({ one: { email: "one@example.com" }, two: { email: "two@example.com" } });
    expect(() => parseGrokIdentity(json)).toThrowError(
      new GrokAdapterError("identity_parse_failed", "Grok authentication metadata contains multiple identities"),
    );
  });
});

describe("Grok adapter", () => {
  it("uses the configured home and disables optional agent features", async () => {
    const output = await readFile(fixtureUrl("grok-usage-v1.txt"), "utf8");
    let receivedSpec: TerminalProbeSpec | undefined;
    const terminal: TerminalProbe = {
      probe: async (spec) => {
        receivedSpec = spec;
        return { output, durationMs: 10 };
      },
    };
    let authPath: string | undefined;
    const adapter = new GrokUsageAdapter(terminal, async (path) => {
      authPath = path;
      return JSON.stringify({ account: { email: "person@example.com", auth_mode: "oauth" } });
    });

    const result = await adapter.poll({
      executable: "/opt/bin/grok",
      home: "/credentials/grok-one",
      probeDirectory: "/probe",
    });

    expect(result.windows[0]?.usedPercent).toBe(42);
    expect(authPath).toBe("/credentials/grok-one/auth.json");
    expect(receivedSpec).toMatchObject({
      executable: "/opt/bin/grok",
      cwd: "/probe",
      env: { GROK_HOME: "/credentials/grok-one" },
      command: "/usage",
      args: [
        "--no-alt-screen",
        "--tools",
        "",
        "--disable-web-search",
        "--no-memory",
        "--no-subagents",
        "--no-plan",
      ],
    });
  });
});
