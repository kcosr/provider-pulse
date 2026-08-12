import { ProcessRunError, runProcess } from "./process-runner.js";
import type {
  CliCredentialSurfaceConfig,
  HeartbeatExecutor,
  HeartbeatJobConfig,
} from "./types.js";

export type HeartbeatCredentialSurface = CliCredentialSurfaceConfig;
export type HeartbeatJobDefinition = HeartbeatJobConfig;

export interface HeartbeatCommand {
  executable: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface BoundedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HeartbeatResult extends BoundedProcessResult {
  jobId: string;
  executor: HeartbeatExecutor;
  model: string;
  reasoning: string;
}

export type HeartbeatProcessRunner = (
  command: HeartbeatCommand,
) => Promise<BoundedProcessResult>;

export type HeartbeatErrorCode =
  | "heartbeat_config_invalid"
  | "heartbeat_output_limit"
  | "heartbeat_request_failed"
  | "heartbeat_timeout";

export class HeartbeatExecutionError extends Error {
  readonly code: HeartbeatErrorCode;

  constructor(code: HeartbeatErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeartbeatExecutionError";
    this.code = code;
  }
}

export interface BuildHeartbeatCommandOptions {
  baseEnvironment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface ExecuteHeartbeatOptions extends BuildHeartbeatCommandOptions {
  runner?: HeartbeatProcessRunner;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_TIMEOUT_SECONDS = 1;

/**
 * Builds the complete, auditable command for one heartbeat. Browser input must
 * never be used to construct either object: both are resolved from validated
 * operator configuration before this function is called.
 */
export function buildHeartbeatCommand(
  job: HeartbeatJobDefinition,
  surface: HeartbeatCredentialSurface,
  options: BuildHeartbeatCommandOptions = {},
): HeartbeatCommand {
  validateJobAndSurface(job, surface);

  const args = buildArguments(job);
  const env = buildHeartbeatEnvironment(
    surface,
    options.baseEnvironment ?? process.env,
  );

  return {
    executable: surface.executable,
    args,
    env,
    timeoutMs: job.timeoutSeconds * 1_000,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

export async function executeHeartbeat(
  job: HeartbeatJobDefinition,
  surface: HeartbeatCredentialSurface,
  options: ExecuteHeartbeatOptions = {},
): Promise<HeartbeatResult> {
  const command = buildHeartbeatCommand(job, surface, options);
  const result = await (options.runner ?? runBoundedProcess)(command);

  if (result.exitCode !== 0) {
    throw new HeartbeatExecutionError(
      "heartbeat_request_failed",
      `Heartbeat process exited with code ${result.exitCode}`,
    );
  }

  return {
    ...result,
    jobId: job.id,
    executor: job.executor,
    model: job.model,
    reasoning: job.reasoning,
  };
}

/**
 * Runs one argv-only process with a combined stdout/stderr byte cap. Raw output
 * is returned only to the caller; this module never logs it because provider
 * output can contain account or credential-adjacent data.
 */
export function runBoundedProcess(
  command: HeartbeatCommand,
): Promise<BoundedProcessResult> {
  return runProcess({
    executable: command.executable,
    args: command.args,
    env: { ...command.env },
    timeoutMs: command.timeoutMs,
    outputLimitBytes: command.maxOutputBytes,
  })
    .then((result) => ({
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    }))
    .catch((error: unknown) => {
      if (error instanceof ProcessRunError) {
        const code =
          error.code === "process_timeout"
            ? "heartbeat_timeout"
            : error.code === "process_output_limit"
              ? "heartbeat_output_limit"
              : "heartbeat_request_failed";
        throw new HeartbeatExecutionError(code, error.message, { cause: error });
      }
      throw new HeartbeatExecutionError(
        "heartbeat_request_failed",
        "Unable to run heartbeat process",
        { cause: error },
      );
    });
}

export function buildHeartbeatEnvironment(
  surface: HeartbeatCredentialSurface,
  baseEnvironment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  const safeKeys = [
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SSH_AUTH_SOCK",
    "TMPDIR",
    "TZ",
    "USER",
    "XDG_RUNTIME_DIR",
  ] as const;

  for (const key of safeKeys) {
    const value = baseEnvironment[key];
    if (value !== undefined) env[key] = value;
  }

  env.NO_COLOR = "1";
  switch (surface.kind) {
    case "native-codex":
      env.CODEX_HOME = surface.home;
      break;
    case "native-claude":
      env.CLAUDE_CONFIG_DIR = surface.home;
      break;
    case "native-grok":
      env.GROK_HOME = surface.home;
      break;
    case "pi":
      env.PI_CODING_AGENT_DIR = surface.home;
      break;
  }

  return env;
}

function buildArguments(job: HeartbeatJobDefinition): readonly string[] {
  switch (job.executor) {
    case "native-codex":
      return [
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
        job.model,
        "--config",
        `model_reasoning_effort=${tomlString(job.reasoning)}`,
        "--config",
        'web_search="disabled"',
        job.prompt,
      ];
    case "native-claude":
      return [
        "--print",
        "--model",
        job.model,
        "--effort",
        job.reasoning,
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
        job.prompt,
      ];
    case "native-grok":
      return [
        "--model",
        job.model,
        "--reasoning-effort",
        job.reasoning,
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
        job.prompt,
      ];
    case "pi":
      return [
        "--print",
        "--provider",
        requirePiProvider(job),
        "--model",
        job.model,
        "--thinking",
        job.reasoning,
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
        job.prompt,
      ];
  }
}

function validateJobAndSurface(
  job: HeartbeatJobDefinition,
  surface: HeartbeatCredentialSurface,
): void {
  if (job.credentialSurfaceId !== surface.id) {
    invalid("Heartbeat job references a different credential surface");
  }
  if (job.executor !== surface.kind) {
    invalid("Heartbeat executor does not match credential surface kind");
  }
  for (const [field, value] of [
    ["job id", job.id],
    ["surface id", surface.id],
    ["surface home", surface.home],
    ["executable", surface.executable],
    ["model", job.model],
    ["reasoning", job.reasoning],
    ["prompt", job.prompt],
  ] as const) {
    if (value.trim().length === 0) invalid(`Heartbeat ${field} cannot be empty`);
  }
  if (
    !Number.isSafeInteger(job.timeoutSeconds) ||
    job.timeoutSeconds < MIN_TIMEOUT_SECONDS
  ) {
    invalid("Heartbeat timeoutSeconds must be a positive integer");
  }
  if (job.executor !== "pi" && job.provider !== undefined) {
    invalid("Provider is valid only for Pi heartbeat jobs");
  }
  if (job.executor === "pi") requirePiProvider(job);
}

function requirePiProvider(job: HeartbeatJobDefinition): string {
  if (job.provider === undefined || job.provider.trim().length === 0) {
    invalid("Pi heartbeat jobs require a provider");
  }
  return job.provider;
}

function invalid(message: string): never {
  throw new HeartbeatExecutionError("heartbeat_config_invalid", message);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
