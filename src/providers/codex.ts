import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const SHUTDOWN_GRACE_MS = 500;
const CODEX_PROBE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export type CodexProbeErrorCode =
  | "auth_required"
  | "usage_parse_failed"
  | "usage_probe_failed"
  | "usage_probe_timeout"
  | "usage_probe_output_limit";

export class CodexProbeError extends Error {
  override readonly name = "CodexProbeError";
  readonly code: CodexProbeErrorCode;

  constructor(code: CodexProbeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface CodexObservedIdentity {
  readonly authType: "chatgpt" | "api-key" | "amazon-bedrock";
  readonly email?: string;
  readonly plan?: string;
}

export interface CodexUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly durationMinutes?: number;
  readonly resetsAt?: string;
  readonly reached: boolean;
}

export interface CodexBalance {
  readonly id: string;
  readonly label: string;
  readonly amount?: string;
  readonly unlimited?: boolean;
  readonly limit?: string;
  readonly used?: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}

export interface CodexUsageActivity {
  readonly lifetimeTokens?: number;
  readonly peakDailyTokens?: number;
  readonly longestRunningTurnSeconds?: number;
  readonly currentStreakDays?: number;
  readonly longestStreakDays?: number;
  readonly dailyUsage?: readonly { readonly startDate: string; readonly tokens: number }[];
}

export interface CodexUsageSnapshot {
  readonly adapter: "codex-app-server";
  readonly adapterVersion: 2;
  readonly observedAt: string;
  readonly identity: CodexObservedIdentity;
  readonly windows: readonly CodexUsageWindow[];
  readonly balances: readonly CodexBalance[];
  readonly resetCreditsAvailable?: number;
  readonly activity?: CodexUsageActivity;
}

export interface CodexUsageProbeOptions {
  readonly executable: string;
  readonly home: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => Date;
  /** Test seam. Production callers must omit this. */
  readonly processFactory?: CodexProcessFactory;
}

export type CodexProcessFactory = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/**
 * Builds the intentionally small environment for the passive app-server.
 * Provider credential variables are never inherited; the configured Codex
 * home is the sole credential authority for this probe.
 */
export function buildCodexProbeEnvironment(
  ambient: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CODEX_PROBE_ENV_ALLOWLIST) {
    const value = ambient[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.CODEX_HOME = codexHome;
  environment.NO_COLOR = "1";
  return environment;
}

interface JsonRpcError {
  readonly code?: unknown;
  readonly message?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class CodexJsonRpcClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #maxOutputBytes: number;
  readonly #abortController = new AbortController();
  #nextId = 1;
  #stdoutBuffer = "";
  #outputBytes = 0;
  #closed = false;
  #fatalError: Error | undefined;

  constructor(process: ChildProcessWithoutNullStreams, maxOutputBytes: number) {
    this.#process = process;
    this.#maxOutputBytes = maxOutputBytes;
    process.stdout.on("data", (chunk: Buffer | string) => this.#receiveStdout(chunk));
    process.stderr.on("data", (chunk: Buffer | string) => this.#countOutput(chunk));
    process.on("error", (error) => this.#fail(new CodexProbeError(
      "usage_probe_failed",
      "Codex app-server could not be started.",
      { cause: error },
    )));
    process.on("exit", (code, signal) => {
      this.#closed = true;
      if (this.#pending.size > 0) {
        this.#fail(new CodexProbeError(
          "usage_probe_failed",
          `Codex app-server exited before completing the probe (${signal ?? code ?? "unknown"}).`,
        ));
      }
    });
  }

