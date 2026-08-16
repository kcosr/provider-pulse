import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexProbeEnvironment,
  probeCodexUsage,
  type CodexProcessFactory,
} from "./codex.js";

type RpcResponder = (request: Record<string, unknown>) => unknown | Promise<unknown>;

interface FakeProcessResult {
  readonly process: ChildProcessWithoutNullStreams;
  readonly killedWith: string[];
  readonly requests: Record<string, unknown>[];
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
}

function fakeProcess(responder: RpcResponder): FakeProcessResult {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killedWith: string[] = [];
  const requests: Record<string, unknown>[] = [];
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      if (typeof request.id !== "number") continue;
      queueMicrotask(async () => {
        try {
          const response = await responder(request);
          stdout.write(`${JSON.stringify({ id: request.id, result: response })}\n`);
        } catch (error) {
          const code = error instanceof RpcFailure ? error.code : -32_603;
          stdout.write(`${JSON.stringify({
            id: request.id,
            error: { code, message: "redacted fake failure" },
          })}\n`);
        }
      });
    }
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    killedWith.push(String(signal));
    child.exitCode = 0;
    child.emit("exit", 0, signal);
    return true;
  };
  return {
    process: child as unknown as ChildProcessWithoutNullStreams,
    killedWith,
    requests,
    stdout,
    stderr,
  };
}

class RpcFailure extends Error {
  readonly code: number;

  constructor(code: number) {
    super("RPC failure");
    this.code = code;
  }
}

function standardResponse(method: unknown): unknown {
  switch (method) {
    case "initialize":
      return { userAgent: "codex-cli/0.147.0" };
    case "account/read":
      return {
        account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      };
    case "account/rateLimits/read":
      return {
        rateLimits: {
          limitId: "legacy",
          limitName: "Legacy duplicate",
          primary: { usedPercent: 99, windowDurationMins: 1, resetsAt: 1_700_000_000 },
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_800_172_800 },
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 25.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 80, windowDurationMins: 10_080, resetsAt: 1_800_086_400 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            individualLimit: {
              limit: "100.00",
              used: "15.00",
              remainingPercent: 85,
              resetsAt: 1_800_000_000,
            },
            spendControlReached: false,
            planType: "pro",
            rateLimitReachedType: null,
          },
          review: {
            limitId: "review",
            limitName: "Code review",
            primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: null },
            individualLimit: null,
            spendControlReached: null,
            planType: "pro",
            rateLimitReachedType: "primary",
          },
        },
        rateLimitResetCredits: { availableCount: 2, credits: [] },
      };
    case "account/usage/read":
      return {
        summary: {
          lifetimeTokens: 1234,
          peakDailyTokens: 500,
          longestRunningTurnSec: 42,
          currentStreakDays: 3,
          longestStreakDays: 7,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-10", tokens: 100 }],
      };
    default:
      throw new RpcFailure(-32_601);
  }
}

