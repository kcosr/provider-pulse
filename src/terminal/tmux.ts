import { randomUUID } from "node:crypto";

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The runner must not merge process.env when this is true. */
  readonly clearEnvironment?: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface TerminalProbeSpec {
  readonly sessionPrefix: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly command: string;
  readonly isReady: (pane: string) => boolean;
  readonly isComplete: (pane: string) => boolean;
  readonly startupActions?: readonly TerminalProbeStartupAction[];
  readonly startupTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly stablePollCount?: number;
  readonly maxOutputBytes: number;
}

export interface TerminalProbeInput {
  readonly kind: "literal" | "key";
  readonly value: string;
}

export interface TerminalProbeStartupAction {
  readonly id: string;
  readonly matches: (pane: string) => boolean;
  readonly inputs: readonly TerminalProbeInput[];
}

export interface TerminalProbeResult {
  readonly output: string;
  readonly durationMs: number;
}

export interface TerminalProbe {
  probe(spec: TerminalProbeSpec): Promise<TerminalProbeResult>;
}

export type TerminalProbeErrorCode =
  | "terminal_probe_invalid"
  | "terminal_probe_start_failed"
  | "terminal_probe_timeout"
  | "terminal_probe_output_too_large"
  | "terminal_probe_capture_failed";

export class TerminalProbeError extends Error {
  public readonly code: TerminalProbeErrorCode;

  public constructor(
    code: TerminalProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalProbeError";
    this.code = code;
  }
}

export interface TmuxTerminalProbeOptions {
  readonly tmuxExecutable?: string;
  readonly ownerToken?: string;
  readonly serverName?: string;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly createId?: () => string;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STABLE_POLL_COUNT = 2;
const TMUX_COMMAND_TIMEOUT_MS = 5_000;
const TMUX_COMMAND_OUTPUT_LIMIT = 32 * 1024;
const SESSION_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OWNER_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const SERVER_NAME_PATTERN = /^provider-pulse-[a-zA-Z0-9_-]{8,48}$/;
const CREDENTIAL_HOME_VARIABLES = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "PI_CODING_AGENT_DIR",
]);

export class TmuxTerminalProbe implements TerminalProbe {
  readonly #runner: CommandRunner;
  readonly #tmuxExecutable: string;
  readonly #ownerToken: string;
  readonly #serverName: string;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #createId: () => string;

