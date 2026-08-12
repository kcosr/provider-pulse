import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { executeHeartbeat as executeConfiguredHeartbeat } from "./heartbeats.js";
import type { JsonlLogger } from "./log.js";
import { runProcess } from "./process-runner.js";
import { ClaudeUsageAdapter } from "./providers/claude.js";
import { probeCodexUsage } from "./providers/codex.js";
import { probeFireworksUsage } from "./providers/fireworks.js";
import { GrokUsageAdapter } from "./providers/grok.js";
import {
  calculateResetEligibleAt,
  ResetAwareScheduler,
  type ResetAwareJob,
} from "./reset-scheduler.js";
import { aggregateHealth, StatusStore } from "./status-store.js";
import {
  TmuxTerminalProbe,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./terminal/tmux.js";
import type {
  AccountConfig,
  AppConfig,
  CliCredentialSurfaceConfig,
  CredentialSurfaceConfig,
  ExpectedIdentity,
  HeartbeatJobConfig,
  ObservedIdentity,
  OperationReceipt,
  ProviderPulseStatus,
  StatusError,
  UsageBalance,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";

export interface UsageProbeResult {
  identity: ObservedIdentity;
  snapshot: UsageSnapshot;
  implementation: string;
  implementationVersion: string;
}

export type UsageProbe = (
  account: AccountConfig,
  surface: CredentialSurfaceConfig,
) => Promise<UsageProbeResult>;

export type HeartbeatRunner = (
  job: HeartbeatJobConfig,
  surface: CliCredentialSurfaceConfig,
) => Promise<{ durationMs: number }>;

export interface ApplicationDependencies {
  usageProbe?: UsageProbe;
  heartbeatRunner?: HeartbeatRunner;
  logger?: Pick<JsonlLogger, "append">;
  now?: () => Date;
  createOperationId?: () => string;
  schedulerTickIntervalMilliseconds?: number;
  terminalCleanup?: () => Promise<void>;
}

export interface RuntimeValidationOptions {
  environment?: NodeJS.ProcessEnv;
  piModelCatalogProbe?: (
    job: Extract<HeartbeatJobConfig, { executor: "pi" }>,
    surface: CliCredentialSurfaceConfig,
  ) => Promise<boolean>;
}

export async function validateRuntimeDependencies(
  config: AppConfig,
  options: RuntimeValidationOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  for (const surface of config.credentialSurfaces) {
    if (surface.kind === "fireworks-api") {
      try {
        const credential = await stat(surface.credentialFile);
        if (!credential.isFile() || credential.size < 1 || credential.size > 4096) {
          throw new Error("invalid credential file");
        }
        if ((credential.mode & 0o077) !== 0) {
          throw new RuntimeDependencyError(
            surface.id,
            "credential_file_permissions_invalid",
            "API credential file must be readable only by its owner",
          );
        }
        await access(surface.credentialFile, constants.R_OK);
      } catch (error) {
        if (error instanceof RuntimeDependencyError) throw error;
        throw new RuntimeDependencyError(
          surface.id,
          "credential_file_invalid",
          "API credential file is unavailable or invalid",
        );
      }
      continue;
    }
    try {
      const home = await stat(surface.home);
      if (!home.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new RuntimeDependencyError(surface.id, "credential_home_invalid", "Credential home is unavailable or is not a directory");
    }
    if (await resolveExecutable(surface.executable, environment) === null) {
      throw new RuntimeDependencyError(surface.id, "executable_unavailable", "Configured executable is unavailable or is not executable");
    }
  }

  const needsTmux = config.accounts.some((account) =>
    account.usageSource.adapter === "claude-tmux" || account.usageSource.adapter === "grok-tmux",
  );
  if (needsTmux && await resolveExecutable("tmux", environment) === null) {
    throw new RuntimeDependencyError("tmux", "executable_unavailable", "tmux is required by a configured usage adapter");
  }

  const piModelCatalogProbe = options.piModelCatalogProbe ?? ((job, surface) =>
    probePiModelCatalog(job, surface, environment));
  for (const job of config.heartbeatJobs) {
    if (job.executor !== "pi") continue;
    const surface = config.credentialSurfaces.find((candidate) => candidate.id === job.credentialSurfaceId);
    let available = false;
    if (surface?.kind === "pi") {
      try {
        available = await piModelCatalogProbe(job, surface);
      } catch {
        available = false;
      }
    }
    if (!available) {
      throw new RuntimeDependencyError(
        job.credentialSurfaceId,
        "pi_model_unavailable",
        `Pi model catalog does not contain the configured provider/model for heartbeat ${job.id}`,
      );
    }
  }
}

async function probePiModelCatalog(
  job: Extract<HeartbeatJobConfig, { executor: "pi" }>,
  surface: CliCredentialSurfaceConfig,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await runProcess({
    executable: surface.executable,
    args: [
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--list-models",
      `${job.provider}/${job.model}`,
    ],
    env: {
      ...isolatedProcessEnvironmentFrom(environment),
      PI_CODING_AGENT_DIR: surface.home,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    },
    timeoutMs: 15_000,
    outputLimitBytes: 256 * 1024,
  });
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const [provider, model] = line.trim().split(/\s+/u);
    return provider === job.provider && model === job.model;
  });
}

function isolatedProcessEnvironmentFrom(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
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
  ]) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function resolveExecutable(executable: string, environment: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

interface RunningOperation {
  operationId: string;
  promise: Promise<void>;
}

interface RunningUsageOperation extends RunningOperation {
  markFreshObservation: boolean;
}

interface SchedulerObservation {
  identityMatches: boolean;
  resetAt: string | null;
}

export class ProviderPulseApplication {
  readonly #config: AppConfig;
  readonly #store: StatusStore;
  readonly #usageProbe: UsageProbe;
  readonly #heartbeatRunner: HeartbeatRunner;
  readonly #logger: ApplicationDependencies["logger"];
  readonly #now: () => Date;
  readonly #createOperationId: () => string;
  readonly #accounts: ReadonlyMap<string, AccountConfig>;
  readonly #surfaces: ReadonlyMap<string, CredentialSurfaceConfig>;
  readonly #jobs: ReadonlyMap<string, HeartbeatJobConfig>;
  readonly #usageOperations = new Map<string, RunningUsageOperation>();
  readonly #heartbeatOperations = new Map<string, RunningOperation>();
  readonly #surfaceTails = new Map<string, Promise<void>>();
  readonly #usageWaiters: Array<() => void> = [];
  readonly #scheduler: ResetAwareScheduler;
  readonly #terminalCleanup: (() => Promise<void>) | undefined;
  #activeUsageCount = 0;
  #automaticPollTimer: NodeJS.Timeout | undefined;
  #initialized = false;
  #closing = false;

  constructor(config: AppConfig, dependencies: ApplicationDependencies = {}) {
    this.#config = structuredClone(config);
    this.#store = new StatusStore(config);
    const defaultUsage = dependencies.usageProbe === undefined
      ? createDefaultUsageRuntime(config.paths.probeDirectory)
      : undefined;
    this.#usageProbe = dependencies.usageProbe ?? defaultUsage!.probe;
    this.#terminalCleanup = dependencies.terminalCleanup ?? defaultUsage?.cleanup;
    this.#heartbeatRunner = dependencies.heartbeatRunner ?? (async (job, surface) => {
      const result = await executeConfiguredHeartbeat(job, surface);
      return { durationMs: result.durationMs };
    });
    this.#logger = dependencies.logger;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createOperationId = dependencies.createOperationId ?? randomUUID;
    this.#accounts = new Map(config.accounts.map((account) => [account.id, account]));
    this.#surfaces = new Map(config.credentialSurfaces.map((surface) => [surface.id, surface]));
    this.#jobs = new Map(config.heartbeatJobs.map((job) => [job.id, job]));

    const schedulerJobs = config.heartbeatJobs.map((job) => ({
      id: job.id,
      accountId: job.accountId,
      windowId: job.trigger.windowId,
      offsetMinutes: job.trigger.offsetMinutes,
      enabled: job.enabled,
    }));
    this.#scheduler = new ResetAwareScheduler({
      jobs: schedulerJobs,
      stateFile: join(config.paths.stateDirectory, "scheduler-state.json"),
      callbacks: {
        refreshUsage: async (job) => this.#refreshForScheduler(job),
        runHeartbeat: async (job) => this.#runHeartbeatForScheduler(job),
      },
      now: this.#now,
      ...(dependencies.schedulerTickIntervalMilliseconds === undefined
        ? {}
        : { tickIntervalMilliseconds: dependencies.schedulerTickIntervalMilliseconds }),
    });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    // The private tmux namespace is application-owned. Resetting it here
    // removes probes abandoned by a previous unclean process exit without
    // touching the user's ordinary tmux server.
    await this.#terminalCleanup?.();
    await this.#scheduler.initialize();
    this.#initialized = true;
    this.#scheduler.start();

    const resetAccountIds = new Set(
      [...this.#jobs.values()].filter((job) => job.enabled).map((job) => job.accountId),
    );
    const startupIds = this.#config.polling.startupCheck
      ? [...this.#accounts.keys()]
      : [...resetAccountIds];
    for (const accountId of startupIds) this.checkUsage(accountId);

    const interval = this.#config.polling.automaticIntervalMinutes;
    if (interval !== null) {
      this.#automaticPollTimer = setInterval(() => {
        if (!this.#closing) this.checkAll();
      }, interval * 60_000);
      this.#automaticPollTimer.unref();
    }
  }

  getStatus(): ProviderPulseStatus {
    const snapshot = this.#store.snapshot(this.#now());
    const staleBefore = this.#now().getTime() - this.#config.polling.staleAfterMinutes * 60_000;
    for (const account of snapshot.accounts) {
      if (
        account.usage.health === "healthy" &&
        account.usage.lastSuccessAt !== undefined &&
        Date.parse(account.usage.lastSuccessAt) < staleBefore
      ) {
        account.usage.health = "stale";
      }
    }
    snapshot.health = aggregateHealth([
      ...snapshot.accounts.map((account) => account.usage.health),
      ...snapshot.heartbeats.filter((heartbeat) => heartbeat.enabled).map((heartbeat) => heartbeat.health),
    ]);
    return snapshot;
  }

  checkUsage(accountId: string): OperationReceipt {
    this.#assertOpen();
    return this.#startUsageCheck(this.#requireAccount(accountId), true);
  }

  #startUsageCheck(account: AccountConfig, markFreshObservation: boolean): OperationReceipt {
    const existing = this.#usageOperations.get(account.id);
    if (existing !== undefined) {
      if (markFreshObservation) existing.markFreshObservation = true;
      return receipt(existing.operationId, account.id, "usage-check", true);
    }

    const operationId = this.#createOperationId();
    const promise = this.#performUsageCheck(account, operationId);
    this.#usageOperations.set(account.id, { operationId, promise, markFreshObservation });
    void promise.finally(() => {
      if (this.#usageOperations.get(account.id)?.operationId === operationId) {
        this.#usageOperations.delete(account.id);
      }
    }).catch(() => undefined);
    return receipt(operationId, account.id, "usage-check", false);
  }

  checkAll(): readonly OperationReceipt[] {
    this.#assertOpen();
    return [...this.#accounts.keys()].map((accountId) => this.checkUsage(accountId));
  }

  runHeartbeat(heartbeatId: string): OperationReceipt {
    this.#assertOpen();
    const job = this.#requireJob(heartbeatId);
    if (!job.enabled) return { ...receipt(this.#createOperationId(), heartbeatId, "heartbeat", false), accepted: false };
    return this.#startHeartbeat(job, Promise.resolve());
  }

  heartbeatAll(): readonly OperationReceipt[] {
    this.#assertOpen();
    const receipts: OperationReceipt[] = [];
    const executionTuples = new Set<string>();
    let tail = Promise.resolve();
    for (const job of this.#jobs.values()) {
      if (!job.enabled) continue;
      const tuple = heartbeatExecutionTuple(job);
      if (executionTuples.has(tuple)) continue;
      executionTuples.add(tuple);
      const existing = this.#heartbeatOperations.get(job.id);
      if (existing !== undefined) {
        receipts.push(receipt(existing.operationId, job.id, "heartbeat", true));
        tail = existing.promise.catch(() => undefined);
        continue;
      }
      const started = this.#startHeartbeat(job, tail);
      receipts.push(started);
      tail = this.#heartbeatOperations.get(job.id)?.promise.catch(() => undefined) ?? tail;
    }
    return receipts;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#automaticPollTimer !== undefined) clearInterval(this.#automaticPollTimer);
    await this.#scheduler.stopAndWait();
    const active = [
      ...[...this.#usageOperations.values()].map((operation) => operation.promise),
      ...[...this.#heartbeatOperations.values()].map((operation) => operation.promise),
    ];
    await Promise.allSettled(active);
    await this.#terminalCleanup?.().catch(() => undefined);
  }

  #startHeartbeat(job: HeartbeatJobConfig, predecessor: Promise<void>): OperationReceipt {
    const existing = this.#heartbeatOperations.get(job.id);
    if (existing !== undefined) return receipt(existing.operationId, job.id, "heartbeat", true);
    const operationId = this.#createOperationId();
    const promise = predecessor.catch(() => undefined).then(() => this.#performHeartbeat(job, operationId, true));
    this.#heartbeatOperations.set(job.id, { operationId, promise });
    void promise.finally(() => {
      if (this.#heartbeatOperations.get(job.id)?.operationId === operationId) {
        this.#heartbeatOperations.delete(job.id);
      }
    }).catch(() => undefined);
    return receipt(operationId, job.id, "heartbeat", false);
  }

  async #performUsageCheck(account: AccountConfig, operationId: string): Promise<void> {
    const attemptedAt = this.#now();
    this.#store.updateAccount(account.id, (current) => ({
      ...current,
      usage: {
        ...withoutError(current.usage),
        health: "running",
        inFlight: true,
        operationId,
        lastAttemptAt: attemptedAt.toISOString(),
      },
    }));

    await this.#acquireUsageSlot();
    try {
      const surface = this.#requireSurface(account.usageSource.credentialSurfaceId);
      const result = await this.#withSurface(surface.id, () => this.#usageProbe(account, surface));
      const completedAt = this.#now();
      const identity = compareIdentity(account.expectedIdentity, result.identity);
      const mismatch = identity.match === "mismatched";
      this.#store.updateAccount(account.id, (current) => ({
        ...current,
        usage: {
          ...(mismatch ? current.usage : withoutError(current.usage)),
          health: mismatch ? "unhealthy" : "healthy",
          inFlight: false,
          operationId,
          lastSuccessAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
          ...(mismatch ? { error: identityMismatchError() } : {}),
          identity,
          snapshot: structuredClone(result.snapshot),
        },
      }));
      const markFreshObservation = this.#usageOperations.get(account.id)?.markFreshObservation ?? false;
      await this.#observeAccountResets(account.id, result.snapshot.windows, markFreshObservation);
      await this.#log({
        operationId,
        kind: "usage-check",
        accountId: account.id,
        outcome: mismatch ? "identity_mismatch" : "success",
        attemptedAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
        implementation: result.implementation,
        implementationVersion: result.implementationVersion,
        ...(mismatch ? { error: identityMismatchError() } : {}),
      });
    } catch (error: unknown) {
      const completedAt = this.#now();
      const normalized = normalizeError(error, "usage_probe_failed");
      this.#store.updateAccount(account.id, (current) => ({
        ...current,
        usage: {
          ...current.usage,
          health: current.usage.snapshot === undefined ? "unhealthy" : "stale",
          inFlight: false,
          operationId,
          durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
          error: normalized,
        },
      }));
      await this.#log({
        operationId,
        kind: "usage-check",
        accountId: account.id,
        outcome: "failure",
        attemptedAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
        error: normalized,
      });
      throw error;
    } finally {
      this.#releaseUsageSlot();
    }
  }

  async #performHeartbeat(job: HeartbeatJobConfig, operationId: string, postPoll: boolean): Promise<void> {
    const attemptedAt = this.#now();
    this.#store.updateHeartbeat(job.id, (current) => ({
      ...withoutError(current),
      health: "running",
      inFlight: true,
      operationId,
      lastAttemptAt: attemptedAt.toISOString(),
    }));
    try {
      const account = this.#requireAccount(job.accountId);
      if (
        account.expectedIdentity !== undefined &&
        job.credentialSurfaceId !== account.usageSource.credentialSurfaceId
      ) {
        throw new ApplicationOperationError(
          "heartbeat_identity_unverifiable",
          "Heartbeat blocked because its credential surface cannot be verified by the account usage source",
        );
      }
      if (account.expectedIdentity !== undefined) {
        const pollReceipt = this.checkUsage(account.id);
        await this.#usageOperations.get(account.id)?.promise;
        const match = this.#store.getAccount(account.id)?.usage.identity.match;
        if (match !== "matched") {
          throw new ApplicationOperationError(
            "identity_mismatch",
            `Heartbeat blocked because account identity did not match (${pollReceipt.operationId})`,
          );
        }
      } else if (this.#store.getAccount(account.id)?.usage.identity.match === "mismatched") {
        throw new ApplicationOperationError("identity_mismatch", "Heartbeat blocked by account identity mismatch");
      }

      const surface = this.#requireSurface(job.credentialSurfaceId);
      if (surface.kind === "fireworks-api") {
        throw new ApplicationOperationError(
          "heartbeat_config_invalid",
          "API-only credential surfaces cannot run heartbeats",
        );
      }
      const result = await this.#withSurface(surface.id, () => this.#heartbeatRunner(job, surface));
      const completedAt = this.#now();
      this.#store.updateHeartbeat(job.id, (current) => ({
        ...withoutError(current),
        health: "healthy",
        inFlight: false,
        operationId,
        lastSuccessAt: completedAt.toISOString(),
        durationMs: result.durationMs,
      }));
      await this.#log({
        operationId,
        kind: "heartbeat",
        heartbeatId: job.id,
        accountId: job.accountId,
        outcome: "success",
        attemptedAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: result.durationMs,
        implementation: job.executor,
      });
      if (postPoll && !this.#closing) {
        const usageReceipt = this.checkUsage(job.accountId);
        await this.#usageOperations.get(job.accountId)?.promise.catch(() => undefined);
        void usageReceipt;
      }
    } catch (error: unknown) {
      const completedAt = this.#now();
      const normalized = normalizeError(error, "heartbeat_request_failed");
      this.#store.updateHeartbeat(job.id, (current) => ({
        ...current,
        health: "unhealthy",
        inFlight: false,
        operationId,
        durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
        error: normalized,
      }));
      await this.#log({
        operationId,
        kind: "heartbeat",
        heartbeatId: job.id,
        accountId: job.accountId,
        outcome: "failure",
        attemptedAt: attemptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - attemptedAt.getTime()),
        implementation: job.executor,
        error: normalized,
      });
      throw error;
    }
  }

  async #refreshForScheduler(job: ResetAwareJob): Promise<SchedulerObservation> {
    const check = this.#startUsageCheck(this.#requireAccount(job.accountId), false);
    await this.#usageOperations.get(job.accountId)?.promise;
    void check;
    const account = this.#store.getAccount(job.accountId);
    const window = account?.usage.snapshot?.windows.find((candidate) => candidate.id === job.windowId);
    return {
      identityMatches: account?.usage.identity.match !== "mismatched",
      resetAt: window?.resetsAt ?? null,
    };
  }

  async #runHeartbeatForScheduler(schedulerJob: ResetAwareJob): Promise<void> {
    const job = this.#requireJob(schedulerJob.id);
    const existing = this.#heartbeatOperations.get(job.id);
    if (existing !== undefined) {
      await existing.promise;
      return;
    }
    const operationId = this.#createOperationId();
    const promise = this.#performHeartbeat(job, operationId, false);
    this.#heartbeatOperations.set(job.id, { operationId, promise });
    try {
      await promise;
    } finally {
      if (this.#heartbeatOperations.get(job.id)?.operationId === operationId) {
        this.#heartbeatOperations.delete(job.id);
      }
    }
  }

  async #observeAccountResets(
    accountId: string,
    windows: readonly UsageWindow[],
    markFreshObservation: boolean,
  ): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (!job.enabled || job.accountId !== accountId) continue;
      const resetAt = windows.find((window) => window.id === job.trigger.windowId)?.resetsAt;
      if (resetAt === undefined) continue;
      await this.#scheduler.observeReset(job.id, resetAt, { markFreshObservation });
      this.#store.updateHeartbeat(job.id, (current) => ({
        ...current,
        nextEligibleAt: calculateResetEligibleAt(resetAt, job.trigger.offsetMinutes).toISOString(),
      }));
    }
  }

  async #withSurface<T>(surfaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#surfaceTails.get(surfaceId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => tail);
    this.#surfaceTails.set(surfaceId, queued);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release?.();
      if (this.#surfaceTails.get(surfaceId) === queued) this.#surfaceTails.delete(surfaceId);
    }
  }

  async #acquireUsageSlot(): Promise<void> {
    if (this.#activeUsageCount < this.#config.polling.maxConcurrency) {
      this.#activeUsageCount += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#usageWaiters.push(resolve));
    this.#activeUsageCount += 1;
  }

  #releaseUsageSlot(): void {
    this.#activeUsageCount -= 1;
    this.#usageWaiters.shift()?.();
  }

  async #log(event: Parameters<NonNullable<ApplicationDependencies["logger"]>["append"]>[0]): Promise<void> {
    await this.#logger?.append(event).catch(() => undefined);
  }

  #requireAccount(id: string): AccountConfig {
    const account = this.#accounts.get(id);
    if (account === undefined) throw new UnknownConfiguredTargetError("account", id);
    return account;
  }

  #requireJob(id: string): HeartbeatJobConfig {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new UnknownConfiguredTargetError("heartbeat", id);
    return job;
  }

  #requireSurface(id: string): CredentialSurfaceConfig {
    const surface = this.#surfaces.get(id);
    if (surface === undefined) throw new Error(`Missing validated credential surface: ${id}`);
    return surface;
  }

  #assertOpen(): void {
    if (this.#closing) throw new ApplicationOperationError("service_stopping", "Provider Pulse is stopping");
  }
}

