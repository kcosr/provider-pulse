import {
  emptySchedulerCursor,
  loadSchedulerCursor,
  type SchedulerCursor,
  writeSchedulerCursorAtomic,
} from "./scheduler-state.js";

export interface ResetAwareJob {
  id: string;
  accountId: string;
  windowId: string;
  offsetMinutes: number;
  enabled: boolean;
}

export interface ResetVerification {
  identityMatches: boolean;
  resetAt: string | null;
  durationMinutes?: number;
}

export interface ResetSchedulerCallbacks {
  refreshUsage(
    job: ResetAwareJob,
    eligibleResetAt: string,
  ): Promise<ResetVerification>;
  runHeartbeat(job: ResetAwareJob): Promise<void>;
}

export type SchedulerTickOutcome =
  | "heartbeat_succeeded"
  | "heartbeat_succeeded_estimated_reset"
  | "heartbeat_succeeded_refresh_failed"
  | "heartbeat_failed"
  | "identity_mismatch"
  | "reset_unavailable"
  | "reset_changed"
  | "verification_failed";

export interface SchedulerTickResult {
  jobId: string;
  resetAt: string;
  outcome: SchedulerTickOutcome;
  error?: unknown;
}

export interface ResetAwareSchedulerOptions {
  jobs: readonly ResetAwareJob[];
  stateFile: string;
  callbacks: ResetSchedulerCallbacks;
  now?: () => Date;
  tickIntervalMilliseconds?: number;
}

export interface ObserveResetOptions {
  /**
   * Re-arm a failed preflight after an explicit successful usage observation.
   * This never re-arms a reset that has already been claimed for heartbeat.
   */
  markFreshObservation?: boolean;
}

const DEFAULT_TICK_INTERVAL_MILLISECONDS = 60_000;

/**
 * Reset-driven scheduler. Dashboard state is deliberately absent here: only
 * the reset cursor crosses process restarts.
 */
export class ResetAwareScheduler {
  readonly #jobs: readonly ResetAwareJob[];
  readonly #stateFile: string;
  readonly #callbacks: ResetSchedulerCallbacks;
  readonly #now: () => Date;
  readonly #tickIntervalMilliseconds: number;
  readonly #attemptedResets = new Map<string, string>();
  #cursor: SchedulerCursor = emptySchedulerCursor();
  #initialized = false;
  #interval: NodeJS.Timeout | undefined;
  #tickPromise: Promise<readonly SchedulerTickResult[]> | undefined;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ResetAwareSchedulerOptions) {
    if (!Number.isSafeInteger(options.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS)) {
      throw new TypeError("tickIntervalMilliseconds must be a positive integer");
    }
    if ((options.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS) <= 0) {
      throw new TypeError("tickIntervalMilliseconds must be a positive integer");
    }
    for (const job of options.jobs) {
      if (!Number.isSafeInteger(job.offsetMinutes) || job.offsetMinutes < 0) {
        throw new TypeError(`Invalid offsetMinutes for scheduler job ${job.id}`);
      }
    }