  public constructor(
    runner: CommandRunner,
    options: TmuxTerminalProbeOptions = {},
  ) {
    this.#runner = runner;
    this.#tmuxExecutable = options.tmuxExecutable ?? "tmux";
    this.#ownerToken = options.ownerToken ?? randomUUID().replaceAll("-", "");
    this.#serverName = options.serverName ?? "provider-pulse-default-instance";
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#createId = options.createId ?? randomUUID;

    if (!OWNER_TOKEN_PATTERN.test(this.#ownerToken)) {
      throw new TerminalProbeError("terminal_probe_invalid", "tmux probe owner token is invalid");
    }
    if (!SERVER_NAME_PATTERN.test(this.#serverName)) {
      throw new TerminalProbeError("terminal_probe_invalid", "tmux private server name is invalid");
    }
  }

  public async probe(spec: TerminalProbeSpec): Promise<TerminalProbeResult> {
    validateSpec(spec);
    const startedAt = this.#now();
    const totalDeadline = startedAt + spec.totalTimeoutMs;
    const sessionName = this.#sessionName(spec.sessionPrefix);
    let sessionStarted = false;

    try {
      const startResult = await this.#tmux([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-x",
        "100",
        "-y",
        "40",
        "-c",
        spec.cwd,
        "-e",
        `PROVIDER_PULSE_PROBE_OWNER=${this.#ownerToken}`,
        ...environmentArguments(spec.env),
        "--",
        spec.executable,
        ...spec.args,
      ]);
      if (startResult.exitCode !== 0) {
        throw new TerminalProbeError(
          "terminal_probe_start_failed",
          `tmux could not start the provider CLI (exit ${startResult.exitCode})`,
        );
      }
      sessionStarted = true;

      const startupDeadline = Math.min(totalDeadline, startedAt + spec.startupTimeoutMs);
      await this.#waitForPane(
        sessionName,
        startupDeadline,
        totalDeadline,
        spec,
        spec.isReady,
        false,
        new Set<string>(),
      );

      await this.#requireTmuxSuccess(["send-keys", "-t", sessionName, "-l", spec.command]);
      await this.#requireTmuxSuccess(["send-keys", "-t", sessionName, "Enter"]);

      const responseDeadline = Math.min(totalDeadline, this.#now() + spec.responseTimeoutMs);
      const output = await this.#waitForPane(
        sessionName,
        responseDeadline,
        totalDeadline,
        spec,
        spec.isComplete,
        true,
      );
      return { output, durationMs: Math.max(0, this.#now() - startedAt) };
    } finally {
      if (sessionStarted) {
        await this.#tmux(["kill-session", "-t", sessionName]).catch(() => undefined);
      }
    }
  }

  /**
   * Removes only sessions carrying this instance's unguessable owner marker.
   * This is useful during graceful shutdown; a new process cannot claim an old
   * process's sessions merely because their names have a familiar prefix.
   */
  public async cleanupOwnedSessions(sessionPrefix: string): Promise<number> {
    validatePrefix(sessionPrefix);
    const listed = await this.#tmux(["list-sessions", "-F", "#{session_name}"]);
    if (listed.exitCode !== 0) return 0;

    let killed = 0;
    for (const sessionName of listed.stdout.split("\n")) {
      if (!sessionName.startsWith(`${sessionPrefix}-`)) continue;
      const owner = await this.#tmux([
        "show-environment",
        "-t",
        sessionName,
        "PROVIDER_PULSE_PROBE_OWNER",
      ]);
      if (owner.exitCode !== 0 || owner.stdout.trim() !== `PROVIDER_PULSE_PROBE_OWNER=${this.#ownerToken}`) {
        continue;
      }
      const result = await this.#tmux(["kill-session", "-t", sessionName]);
      if (result.exitCode === 0) killed += 1;
    }
    return killed;
  }

  /** Stops this instance's private tmux server and all of its probe sessions. */
  public async shutdown(): Promise<void> {
    await this.#tmux(["kill-server"]).catch(() => undefined);
  }

  async #waitForPane(
    sessionName: string,
    phaseDeadline: number,
    totalDeadline: number,
    spec: TerminalProbeSpec,
    predicate: (pane: string) => boolean,
    requireStable: boolean,
    handledStartupActions?: Set<string>,
  ): Promise<string> {
    const stablePollCount = spec.stablePollCount ?? DEFAULT_STABLE_POLL_COUNT;
    const pollIntervalMs = spec.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let previous = "";
    let stable = 0;

    while (this.#now() <= phaseDeadline && this.#now() <= totalDeadline) {
      let captured: CommandResult;
      try {
        captured = await this.#tmux(
          ["capture-pane", "-p", "-t", sessionName, "-S", "-"],
          spec.maxOutputBytes,
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "process_output_limit"
        ) {
          throw new TerminalProbeError(
            "terminal_probe_output_too_large",
            "provider terminal output exceeded its limit",
          );
        }
        throw error;
      }
      if (captured.exitCode !== 0) {
        throw new TerminalProbeError(
          "terminal_probe_capture_failed",
          `tmux could not capture the provider screen (exit ${captured.exitCode})`,
        );
      }
      ensureBounded(captured.stdout, spec.maxOutputBytes);

      if (handledStartupActions !== undefined) {
        const action = spec.startupActions?.find(
          (candidate) => !handledStartupActions.has(candidate.id) && candidate.matches(captured.stdout),
        );
        if (action !== undefined) {
          handledStartupActions.add(action.id);
          await this.#sendInputs(sessionName, action.inputs);
          previous = captured.stdout;
          stable = 0;
          await this.#delay(pollIntervalMs);
          continue;
        }
      }

      if (predicate(captured.stdout)) {
        stable = captured.stdout === previous ? stable + 1 : 1;
        if (!requireStable || stable >= stablePollCount) return captured.stdout;
      } else {
        stable = 0;
      }
      previous = captured.stdout;
      await this.#delay(pollIntervalMs);
    }

    throw new TerminalProbeError("terminal_probe_timeout", "provider terminal probe timed out");
  }

  async #requireTmuxSuccess(args: readonly string[]): Promise<void> {
    const result = await this.#tmux(args);
    if (result.exitCode !== 0) {
      throw new TerminalProbeError(
        "terminal_probe_capture_failed",
        `tmux provider interaction failed (exit ${result.exitCode})`,
      );
    }
  }

  async #sendInputs(sessionName: string, inputs: readonly TerminalProbeInput[]): Promise<void> {
    for (const input of inputs) {
      if (input.value.length === 0 || input.value.includes("\n")) {
        throw new TerminalProbeError("terminal_probe_invalid", "tmux startup input is invalid");
      }
      await this.#requireTmuxSuccess(
        input.kind === "literal"
          ? ["send-keys", "-t", sessionName, "-l", input.value]
          : ["send-keys", "-t", sessionName, input.value],
      );
    }
  }

  #tmux(
    args: readonly string[],
    maxOutputBytes = TMUX_COMMAND_OUTPUT_LIMIT,
  ): Promise<CommandResult> {
    return this.#runner.run({
      executable: this.#tmuxExecutable,
      args: ["-L", this.#serverName, "-f", "/dev/null", ...args],
      env: isolatedProcessEnvironment(),
      clearEnvironment: true,
      timeoutMs: TMUX_COMMAND_TIMEOUT_MS,
      maxOutputBytes,
    });
  }

  #sessionName(prefix: string): string {
    const id = this.#createId().replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 16);
    if (id.length < 8) {
      throw new TerminalProbeError("terminal_probe_invalid", "tmux probe ID is invalid");
    }
    return `${prefix}-${this.#ownerToken.slice(0, 8)}-${id}`;
  }
}

