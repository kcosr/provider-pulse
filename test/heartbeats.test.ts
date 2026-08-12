import { describe, expect, it, vi } from "vitest";

import {
  HeartbeatExecutionError,
  buildHeartbeatCommand,
  executeHeartbeat,
  runBoundedProcess,
  type HeartbeatCredentialSurface,
  type HeartbeatJobDefinition,
} from "../src/heartbeats.js";

const BASE_ENV = {
  HOME: "/home/example",
  PATH: "/usr/bin",
  LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "must-not-leak",
  OPENAI_API_KEY: "must-not-leak",
  XAI_API_KEY: "must-not-leak",
};

function surface(
  kind: HeartbeatCredentialSurface["kind"],
): HeartbeatCredentialSurface {
  return {
    id: `${kind}-surface`,
    kind,
    home: `/credentials/${kind}`,
    executable: `/bin/${kind}`,
  };
}

function job(
  executor: HeartbeatJobDefinition["executor"],
  overrides: Partial<HeartbeatJobDefinition> = {},
): HeartbeatJobDefinition {
  return {
    id: `${executor}-heartbeat`,
    accountId: `${executor}-account`,
    credentialSurfaceId: `${executor}-surface`,
    executor,
    model: "exact-model",
    reasoning: "low",
    prompt: "Reply with exactly OK.",
    trigger: {
      type: "after-reset",
      windowId: "weekly",
      offsetMinutes: 2,
    },
    timeoutSeconds: 120,
    enabled: true,
    ...overrides,
  } as HeartbeatJobDefinition;
}

describe("buildHeartbeatCommand", () => {
  it("builds an ephemeral, read-only native Codex heartbeat", () => {
    const command = buildHeartbeatCommand(
      job("native-codex"),
      surface("native-codex"),
      { baseEnvironment: BASE_ENV },
    );

    expect(command).toMatchObject({
      executable: "/bin/native-codex",
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });
    expect(command.args).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--model",
      "exact-model",
      "--config",
      'model_reasoning_effort="low"',
      "--config",
      'web_search="disabled"',
      "Reply with exactly OK.",
    ]);
    expect(command.env).toEqual({
      CODEX_HOME: "/credentials/native-codex",
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin",
    });
  });

  it("builds a no-tools, non-persistent native Claude heartbeat", () => {
    const command = buildHeartbeatCommand(
      job("native-claude", { reasoning: "high" }),
      surface("native-claude"),
      { baseEnvironment: BASE_ENV },
    );

    expect(command.args).toEqual([
      "--print",
      "--model",
      "exact-model",
      "--effort",
      "high",
      "--safe-mode",
      "--tools",
      "",
      "--no-chrome",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "Reply with exactly OK.",
    ]);
    expect(command.env.CLAUDE_CONFIG_DIR).toBe(
      "/credentials/native-claude",
    );
  });

  it("builds a constrained native Grok heartbeat", () => {
    const command = buildHeartbeatCommand(
      job("native-grok"),
      surface("native-grok"),
      { baseEnvironment: BASE_ENV },
    );

    expect(command.args).toEqual([
      "--model",
      "exact-model",
      "--reasoning-effort",
      "low",
      "--disable-web-search",
      "--no-memory",
      "--no-plan",
      "--no-subagents",
      "--tools",
      "",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "--verbatim",
      "--single",
      "Reply with exactly OK.",
    ]);
    expect(command.env.GROK_HOME).toBe("/credentials/native-grok");
  });

  it("keeps the Pi executor generic and pins provider, model, and thinking", () => {
    const command = buildHeartbeatCommand(
      job("pi", { provider: "any-pi-provider", reasoning: "xhigh" }),
      surface("pi"),
      { baseEnvironment: BASE_ENV },
    );

    expect(command.args).toEqual([
      "--print",
      "--provider",
      "any-pi-provider",
      "--model",
      "exact-model",
      "--thinking",
      "xhigh",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--system-prompt",
      "Answer only the supplied heartbeat prompt. Do not use tools.",
      "--mode",
      "json",
      "Reply with exactly OK.",
    ]);
    expect(command.env.PI_CODING_AGENT_DIR).toBe("/credentials/pi");
  });

  it("rejects a mismatched credential surface", () => {
    expect(() =>
      buildHeartbeatCommand(job("native-codex"), surface("native-claude")),
    ).toThrowError(
      expect.objectContaining<Partial<HeartbeatExecutionError>>({
        code: "heartbeat_config_invalid",
      }),
    );
  });

  it("requires a provider only for Pi", () => {
    expect(() => buildHeartbeatCommand(job("pi"), surface("pi"))).toThrow(
      "Pi heartbeat jobs require a provider",
    );
    expect(() =>
      buildHeartbeatCommand(
        job("native-grok", { provider: "xai" }),
        surface("native-grok"),
      ),
    ).toThrow("Provider is valid only for Pi heartbeat jobs");
  });
});

describe("executeHeartbeat", () => {
  it("uses the injected runner and returns safe execution metadata", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '{"result":"OK"}',
      stderr: "",
      durationMs: 12,
    });

    await expect(
      executeHeartbeat(job("native-grok"), surface("native-grok"), {
        runner,
        baseEnvironment: BASE_ENV,
      }),
    ).resolves.toMatchObject({
      jobId: "native-grok-heartbeat",
      executor: "native-grok",
      model: "exact-model",
      reasoning: "low",
      exitCode: 0,
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("normalizes nonzero exits without exposing process output", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 7,
      stdout: "sensitive provider output",
      stderr: "sensitive provider error",
      durationMs: 12,
    });

    await expect(
      executeHeartbeat(job("native-codex"), surface("native-codex"), {
        runner,
      }),
    ).rejects.toMatchObject({
      code: "heartbeat_request_failed",
      message: "Heartbeat process exited with code 7",
    });
  });
});

describe("runBoundedProcess", () => {
  it("captures stdout and stderr from an argv-only child", async () => {
    await expect(
      runBoundedProcess({
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("ok"); process.stderr.write("note")',
        ],
        env: {},
        timeoutMs: 2_000,
        maxOutputBytes: 100,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok", stderr: "note" });
  });

  it("terminates a timed-out child", async () => {
    await expect(
      runBoundedProcess({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: {},
        timeoutMs: 20,
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "heartbeat_timeout" });
  });

  it("terminates a child that exceeds the combined output cap", async () => {
    await expect(
      runBoundedProcess({
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("0123456789")'],
        env: {},
        timeoutMs: 2_000,
        maxOutputBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "heartbeat_output_limit" });
  });
});
