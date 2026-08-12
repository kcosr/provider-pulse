export const PROVIDERS = ["codex", "claude", "grok", "fireworks"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const HEARTBEAT_EXECUTORS = [
  "native-codex",
  "native-claude",
  "native-grok",
  "pi",
] as const;
export type HeartbeatExecutor = (typeof HEARTBEAT_EXECUTORS)[number];

export const CREDENTIAL_SURFACE_KINDS = [
  ...HEARTBEAT_EXECUTORS,
  "fireworks-api",
] as const;
export type CredentialSurfaceKind = (typeof CREDENTIAL_SURFACE_KINDS)[number];

export const USAGE_ADAPTERS = [
  "codex-app-server",
  "claude-tmux",
  "grok-tmux",
  "fireworks-api",
] as const;
export type UsageAdapter = (typeof USAGE_ADAPTERS)[number];

export interface ExpectedIdentity {
  email?: string;
  organizationId?: string;
  accountId?: string;
}

export interface ServerConfig {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
}

export interface PathsConfig {
  stateDirectory: string;
  probeDirectory: string;
}

export interface PollingConfig {
  automaticIntervalMinutes: number | null;
  startupCheck: boolean;
  maxConcurrency: number;
  staleAfterMinutes: number;
}

export interface AccountConfig {
  id: string;
  label: string;
  provider: Provider;
  expectedIdentity?: ExpectedIdentity;
  usageSource: {
    adapter: UsageAdapter;
    credentialSurfaceId: string;
  };
}

export interface CliCredentialSurfaceConfig {
  id: string;
  kind: HeartbeatExecutor;
  home: string;
  executable: string;
}

export interface FireworksApiCredentialSurfaceConfig {
  id: string;
  kind: "fireworks-api";
  credentialFile: string;
}

export type CredentialSurfaceConfig =
  | CliCredentialSurfaceConfig
  | FireworksApiCredentialSurfaceConfig;

export interface AfterResetTriggerConfig {
  type: "after-reset";
  windowId: string;
  offsetMinutes: number;
}

interface HeartbeatJobBase {
  id: string;
  accountId: string;
  credentialSurfaceId: string;
  model: string;
  reasoning: string;
  prompt: string;
  trigger: AfterResetTriggerConfig;
  timeoutSeconds: number;
  enabled: boolean;
}

export type HeartbeatJobConfig =
  | (HeartbeatJobBase & {
      executor: "pi";
      provider: string;
    })
  | (HeartbeatJobBase & {
      executor: Exclude<HeartbeatExecutor, "pi">;
      provider?: never;
    });

export interface AppConfig {
  version: 1;
  server: ServerConfig;
  paths: PathsConfig;
  polling: PollingConfig;
  accounts: AccountConfig[];
  credentialSurfaces: CredentialSurfaceConfig[];
  heartbeatJobs: HeartbeatJobConfig[];
}

export const HEALTH_STATES = [
  "unknown",
  "running",
  "healthy",
  "stale",
  "unhealthy",
  "disabled",
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface StatusError {
  code: string;
  message: string;
}

export interface OperationState {
  health: HealthState;
  inFlight: boolean;
  operationId?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  durationMs?: number;
  error?: StatusError;
}

export interface ObservedIdentity {
  email?: string;
  accountId?: string;
  organizationId?: string;
  organizationName?: string;
  plan?: string;
  subscriptionType?: string;
  authMethod?: string;
}

export interface IdentityStatus {
  expected?: ExpectedIdentity;
  observed?: ObservedIdentity;
  match: "unknown" | "matched" | "mismatched";
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  reached?: boolean;
}

export interface UsageBalance {
  id: string;
  label: string;
  amount?: number;
  currency?: string;
  unit?: string;
  unlimited?: boolean;
  limit?: string;
  used?: string;
  remainingPercent?: number;
  resetsAt?: string;
}

export interface UsageSnapshot {
  observedAt: string;
  windows: UsageWindow[];
  balances: UsageBalance[];
}

export interface UsageStatus extends OperationState {
  adapter: UsageAdapter;
  credentialSurfaceId: string;
  identity: IdentityStatus;
  snapshot?: UsageSnapshot;
}

export interface HeartbeatStatus extends OperationState {
  id: string;
  accountId: string;
  executor: HeartbeatExecutor;
  provider?: string;
  credentialSurfaceId: string;
  model: string;
  reasoning: string;
  trigger: AfterResetTriggerConfig;
  enabled: boolean;
  nextEligibleAt?: string;
}

export interface AccountStatus {
  id: string;
  label: string;
  provider: Provider;
  usage: UsageStatus;
  heartbeatIds: string[];
}

export type UsageBaselineMetricKind = "window" | "balance";

export interface UsageBaselineMetric {
  accountId: string;
  metricKind: UsageBaselineMetricKind;
  metricId: string;
  remainingPercent: number;
  resetAt?: string;
  capturedAt: string;
}

export interface UsageBaselineStatus {
  health: "unknown" | "healthy" | "unhealthy";
  updatedAt?: string;
  metrics: UsageBaselineMetric[];
  error?: StatusError;
}

export interface ProviderPulseStatus {
  version: 1;
  generatedAt: string;
  health: HealthState;
  accounts: AccountStatus[];
  heartbeats: HeartbeatStatus[];
  usageBaseline: UsageBaselineStatus;
}

export interface OperationReceipt {
  operationId: string;
  accepted: boolean;
  targetId: string;
  kind: "usage-check" | "heartbeat";
  coalesced: boolean;
}