describe("probeCodexUsage", () => {
  it("builds an allowlisted environment without ambient provider credentials", () => {
    const environment = buildCodexProbeEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      OPENAI_API_KEY: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
      XAI_API_KEY: "must-not-leak",
      AWS_ACCESS_KEY_ID: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
      CODEX_HOME: "/ambient/wrong-home",
    }, "/configured/codex-home");

    expect(environment).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CODEX_HOME: "/configured/codex-home",
      NO_COLOR: "1",
    });
  });

  it("uses a bounded shell-free app-server and normalizes all rate-limit buckets", async () => {
    const fake = fakeProcess((request) => standardResponse(request.method));
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: SpawnOptionsWithoutStdio;
    }> = [];
    const factory: CodexProcessFactory = (executable, args, options) => {
      calls.push({ executable, args, options });
      return fake.process;
    };

    const resultPromise = probeCodexUsage({
      executable: "/opt/bin/codex",
      home: "/private/codex-home",
      now: () => new Date("2026-08-11T12:00:00Z"),
      processFactory: factory,
    });
    fake.stdout.write(`${JSON.stringify({ method: "account/updated", params: {} })}\n`);
    fake.stdout.write(`${JSON.stringify({ id: "unrelated", result: {} })}\n`);
    const result = await resultPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: "/opt/bin/codex",
      args: ["app-server", "--stdio"],
      options: {
        cwd: "/private/codex-home",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    expect(calls[0]?.options.env).toMatchObject({ CODEX_HOME: "/private/codex-home" });
    expect(fake.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
      "account/usage/read",
    ]);
    expect(fake.requests[0]).toMatchObject({
      params: { capabilities: { experimentalApi: true, requestAttestation: false } },
    });
    expect(fake.requests[2]).toMatchObject({
      method: "account/read",
      params: { refreshToken: true },
    });
    expect(result).toMatchObject({
      adapter: "codex-app-server",
      adapterVersion: 2,
      observedAt: "2026-08-11T12:00:00.000Z",
      identity: { authType: "chatgpt", email: "user@example.com", plan: "pro" },
      resetCreditsAvailable: 2,
      activity: {
        lifetimeTokens: 1234,
        longestRunningTurnSeconds: 42,
        dailyUsage: [{ startDate: "2026-08-10", tokens: 100 }],
      },
    });
    expect(result.windows).toEqual([
      {
        id: "codex:primary",
        label: "Codex Primary",
        usedPercent: 25.5,
        remainingPercent: 74.5,
        durationMinutes: 300,
        resetsAt: "2027-01-15T08:00:00.000Z",
        reached: false,
      },
      {
        id: "codex:secondary",
        label: "Codex Secondary",
        usedPercent: 80,
        remainingPercent: 20,
        durationMinutes: 10_080,
        resetsAt: "2027-01-16T08:00:00.000Z",
        reached: false,
      },
      {
        id: "review:primary",
        label: "Code review Primary",
        usedPercent: 100,
        remainingPercent: 0,
        reached: true,
      },
      {
        id: "codex_bengalfox:primary",
        label: "GPT-5.3-Codex-Spark Primary",
        usedPercent: 0,
        remainingPercent: 100,
        durationMinutes: 10_080,
        resetsAt: "2027-01-17T08:00:00.000Z",
        reached: false,
      },
    ]);
    expect(result.balances).toEqual([
      {
        id: "codex:credits",
        label: "Codex credits",
        amount: "12.50",
        unlimited: false,
      },
      {
        id: "codex:spend",
        label: "Codex spend control",
        limit: "100.00",
        used: "15.00",
        remainingPercent: 85,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
    ]);
    expect(fake.killedWith).toEqual(["SIGTERM"]);
  });

  it("keeps limits when optional account usage is unsupported", async () => {
    const fake = fakeProcess((request) => {
      if (request.method === "account/usage/read") throw new RpcFailure(-32_601);
      return standardResponse(request.method);
    });
    const result = await probeCodexUsage({
      executable: "codex",
      home: "/codex",
      processFactory: () => fake.process,
    });
    expect(result.activity).toBeUndefined();
    expect(result.windows).toHaveLength(4);
    expect(fake.killedWith).toEqual(["SIGTERM"]);
  });

  it("fails closed when account authentication is absent", async () => {
    const fake = fakeProcess((request) => request.method === "account/read"
      ? { account: null, requiresOpenaiAuth: true }
      : standardResponse(request.method));
    await expect(probeCodexUsage({
      executable: "codex",
      home: "/codex",
      processFactory: () => fake.process,
    })).rejects.toMatchObject({ code: "auth_required" });
    expect(fake.killedWith).toEqual(["SIGTERM"]);
  });

  it("reports response shape drift as a parse failure", async () => {
    const fake = fakeProcess((request) => request.method === "account/rateLimits/read"
      ? { rateLimits: { primary: { usedPercent: "25%" } } }
      : standardResponse(request.method));
    await expect(probeCodexUsage({
      executable: "codex",
      home: "/codex",
      processFactory: () => fake.process,
    })).rejects.toMatchObject({ code: "usage_parse_failed" });
    expect(fake.killedWith).toEqual(["SIGTERM"]);
  });

  it("times out and cleans up a non-responsive app-server", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeProcess(() => new Promise(() => undefined));
      const result = probeCodexUsage({
        executable: "codex",
        home: "/codex",
        timeoutMs: 25,
        processFactory: () => fake.process,
      });
      const assertion = expect(result).rejects.toMatchObject({ code: "usage_probe_timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(fake.killedWith).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds combined stdout and stderr without returning their contents", async () => {
    const fake = fakeProcess(() => new Promise(() => undefined));
    const result = probeCodexUsage({
      executable: "codex",
      home: "/codex",
      maxOutputBytes: 16,
      processFactory: () => fake.process,
    });
    fake.stderr.write("secret-bearing-output-that-must-not-escape");
    await expect(result).rejects.toMatchObject({
      code: "usage_probe_output_limit",
      message: "Codex app-server exceeded the probe output limit.",
    });
    expect(fake.killedWith).toEqual(["SIGTERM"]);
  });
});