    this.#jobs = options.jobs;
    this.#stateFile = options.stateFile;
    this.#callbacks = options.callbacks;
    this.#now = options.now ?? (() => new Date());
    this.#tickIntervalMilliseconds =
      options.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS;
  }

  async initialize(): Promise<void> {
    this.#cursor = await loadSchedulerCursor(this.#stateFile);
    this.#initialized = true;
  }

  start(): void {
    this.#assertInitialized();
    if (this.#interval !== undefined) return;
    this.#interval = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.#tickIntervalMilliseconds);
    this.#interval.unref();
  }

  stop(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    const activeTick = this.#tickPromise;
    if (activeTick !== undefined) await activeTick;
  }

  snapshot(): SchedulerCursor {
    this.#assertInitialized();
    return structuredClone(this.#cursor);
  }

  observeReset(
    jobId: string,
    resetAt: string,
    options: ObserveResetOptions = {},
  ): Promise<void> {
    this.#assertInitialized();
    return this.#enqueueMutation(() => this.#observeReset(jobId, resetAt, options));
  }

  estimateNextResetFromHandled(
    jobId: string,
    durationMinutes: number,
  ): Promise<string | null> {
    this.#assertInitialized();
    return this.#enqueueMutation(async () => {
      const duration = validDurationMinutes(durationMinutes);
      if (duration === null) throw new TypeError("durationMinutes must be a positive integer");
      const job = this.#jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined) throw new Error(`Unknown reset-aware scheduler job: ${jobId}`);
      const cursor = this.#cursor.jobs[jobId];
      if (
        cursor === undefined ||
        cursor.lastHandledResetAt !== cursor.lastObservedResetAt
      ) return null;
      const estimatedResetAt = new Date(
        Date.parse(cursor.lastHandledResetAt) +
        (job.offsetMinutes + duration) * 60_000,
      ).toISOString();
      await this.#observeReset(jobId, estimatedResetAt, {});
      return estimatedResetAt;
    });
  }

  async #observeReset(
    jobId: string,
    resetAt: string,
    options: ObserveResetOptions,
  ): Promise<void> {
    const job = this.#jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) throw new Error(`Unknown reset-aware scheduler job: ${jobId}`);
    const normalizedResetAt = normalizeTimestamp(resetAt);
    const previous = this.#cursor.jobs[jobId];
    if (
      previous !== undefined &&
      previous.lastObservedResetAt !== normalizedResetAt &&
      previous.lastHandledResetAt === normalizedResetAt
    ) {
      // A usage poll started during the heartbeat cycle can complete after the
      // scheduler has already installed the next reset. Its old, just-handled
      // reset must not replace that newer deadline.
      return;
    }
    if (previous?.lastObservedResetAt === normalizedResetAt) {
      if (options.markFreshObservation === true && previous.lastHandledResetAt !== normalizedResetAt) {
        this.#attemptedResets.delete(jobId);
      }
      return;
    }

    this.#cursor.jobs[jobId] = {
      lastObservedResetAt: normalizedResetAt,
      lastHandledResetAt: previous?.lastHandledResetAt ?? null,
    };
    this.#attemptedResets.delete(jobId);
    await this.#persist();
  }

  tick(): Promise<readonly SchedulerTickResult[]> {
    this.#assertInitialized();
    if (this.#tickPromise !== undefined) return this.#tickPromise;
    const promise = this.#enqueueMutation(() => this.#runTick());
    this.#tickPromise = promise;
    const clearTick = () => {
      if (this.#tickPromise === promise) this.#tickPromise = undefined;
    };
    void promise.then(clearTick, clearTick);
    return promise;
  }

  async #runTick(): Promise<readonly SchedulerTickResult[]> {
    const results: SchedulerTickResult[] = [];
    for (const job of this.#jobs) {
      if (!job.enabled) continue;
      const cursor = this.#cursor.jobs[job.id];
      if (cursor === undefined) continue;
      if (cursor.lastHandledResetAt === cursor.lastObservedResetAt) continue;
      if (this.#attemptedResets.get(job.id) === cursor.lastObservedResetAt) continue;

      const eligibleAt = calculateResetEligibleAt(
        cursor.lastObservedResetAt,
        job.offsetMinutes,
      ).getTime();
      if (this.#now().getTime() < eligibleAt) continue;

      const eligibleResetAt = cursor.lastObservedResetAt;
      this.#attemptedResets.set(job.id, eligibleResetAt);
      let verification: ResetVerification;
      try {
        verification = await this.#callbacks.refreshUsage(job, eligibleResetAt);
      } catch (error: unknown) {
        results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "verification_failed", error });
        continue;
      }

      if (!verification.identityMatches) {
        results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "identity_mismatch" });
        continue;
      }
      if (verification.resetAt === null) {
        results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "reset_unavailable" });
        continue;
      }

      const verifiedResetAt = normalizeTimestamp(verification.resetAt);
      if (verifiedResetAt !== eligibleResetAt) {
        await this.#observeReset(job.id, verifiedResetAt, {});
        results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "reset_changed" });
        continue;
      }

      // Claim the exact provider reset before making an ambiguous external
      // request. A timeout or lost response must never cause an automatic retry.
      this.#cursor.jobs[job.id] = {
        lastObservedResetAt: eligibleResetAt,
        lastHandledResetAt: eligibleResetAt,
      };
      await this.#persist();

      try {
        await this.#callbacks.runHeartbeat(job);
      } catch (error: unknown) {
        results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "heartbeat_failed", error });
        continue;
      }

      const fallbackDurationMinutes = validDurationMinutes(verification.durationMinutes);
      const heartbeatCompletedAt = this.#now();
      try {
        const refreshed = await this.#callbacks.refreshUsage(job, eligibleResetAt);
        if (refreshed.identityMatches && refreshed.resetAt !== null) {
          const refreshedResetAt = normalizeTimestamp(refreshed.resetAt);
          if (refreshedResetAt !== eligibleResetAt) {
            await this.#observeReset(job.id, refreshedResetAt, {});
            results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "heartbeat_succeeded" });
            continue;
          }
        }
        const durationMinutes = validDurationMinutes(refreshed.durationMinutes) ?? fallbackDurationMinutes;
        if (durationMinutes !== null) {
          await this.#observeReset(
            job.id,
            calculateEstimatedResetAt(heartbeatCompletedAt, durationMinutes).toISOString(),
            {},
          );
          results.push({
            jobId: job.id,
            resetAt: eligibleResetAt,
            outcome: "heartbeat_succeeded_estimated_reset",
          });
          continue;
        }
      } catch (error: unknown) {
        if (fallbackDurationMinutes !== null) {
          await this.#observeReset(
            job.id,
            calculateEstimatedResetAt(heartbeatCompletedAt, fallbackDurationMinutes).toISOString(),
            {},
          );
        }
        results.push({
          jobId: job.id,
          resetAt: eligibleResetAt,
          outcome: "heartbeat_succeeded_refresh_failed",
          error,
        });
        continue;
      }
      results.push({ jobId: job.id, resetAt: eligibleResetAt, outcome: "heartbeat_succeeded" });
    }
    return results;
  }

  async #persist(): Promise<void> {
    await writeSchedulerCursorAtomic(this.#stateFile, this.#cursor);
  }

  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("ResetAwareScheduler must be initialized before use");
  }
}

export function calculateResetEligibleAt(resetAt: string, offsetMinutes: number): Date {
  if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes < 0) {
    throw new TypeError("offsetMinutes must be a non-negative integer");
  }
  return new Date(Date.parse(normalizeTimestamp(resetAt)) + offsetMinutes * 60_000);
}

export function calculateEstimatedResetAt(
  heartbeatCompletedAt: Date,
  durationMinutes: number,
): Date {
  const normalizedDuration = validDurationMinutes(durationMinutes);
  if (normalizedDuration === null) {
    throw new TypeError("durationMinutes must be a positive integer");
  }
  return new Date(heartbeatCompletedAt.getTime() + normalizedDuration * 60_000);
}

function validDurationMinutes(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`Invalid reset timestamp: ${value}`);
  return new Date(milliseconds).toISOString();
}