export function createDefaultUsageProbe(probeDirectory: string): UsageProbe {
  return createDefaultUsageRuntime(probeDirectory).probe;
}

interface DefaultUsageRuntime {
  probe: UsageProbe;
  cleanup: () => Promise<void>;
}

function createDefaultUsageRuntime(probeDirectory: string): DefaultUsageRuntime {
  const commandRunner: CommandRunner = {
    async run(request: CommandRequest): Promise<CommandResult> {
      const result = await runProcess({
        executable: request.executable,
        args: request.args,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined
          ? {}
          : { env: request.clearEnvironment === true ? { ...request.env } : { ...process.env, ...request.env } }),
        timeoutMs: request.timeoutMs,
        outputLimitBytes: request.maxOutputBytes,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
  const terminal = new TmuxTerminalProbe(commandRunner);
  const claude = new ClaudeUsageAdapter(commandRunner, terminal);
  const grok = new GrokUsageAdapter(terminal);

  const probe: UsageProbe = async (account, surface) => {
    switch (account.usageSource.adapter) {
      case "codex-app-server": {
        if (surface.kind !== "native-codex") throw invalidUsageSurface(account.id);
        const value = await probeCodexUsage({ executable: surface.executable, home: surface.home });
        return {
          identity: compactIdentity({ email: value.identity.email, plan: value.identity.plan, authMethod: value.identity.authType }),
          snapshot: {
            observedAt: value.observedAt,
            windows: value.windows.map((window) => ({ ...window })),
            balances: value.balances.map(normalizeCodexBalance),
          },
          implementation: value.adapter,
          implementationVersion: String(value.adapterVersion),
        };
      }
      case "claude-tmux": {
        if (surface.kind !== "native-claude") throw invalidUsageSurface(account.id);
        const value = await claude.poll({ executable: surface.executable, home: surface.home, probeDirectory });
        return {
          identity: structuredClone(value.identity),
          snapshot: {
            observedAt: new Date().toISOString(),
            windows: value.windows.map(normalizeParsedWindow),
            balances: [],
          },
          implementation: value.adapter,
          implementationVersion: String(value.adapterVersion),
        };
      }
      case "grok-tmux": {
        if (surface.kind !== "native-grok") throw invalidUsageSurface(account.id);
        const value = await grok.poll({ executable: surface.executable, home: surface.home, probeDirectory });
        return {
          identity: structuredClone(value.identity),
          snapshot: {
            observedAt: new Date().toISOString(),
            windows: value.windows.map(normalizeParsedWindow),
            balances: [],
          },
          implementation: value.adapter,
          implementationVersion: String(value.adapterVersion),
        };
      }
      case "fireworks-api": {
        if (surface.kind !== "fireworks-api") throw invalidUsageSurface(account.id);
        const accountId = account.expectedIdentity?.accountId;
        if (accountId === undefined) throw invalidUsageSurface(account.id);
        const value = await probeFireworksUsage({
          credentialFile: surface.credentialFile,
          accountId,
        });
        return {
          identity: structuredClone(value.identity),
          snapshot: {
            observedAt: value.observedAt,
            windows: value.windows.map((window) => ({ ...window })),
            balances: value.balances.map((balance) => ({ ...balance })),
          },
          implementation: value.adapter,
          implementationVersion: String(value.adapterVersion),
        };
      }
    }
  };
  return { probe, cleanup: () => terminal.shutdown() };
}

function invalidUsageSurface(accountId: string): Error {
  return new ApplicationOperationError(
    "usage_surface_invalid",
    `Configured usage surface is invalid for account ${accountId}`,
  );
}

function normalizeCodexBalance(balance: {
  id: string;
  label: string;
  amount?: string;
  unlimited?: boolean;
  limit?: string;
  used?: string;
  remainingPercent?: number;
  resetsAt?: string;
}): UsageBalance {
  const amount = balance.amount === undefined ? undefined : Number(balance.amount);
  return {
    id: balance.id,
    label: balance.label,
    ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}),
    ...(balance.unlimited === undefined ? {} : { unlimited: balance.unlimited }),
    ...(balance.unlimited === true ? { unit: "unlimited" } : {}),
    ...(balance.limit === undefined ? {} : { limit: balance.limit }),
    ...(balance.used === undefined ? {} : { used: balance.used }),
    ...(balance.remainingPercent === undefined ? {} : { remainingPercent: balance.remainingPercent }),
    ...(balance.resetsAt === undefined ? {} : { resetsAt: balance.resetsAt }),
  };
}

function normalizeParsedWindow(window: {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string | null;
  reached?: boolean;
}): UsageWindow {
  return {
    id: window.id,
    label: window.label,
    ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
    ...(window.remainingPercent === undefined ? {} : { remainingPercent: window.remainingPercent }),
    ...(window.resetsAt === undefined || window.resetsAt === null ? {} : { resetsAt: window.resetsAt }),
    ...(window.reached === undefined ? {} : { reached: window.reached }),
  };
}

function compareIdentity(expected: ExpectedIdentity | undefined, observed: ObservedIdentity) {
  if (expected === undefined) return { observed: structuredClone(observed), match: "unknown" as const };
  const checks = [
    compareOptional(expected.email, observed.email, true),
    compareOptional(expected.organizationId, observed.organizationId),
    compareOptional(expected.accountId, observed.accountId),
  ].filter((value): value is boolean => value !== undefined);
  return {
    expected: structuredClone(expected),
    observed: structuredClone(observed),
    match: checks.length > 0 && checks.every(Boolean) ? "matched" as const : "mismatched" as const,
  };
}

function compareOptional(expected: string | undefined, observed: string | undefined, email = false): boolean | undefined {
  if (expected === undefined) return undefined;
  if (observed === undefined) return false;
  const normalize = (value: string) => email ? value.trim().toLocaleLowerCase() : value.trim();
  return normalize(expected) === normalize(observed);
}

function compactIdentity(value: { email?: string | undefined; plan?: string | undefined; authMethod?: string | undefined }): ObservedIdentity {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function withoutError<T extends { error?: StatusError }>(value: T): Omit<T, "error"> {
  const copy = { ...value };
  delete copy.error;
  return copy;
}

function heartbeatExecutionTuple(job: HeartbeatJobConfig): string {
  return [
    job.accountId,
    job.credentialSurfaceId,
    job.executor,
    job.provider ?? "",
    job.model,
    job.reasoning,
    job.prompt,
  ].join("\u0000");
}

function normalizeError(error: unknown, fallbackCode: string): StatusError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : fallbackCode;
    return { code, message: error.message.slice(0, 500) };
  }
  return { code: fallbackCode, message: "Operation failed" };
}