  get fatalError(): Error | undefined {
    return this.#fatalError;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#fatalError) throw this.#fatalError;
    if (this.#closed) {
      throw new CodexProbeError("usage_probe_failed", "Codex app-server is closed.");
    }
    const id = this.#nextId++;
    const envelope = params === undefined ? { id, method } : { id, method, params };
    return await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#process.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(new CodexProbeError(
          "usage_probe_failed",
          `Failed to send Codex app-server request ${method}.`,
          { cause: error },
        ));
      });
    });
  }

  async notify(method: string): Promise<void> {
    if (this.#fatalError) throw this.#fatalError;
    await new Promise<void>((resolve, reject) => {
      this.#process.stdin.write(`${JSON.stringify({ method })}\n`, (error) => {
        if (error) reject(new CodexProbeError(
          "usage_probe_failed",
          `Failed to send Codex app-server notification ${method}.`,
          { cause: error },
        ));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#process.stdin.end();
    this.#process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.#closed) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        if (!this.#closed) this.#process.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_GRACE_MS);
      timeout.unref?.();
      this.#process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #receiveStdout(chunk: Buffer | string): void {
    if (!this.#countOutput(chunk)) return;
    this.#stdoutBuffer += chunk.toString();
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let envelope: unknown;
      try {
        envelope = JSON.parse(line) as unknown;
      } catch (error) {
        this.#fail(new CodexProbeError(
          "usage_parse_failed",
          "Codex app-server emitted invalid JSON.",
          { cause: error },
        ));
        return;
      }
      if (!isRecord(envelope) || !("id" in envelope)) {
        // Notifications and server requests are unrelated to this passive probe.
        continue;
      }
      const id = envelope.id;
      if (typeof id !== "number") continue;
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);
      if ("error" in envelope && envelope.error !== undefined) {
        const rpcError = isRecord(envelope.error) ? envelope.error as JsonRpcError : undefined;
        const code = typeof rpcError?.code === "number" || typeof rpcError?.code === "string"
          ? String(rpcError.code)
          : "unknown";
        pending.reject(new CodexProbeError(
          "usage_probe_failed",
          `Codex app-server request ${pending.method} failed (RPC ${code}).`,
        ));
      } else if ("result" in envelope) {
        pending.resolve(envelope.result);
      } else {
        pending.reject(new CodexProbeError(
          "usage_parse_failed",
          `Codex app-server returned an invalid response for ${pending.method}.`,
        ));
      }
    }
  }

  #countOutput(chunk: Buffer | string): boolean {
    this.#outputBytes += Buffer.byteLength(chunk);
    if (this.#outputBytes <= this.#maxOutputBytes) return true;
    this.#fail(new CodexProbeError(
      "usage_probe_output_limit",
      "Codex app-server exceeded the probe output limit.",
    ));
    return false;
  }

  #fail(error: Error): void {
    if (this.#fatalError) return;
    this.#fatalError = error;
    this.#abortController.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export async function probeCodexUsage(options: CodexUsageProbeOptions): Promise<CodexUsageSnapshot> {
  const timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = requirePositiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const processFactory = options.processFactory ?? defaultProcessFactory;
  const child = processFactory(options.executable, ["app-server", "--stdio"], {
    cwd: options.home,
    env: buildCodexProbeEnvironment(process.env, options.home),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new CodexJsonRpcClient(child, maxOutputBytes);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const probe = (async () => {
      await client.request("initialize", {
        clientInfo: { name: "provider-pulse", title: "Provider Pulse", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      await client.notify("initialized");
      // A passive monitor may outlive Codex's short-lived access token without
      // making model requests. Refresh explicitly before quota reads so an
      // otherwise valid monitoring home does not fail with token_expired.
      const account = await client.request("account/read", { refreshToken: true });
      const rateLimits = await client.request("account/rateLimits/read");
      let activity: unknown;
      try {
        activity = await client.request("account/usage/read");
      } catch (error) {
        if (!(error instanceof CodexProbeError) || error.code !== "usage_probe_failed") throw error;
        // Optional across Codex versions/accounts. Identity and limits remain authoritative.
      }
      if (client.fatalError) throw client.fatalError;
      return normalizeSnapshot(account, rateLimits, activity, options.now?.() ?? new Date());
    })();
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new CodexProbeError(
        "usage_probe_timeout",
        `Codex usage probe timed out after ${timeoutMs} ms.`,
      )), timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([probe, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await client.close();
  }
}

function defaultProcessFactory(
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], options) as ChildProcessWithoutNullStreams;
}

function normalizeSnapshot(
  accountValue: unknown,
  rateLimitsValue: unknown,
  activityValue: unknown,
  observedAt: Date,
): CodexUsageSnapshot {
  const identity = normalizeIdentity(accountValue);
  const limits = requireRecord(rateLimitsValue, "rate-limit response");
  const snapshots = selectRateLimitSnapshots(limits);
  const windows: CodexUsageWindow[] = [];
  const balances: CodexBalance[] = [];
  for (const [fallbackId, snapshotValue] of snapshots) {
    const snapshot = requireRecord(snapshotValue, `rate-limit bucket ${fallbackId}`);
    const id = optionalString(snapshot.limitId) ?? fallbackId;
    const label = optionalString(snapshot.limitName) ?? humanize(id);
    const reached = snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined;
    for (const slot of ["primary", "secondary"] as const) {
      if (snapshot[slot] === null || snapshot[slot] === undefined) continue;
      const window = requireRecord(snapshot[slot], `${id} ${slot} window`);
      const usedPercent = requirePercent(window.usedPercent, `${id} ${slot} usedPercent`);
      const durationMinutes = optionalNonnegativeNumber(window.windowDurationMins);
      const resetsAt = optionalEpochSeconds(window.resetsAt, `${id} ${slot} resetsAt`);
      windows.push({
        id: `${id}:${slot}`,
        label: snapshots.length === 1 ? humanize(slot) : `${label} ${humanize(slot)}`,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        ...(durationMinutes === undefined ? {} : { durationMinutes }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        reached: reached || usedPercent >= 100,
      });
    }
    if (snapshot.credits !== null && snapshot.credits !== undefined) {
      const credits = requireRecord(snapshot.credits, `${id} credits`);
      const hasCredits = requireBoolean(credits.hasCredits, `${id} credits hasCredits`);
      const unlimited = requireBoolean(credits.unlimited, `${id} credits unlimited`);
      if (hasCredits || unlimited) {
        balances.push({
          id: `${id}:credits`,
          label: `${label} credits`,
          ...(optionalString(credits.balance) === undefined ? {} : { amount: optionalString(credits.balance)! }),
          unlimited,
        });
      }
    }
    if (snapshot.individualLimit !== null && snapshot.individualLimit !== undefined) {
      const spend = requireRecord(snapshot.individualLimit, `${id} spend control`);
      balances.push({
        id: `${id}:spend`,
        label: `${label} spend control`,
        limit: requireString(spend.limit, `${id} spend limit`),
        used: requireString(spend.used, `${id} spend used`),
        remainingPercent: requirePercent(spend.remainingPercent, `${id} spend remainingPercent`),
        resetsAt: requireEpochSeconds(spend.resetsAt, `${id} spend resetsAt`),
      });
    }
  }
  const resetCreditsAvailable = normalizeResetCredits(limits.rateLimitResetCredits);
  const activity = normalizeActivity(activityValue);
  return {
    adapter: "codex-app-server",
    adapterVersion: 2,
    observedAt: observedAt.toISOString(),
    identity,
    windows,
    balances,
    ...(resetCreditsAvailable === undefined ? {} : { resetCreditsAvailable }),
    ...(activity === undefined ? {} : { activity }),
  };
}

function normalizeIdentity(value: unknown): CodexObservedIdentity {
  const response = requireRecord(value, "account response");
  if (response.account === null || response.account === undefined) {
    throw new CodexProbeError("auth_required", "Codex account authentication is required.");
  }
  const account = requireRecord(response.account, "account");
  const type = requireString(account.type, "account type");
  if (type === "chatgpt") {
    const email = optionalString(account.email);
    const plan = requireString(account.planType, "account plan");
    return { authType: "chatgpt", ...(email === undefined ? {} : { email }), plan };
  }
  if (type === "apiKey") return { authType: "api-key" };
  if (type === "amazonBedrock") return { authType: "amazon-bedrock" };
  throw parseError(`Unsupported Codex account type ${type}.`);
}

function selectRateLimitSnapshots(limits: Record<string, unknown>): readonly (readonly [string, unknown])[] {
  if (limits.rateLimitsByLimitId !== null && limits.rateLimitsByLimitId !== undefined) {
    const byId = requireRecord(limits.rateLimitsByLimitId, "rateLimitsByLimitId");
    const entries = Object.entries(byId).sort(([left], [right]) =>
      rateLimitBucketRank(left) - rateLimitBucketRank(right) || left.localeCompare(right));
    if (entries.length > 0) return entries;
  }
  if (limits.rateLimits === null || limits.rateLimits === undefined) {
    throw parseError("Codex rate-limit response has no buckets.");
  }
  return [["codex", limits.rateLimits]];
}

function rateLimitBucketRank(id: string): number {
  const normalized = id.toLowerCase();
  if (normalized === "codex") return 0;
  if (normalized.includes("spark") || normalized.includes("bengalfox")) return 2;
  return 1;
}

function normalizeResetCredits(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return requireNonnegativeSafeInteger(requireRecord(value, "reset credits").availableCount, "available reset credits");
}

function normalizeActivity(value: unknown): CodexUsageActivity | undefined {
  if (value === undefined) return undefined;
  const response = requireRecord(value, "account usage response");
  const summary = requireRecord(response.summary, "account usage summary");
  const summaryResult: CodexUsageActivity = {
    ...optionalIntegerField(summary, "lifetimeTokens"),
    ...optionalIntegerField(summary, "peakDailyTokens"),
    ...optionalIntegerField(summary, "longestRunningTurnSec", "longestRunningTurnSeconds"),
    ...optionalIntegerField(summary, "currentStreakDays"),
    ...optionalIntegerField(summary, "longestStreakDays"),
  };
  if (response.dailyUsageBuckets !== null && response.dailyUsageBuckets !== undefined) {
    if (!Array.isArray(response.dailyUsageBuckets)) throw parseError("Invalid daily usage buckets.");
    const dailyUsage = response.dailyUsageBuckets.map((item, index) => {
      const bucket = requireRecord(item, `daily usage bucket ${index}`);
      return {
        startDate: requireString(bucket.startDate, `daily usage bucket ${index} date`),
        tokens: requireNonnegativeSafeInteger(bucket.tokens, `daily usage bucket ${index} tokens`),
      };
    });
    return { ...summaryResult, dailyUsage };
  }
  return summaryResult;
}

function optionalIntegerField(
  record: Record<string, unknown>,
  source: string,
  target: keyof CodexUsageActivity = source as keyof CodexUsageActivity,
): Partial<CodexUsageActivity> {
  const value = record[source];
  return value === null || value === undefined
    ? {}
    : { [target]: requireNonnegativeSafeInteger(value, source) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw parseError(`Invalid Codex ${label}.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw parseError(`Invalid Codex ${label}.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw parseError(`Invalid Codex ${label}.`);
  return value;
}

function requirePercent(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw parseError(`Invalid Codex ${label}.`);
  }
  return value;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw parseError("Invalid Codex window duration.");
  }
  return value;
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw parseError(`Invalid Codex ${label}.`);
  }
  return value;
}

function optionalEpochSeconds(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireEpochSeconds(value, label);
}

function requireEpochSeconds(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw parseError(`Invalid Codex ${label}.`);
  }
  return new Date(value * 1_000).toISOString();
}

function humanize(value: string): string {
  return value.replaceAll(/[-_:]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseError(message: string): CodexProbeError {
  return new CodexProbeError("usage_parse_failed", message);
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}
