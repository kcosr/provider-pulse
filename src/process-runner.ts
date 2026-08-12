import { spawn } from "node:child_process";

export interface ProcessSpec {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  outputLimitBytes?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type ProcessErrorCode =
  | "process_spawn_failed"
  | "process_timeout"
  | "process_output_limit"
  | "process_aborted";

export class ProcessRunError extends Error {
  readonly code: ProcessErrorCode;
  override readonly cause: unknown;

  constructor(code: ProcessErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ProcessRunError";
    this.code = code;
    this.cause = cause;
  }
}

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const startedAt = performance.now();
  const outputLimit = spec.outputLimitBytes ?? 256 * 1024;
  const graceMs = spec.terminationGraceMs ?? 1_000;

  if (spec.timeoutMs <= 0) {
    return Promise.reject(new ProcessRunError("process_timeout", "Process timeout must be positive"));
  }
  if (outputLimit <= 0) {
    return Promise.reject(
      new ProcessRunError("process_output_limit", "Process output limit must be positive"),
    );
  }
  if (spec.signal?.aborted === true) {
    return Promise.reject(new ProcessRunError("process_aborted", "Process was aborted before start"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forcedKillTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forcedKillTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      forcedKillTimer.unref();
    };

    const finishError = (error: ProcessRunError): void => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup(false);
      reject(error);
    };

    const collect = (destination: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > outputLimit) {
        finishError(
          new ProcessRunError(
            "process_output_limit",
            `Process exceeded the ${outputLimit}-byte output limit`,
          ),
        );
        return;
      }
      destination.push(buffer);
    };

    const timeout = setTimeout(() => {
      finishError(
        new ProcessRunError("process_timeout", `Process exceeded its ${spec.timeoutMs}ms timeout`),
      );
    }, spec.timeoutMs);
    timeout.unref();

    const abort = (): void => {
      finishError(new ProcessRunError("process_aborted", "Process was aborted"));
    };
    spec.signal?.addEventListener("abort", abort, { once: true });

    const cleanup = (clearForcedKill = true): void => {
      clearTimeout(timeout);
      if (clearForcedKill && forcedKillTimer !== undefined) clearTimeout(forcedKillTimer);
      spec.signal?.removeEventListener("abort", abort);
    };

    child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      finishError(
        new ProcessRunError(
          "process_spawn_failed",
          `Unable to start executable ${spec.executable}`,
          error,
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        cleanup();
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });

    if (spec.stdin !== undefined) child.stdin!.end(spec.stdin);
  });
}
