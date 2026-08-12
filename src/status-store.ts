import type {
  AccountStatus,
  AppConfig,
  HealthState,
  HeartbeatStatus,
  ProviderPulseStatus,
} from "./types.js";

export class StatusStore {
  readonly #accounts: Map<string, AccountStatus>;
  readonly #heartbeats: Map<string, HeartbeatStatus>;

  constructor(config: AppConfig) {
    this.#heartbeats = new Map(
      config.heartbeatJobs.map((job) => [
        job.id,
        {
          id: job.id,
          accountId: job.accountId,
          executor: job.executor,
          ...(job.executor === "pi" ? { provider: job.provider } : {}),
          credentialSurfaceId: job.credentialSurfaceId,
          model: job.model,
          reasoning: job.reasoning,
          trigger: structuredClone(job.trigger),
          enabled: job.enabled,
          health: job.enabled ? "unknown" : "disabled",
          inFlight: false,
        },
      ]),
    );

    this.#accounts = new Map(
      config.accounts.map((account) => [
        account.id,
        {
          id: account.id,
          label: account.label,
          provider: account.provider,
          usage: {
            adapter: account.usageSource.adapter,
            credentialSurfaceId: account.usageSource.credentialSurfaceId,
            health: "unknown",
            inFlight: false,
            identity: {
              ...(account.expectedIdentity === undefined
                ? {}
                : { expected: structuredClone(account.expectedIdentity) }),
              match: "unknown",
            },
          },
          heartbeatIds: config.heartbeatJobs
            .filter((job) => job.accountId === account.id)
            .map((job) => job.id),
        },
      ]),
    );
  }

  getAccount(accountId: string): AccountStatus | undefined {
    return clone(this.#accounts.get(accountId));
  }

  getHeartbeat(heartbeatId: string): HeartbeatStatus | undefined {
    return clone(this.#heartbeats.get(heartbeatId));
  }

  updateAccount(accountId: string, update: (current: AccountStatus) => AccountStatus): AccountStatus {
    const current = this.#accounts.get(accountId);
    if (current === undefined) throw new UnknownStatusTargetError("account", accountId);
    const next = update(structuredClone(current));
    assertStableIdentity(current, next, "account");
    this.#accounts.set(accountId, structuredClone(next));
    return structuredClone(next);
  }

  updateHeartbeat(
    heartbeatId: string,
    update: (current: HeartbeatStatus) => HeartbeatStatus,
  ): HeartbeatStatus {
    const current = this.#heartbeats.get(heartbeatId);
    if (current === undefined) throw new UnknownStatusTargetError("heartbeat", heartbeatId);
    const next = update(structuredClone(current));
    assertStableIdentity(current, next, "heartbeat");
    this.#heartbeats.set(heartbeatId, structuredClone(next));
    return structuredClone(next);
  }

  snapshot(now = new Date()): ProviderPulseStatus {
    const accounts = [...this.#accounts.values()].map((account) => structuredClone(account));
    const heartbeats = [...this.#heartbeats.values()].map((heartbeat) => structuredClone(heartbeat));
    return {
      version: 1,
      generatedAt: now.toISOString(),
      health: aggregateHealth([
        ...accounts.map((account) => account.usage.health),
        ...heartbeats.filter((heartbeat) => heartbeat.enabled).map((heartbeat) => heartbeat.health),
      ]),
      accounts,
      heartbeats,
    };
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function assertStableIdentity(
  current: { id: string },
  next: { id: string },
  kind: "account" | "heartbeat",
): void {
  if (current.id !== next.id) throw new Error(`${kind} status update cannot change its ID`);
}

export function aggregateHealth(states: readonly HealthState[]): HealthState {
  const active = states.filter((state) => state !== "disabled");
  if (active.some((state) => state === "unhealthy")) return "unhealthy";
  if (active.some((state) => state === "stale")) return "stale";
  if (active.some((state) => state === "running")) return "running";
  if (active.length > 0 && active.every((state) => state === "healthy")) return "healthy";
  return "unknown";
}

export class UnknownStatusTargetError extends Error {
  constructor(kind: "account" | "heartbeat", id: string) {
    super(`Unknown ${kind}: ${id}`);
    this.name = "UnknownStatusTargetError";
  }
}
