import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner, TerminalProbe, TerminalProbeSpec } from "../terminal/tmux.js";
import {
  ClaudeAdapterError,
  ClaudeUsageAdapter,
  mergeClaudeUsageWindows,
  parseClaudeIdentity,
  parseClaudeUsage,
  parseClaudeUsageCache,
} from "./claude.js";

const fixtureUrl = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

describe("Claude usage parser", () => {
  it("preserves session, weekly, and model-scoped windows", async () => {
    const output = await readFile(fixtureUrl("claude-usage-v1.txt"), "utf8");
    const windows = parseClaudeUsage(output, new Date("2026-08-11T12:00:00Z"));

    expect(windows.map(({ id, usedPercent, remainingPercent }) => ({ id, usedPercent, remainingPercent }))).toEqual([
      { id: "session", usedPercent: 24, remainingPercent: 76 },
      { id: "weekly", usedPercent: 61, remainingPercent: 39 },
      { id: "fable-5-weekly", usedPercent: 7, remainingPercent: 93 },
      { id: "sonnet-weekly", usedPercent: 12, remainingPercent: 88 },
    ]);
    expect(windows.every((window) => window.resetsAt !== null)).toBe(true);
  });

  it("fails explicitly when the provider layout drifts", () => {
    expect(() => parseClaudeUsage("Usage is currently unavailable")).toThrowError(
      expect.objectContaining({ code: "usage_parse_failed" }),
    );
  });

  it("supplements terminal usage with cached reset times and scoped limits", () => {
    const terminal = parseClaudeUsage(`
Current session
6% used
Current week (all models)
10% used
`);
    const cached = parseClaudeUsageCache(JSON.stringify({
      cachedUsageUtilization: {
        utilization: {
          limits: [
            { kind: "session", percent: 6, resets_at: "2026-08-12T06:20:00Z", scope: null },
            { kind: "weekly_all", percent: 10, resets_at: "2026-08-17T09:00:00Z", scope: null },
            {
              kind: "weekly_scoped",
              percent: 19,
              resets_at: "2026-08-17T09:00:00Z",
              scope: { model: { display_name: "Fable" } },
            },
          ],
        },
      },
    }));

    expect(mergeClaudeUsageWindows(terminal, cached)).toEqual([
      {
        id: "session",
        label: "Current session",
        usedPercent: 6,
        remainingPercent: 94,
        resetsAt: "2026-08-12T06:20:00.000Z",
      },
      {
        id: "weekly",
        label: "Current week (all models)",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: "2026-08-17T09:00:00.000Z",
      },
      {
        id: "fable-weekly",
        label: "Current week (Fable)",
        usedPercent: 19,
        remainingPercent: 81,
        resetsAt: "2026-08-17T09:00:00.000Z",
      },
    ]);
  });
});

describe("Claude identity parser", () => {
  it("returns only bounded safe identity fields", async () => {
    const output = await readFile(fixtureUrl("claude-auth-status-v1.json"), "utf8");
    expect(parseClaudeIdentity(output)).toEqual({
      email: "person@example.com",
      organizationId: "org_example",
      organizationName: "Example",
      subscriptionType: "max",
      authMethod: "claude.ai",
    });
  });

  it("reports an unauthenticated home without echoing provider output", () => {
    expect(() => parseClaudeIdentity('{"loggedIn":false,"refreshToken":"do-not-leak"}')).toThrowError(
      new ClaudeAdapterError("auth_required", "Claude is not authenticated in the configured credential home"),
    );
  });
});

describe("Claude adapter", () => {
  it("uses Claude's ambient default home without relocating its global onboarding state", async () => {
    const authJson = await readFile(fixtureUrl("claude-auth-status-v1.json"), "utf8");
    const usage = await readFile(fixtureUrl("claude-usage-v1.txt"), "utf8");
    let authRequest: CommandRequest | undefined;
    let terminalSpec: TerminalProbeSpec | undefined;
    const runner: CommandRunner = {
      run: async (request) => {
        authRequest = request;
        return { exitCode: 0, stdout: authJson, stderr: "" };
      },
    };
    const terminal: TerminalProbe = {
      probe: async (spec) => {
        terminalSpec = spec;
        return { output: usage, durationMs: 10 };
      },
    };

    await new ClaudeUsageAdapter(runner, terminal).poll({
      executable: "claude",
      home: `${process.env.HOME}/.claude`,
      probeDirectory: "/probe",
    });

    expect(authRequest?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(terminalSpec?.env).toEqual({});
  });

  it("uses isolated, no-tool CLI arguments and the configured home", async () => {
    const requests: CommandRequest[] = [];
    const authJson = await readFile(fixtureUrl("claude-auth-status-v1.json"), "utf8");
    const usage = await readFile(fixtureUrl("claude-usage-v1.txt"), "utf8");
    const runner: CommandRunner = {
      run: async (request): Promise<CommandResult> => {
        requests.push(request);
        return { exitCode: 0, stdout: authJson, stderr: "" };
      },
    };
    let receivedSpec: TerminalProbeSpec | undefined;
    const terminal: TerminalProbe = {
      probe: async (spec) => {
        receivedSpec = spec;
        return { output: usage, durationMs: 10 };
      },
    };

    const result = await new ClaudeUsageAdapter(runner, terminal).poll({
      executable: "/opt/bin/claude",
      home: "/credentials/claude-one",
      probeDirectory: "/probe",
    });

    expect(result.windows).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      executable: "/opt/bin/claude",
      args: ["auth", "status", "--json"],
      env: { CLAUDE_CONFIG_DIR: "/credentials/claude-one" },
      clearEnvironment: true,
    });
    expect(receivedSpec).toMatchObject({
      executable: "/opt/bin/claude",
      cwd: "/probe",
      env: { CLAUDE_CONFIG_DIR: "/credentials/claude-one" },
      command: "/usage",
    });
    expect(receivedSpec?.startupActions).toHaveLength(2);
    expect(receivedSpec?.isReady("Claude Code v2.1.228\nWelcome back\n$ ")).toBe(true);
    const themeAction = receivedSpec?.startupActions?.[0];
    expect(themeAction?.matches("Choose the text style that looks best with your terminal\nDark mode\nLight mode")).toBe(true);
    expect(themeAction?.matches("Press Enter to continue")).toBe(false);
    expect(themeAction?.inputs).toEqual([
      { kind: "literal", value: "2" },
      { kind: "key", value: "Enter" },
    ]);
    const trustAction = receivedSpec?.startupActions?.[1];
    expect(trustAction?.matches("Permission Required: Accessing workspace:\nIs this a project you created or one you trust?\ny. Yes, I trust this folder\nEnter y/n:")).toBe(true);
    expect(trustAction?.matches("Do you trust this command?")).toBe(false);
    expect(trustAction?.inputs).toEqual([
      { kind: "literal", value: "y" },
      { kind: "key", value: "Enter" },
    ]);
    expect(receivedSpec?.args).toEqual(
      expect.arrayContaining([
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-chrome",
        "--ax-screen-reader",
      ]),
    );
  });
});