function identityMismatchError(): StatusError {
  return { code: "identity_mismatch", message: "Observed provider identity does not match the configured identity" };
}

function receipt(
  operationId: string,
  targetId: string,
  kind: OperationReceipt["kind"],
  coalesced: boolean,
): OperationReceipt {
  return { operationId, accepted: true, targetId, kind, coalesced };
}

export class UnknownConfiguredTargetError extends Error {
  readonly kind: "account" | "heartbeat";
  readonly id: string;

  constructor(kind: "account" | "heartbeat", id: string) {
    super(`Unknown ${kind}: ${id}`);
    this.name = "UnknownConfiguredTargetError";
    this.kind = kind;
    this.id = id;
  }
}

export class ApplicationOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplicationOperationError";
    this.code = code;
  }
}

export class RuntimeDependencyError extends Error {
  readonly surfaceId: string;
  readonly code:
    | "credential_file_invalid"
    | "credential_file_permissions_invalid"
    | "credential_home_invalid"
    | "executable_unavailable"
    | "pi_model_unavailable";

  constructor(
    surfaceId: string,
    code: RuntimeDependencyError["code"],
    message: string,
  ) {
    super(`Runtime validation failed for ${surfaceId}: ${message}`);
    this.name = "RuntimeDependencyError";
    this.surfaceId = surfaceId;
    this.code = code;
  }
}