/**
 * Small execution environment for CLIs that own credential homes. Deliberately
 * excludes ambient provider variables such as API keys and auth tokens.
 */
export function isolatedProcessEnvironment(
  additions: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const allowedNames = [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TZ",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
  ] as const;
  const environment: Record<string, string> = {};
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (!CREDENTIAL_HOME_VARIABLES.has(name)) {
      throw new TerminalProbeError(
        "terminal_probe_invalid",
        "isolated process environment accepts only configured credential homes",
      );
    }
    environment[name] = value;
  }
  return environment;
}

function environmentArguments(environment: Readonly<Record<string, string>>): string[] {
  const args: string[] = [];
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!CREDENTIAL_HOME_VARIABLES.has(name) || value.includes("\0") || value.includes("\n")) {
      throw new TerminalProbeError("terminal_probe_invalid", "provider environment contains an invalid entry");
    }
    args.push("-e", `${name}=${value}`);
  }
  return args;
}

function ensureBounded(output: string, limit: number): void {
  if (Buffer.byteLength(output, "utf8") > limit) {
    throw new TerminalProbeError("terminal_probe_output_too_large", "provider terminal output exceeded its limit");
  }
}

function validateSpec(spec: TerminalProbeSpec): void {
  validatePrefix(spec.sessionPrefix);
  if (
    spec.executable.length === 0 ||
    spec.cwd.length === 0 ||
    spec.command.length === 0 ||
    spec.command.includes("\n") ||
    spec.startupTimeoutMs <= 0 ||
    spec.responseTimeoutMs <= 0 ||
    spec.totalTimeoutMs <= 0 ||
    spec.maxOutputBytes <= 0 ||
    (spec.pollIntervalMs !== undefined && spec.pollIntervalMs <= 0) ||
    (spec.stablePollCount !== undefined && spec.stablePollCount <= 0)
  ) {
    throw new TerminalProbeError("terminal_probe_invalid", "provider terminal probe configuration is invalid");
  }
  const actionIds = new Set<string>();
  for (const action of spec.startupActions ?? []) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(action.id) ||
      actionIds.has(action.id) ||
      action.inputs.length === 0
    ) {
      throw new TerminalProbeError("terminal_probe_invalid", "tmux startup action is invalid");
    }
    actionIds.add(action.id);
  }
}

function validatePrefix(prefix: string): void {
  if (!SESSION_PREFIX_PATTERN.test(prefix)) {
    throw new TerminalProbeError("terminal_probe_invalid", "tmux session prefix is invalid");
  }
}
