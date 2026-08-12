import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner, TerminalProbeSpec } from "./tmux.js";
import { isolatedProcessEnvironment, TerminalProbeError, TmuxTerminalProbe } from "./tmux.js";

class FakeRunner implements CommandRunner {
  public readonly requests: CommandRequest[] = [];
  public captures: string[] = [];

  public async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const command = request.args[4];
    if (command === "capture-pane") {
      return { exitCode: 0, stdout: this.captures.shift() ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function spec(overrides: Partial<TerminalProbeSpec> = {}): TerminalProbeSpec {
  return {
    sessionPrefix: "provider-pulse-test",
    executable: "/opt/provider cli",
    args: ["--safe", "two words"],
    cwd: "/probe directory",
    env: { GROK_HOME: "/credential home" },
    command: "/usage",
    isReady: (pane) => pane.includes("READY"),
    isComplete: (pane) => pane.includes("DONE"),
    startupTimeoutMs: 1_000,
    responseTimeoutMs: 1_000,
    totalTimeoutMs: 3_000,
    pollIntervalMs: 10,
    stablePollCount: 2,
    maxOutputBytes: 1_024,
    ...overrides,
  };
}

describe("tmux terminal probe", () => {
  it("uses argument arrays, sends literal command and Enter separately, and cleans up", async () => {
    const runner = new FakeRunner();
    runner.captures = ["READY\n>", "DONE\nweekly 2% used", "DONE\nweekly 2% used"];
    let clock = 0;
    const probe = new TmuxTerminalProbe(runner, {
      ownerToken: "owner_token_1234",
      createId: () => "12345678-abcd-4321-abcd-123456789012",
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    const result = await probe.probe(spec());

    expect(result.output).toContain("weekly 2% used");
    const start = runner.requests[0];
    expect(start?.executable).toBe("tmux");
    expect(start?.args).toEqual([
      "-L",
      "provider-pulse-default-instance",
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "provider-pulse-test-owner_to-12345678abcd4321",
      "-x",
      "100",
      "-y",
      "40",
      "-c",
      "/probe directory",
      "-e",
      "PROVIDER_PULSE_PROBE_OWNER=owner_token_1234",
      "-e",
      "GROK_HOME=/credential home",
      "--",
      "/opt/provider cli",
      "--safe",
      "two words",
    ]);
    expect(start?.clearEnvironment).toBe(true);
    expect(start?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(start?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(start?.env).not.toHaveProperty("XAI_API_KEY");
    const sendRequests = runner.requests.filter((request) => request.args[4] === "send-keys");
    expect(sendRequests.map((request) => request.args.slice(-2))).toEqual([["-l", "/usage"], [expect.any(String), "Enter"]]);
    expect(runner.requests.at(-1)?.args.slice(4, 6)).toEqual(["kill-session", "-t"]);
  });

  it("kills the exact session after timeout", async () => {
    const runner = new FakeRunner();
    runner.captures = ["not ready", "not ready", "not ready"];
    let clock = 0;
    const probe = new TmuxTerminalProbe(runner, {
      ownerToken: "owner_token_1234",
      createId: () => "12345678-abcd-4321-abcd-123456789012",
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(probe.probe(spec({ startupTimeoutMs: 15 }))).rejects.toEqual(
      new TerminalProbeError("terminal_probe_timeout", "provider terminal probe timed out"),
    );
    const startName = runner.requests[0]?.args[7];
    const kill = runner.requests.at(-1);
    expect(kill?.args.slice(4)).toEqual(["kill-session", "-t", startName]);
  });

  it("runs an exact known startup action once before waiting for readiness", async () => {
    const runner = new FakeRunner();
    const onboarding = "Choose the text style that looks best with your terminal\n1. Dark mode\n2. Light mode";
    runner.captures = [onboarding, onboarding, "READY\n>", "DONE", "DONE"];
    let clock = 0;
    const probe = new TmuxTerminalProbe(runner, {
      ownerToken: "owner_token_1234",
      createId: () => "12345678-abcd-4321-abcd-123456789012",
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await probe.probe(spec({
      startupActions: [{
        id: "accept-default-theme",
        matches: (pane) => pane.includes("Choose the text style") && pane.includes("Dark mode") && pane.includes("Light mode"),
        inputs: [{ kind: "key", value: "Enter" }],
      }],
    }));

    const enterRequests = runner.requests.filter(
      (request) => request.args[4] === "send-keys" && request.args.at(-1) === "Enter",
    );
    // One theme acceptance plus the later /usage submission; the repeated
    // onboarding pane cannot trigger a second acceptance.
    expect(enterRequests).toHaveLength(2);
  });

  it("does not clean up similarly named sessions without the owner marker", async () => {
    const runner: CommandRunner & { requests: CommandRequest[] } = {
      requests: [],
      async run(request) {
        this.requests.push(request);
        if (request.args[4] === "list-sessions") {
          return { exitCode: 0, stdout: "provider-pulse-test-foreign-session\nother-session\n", stderr: "" };
        }
        if (request.args[4] === "show-environment") {
          return { exitCode: 0, stdout: "PROVIDER_PULSE_PROBE_OWNER=someone_else", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const probe = new TmuxTerminalProbe(runner, { ownerToken: "owner_token_1234" });

    expect(await probe.cleanupOwnedSessions("provider-pulse-test")).toBe(0);
    expect(runner.requests.some((request) => request.args[4] === "kill-session")).toBe(false);
  });

  it("shuts down only its private tmux server", async () => {
    const runner = new FakeRunner();
    const probe = new TmuxTerminalProbe(runner, {
      ownerToken: "owner_token_1234",
      serverName: "provider-pulse-stable_instance",
    });

    await probe.shutdown();

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.args).toEqual([
      "-L",
      "provider-pulse-stable_instance",
      "-f",
      "/dev/null",
      "kill-server",
    ]);
  });

  it("rejects provider secrets in an isolated process environment", () => {
    expect(() => isolatedProcessEnvironment({ ANTHROPIC_API_KEY: "do-not-inherit" })).toThrowError(
      expect.objectContaining({ code: "terminal_probe_invalid" }),
    );
  });
});
