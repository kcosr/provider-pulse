import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { ObservedIdentity, UsageBalance, UsageWindow } from "../types.js";

const FIREWORKS_API_BASE = "https://api.fireworks.ai/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UNLIMITED_MONTHLY_SPEND_SENTINEL = 9_999_999;

const accountSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  state: z.string(),
  status: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
  suspendState: z.string(),
});

const quotaSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  maxValue: z.string(),
  usage: z.number().finite(),
  updateTime: z.string().datetime({ offset: true }).optional(),
});

const quotasSchema = z.object({
  quotas: z.array(quotaSchema),
});

const moneySchema = z.object({
  currencyCode: z.string().min(1),
  units: z.string().regex(/^-?\d+$/u),
  nanos: z.number().int().min(-999_999_999).max(999_999_999),
});

const billingSummarySchema = z.object({
  lineItems: z.array(z.object({ totalCost: moneySchema })),
});

type FireworksFetch = typeof fetch;

export interface FireworksProbeOptions {
  credentialFile: string;
  accountId: string;
  fetchImplementation?: FireworksFetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface FireworksProbeResult {
  identity: ObservedIdentity;
  observedAt: string;
  windows: UsageWindow[];
  balances: UsageBalance[];
  adapter: "fireworks-api";
  adapterVersion: 1;
}

export type FireworksProbeErrorCode =
  | "auth_required"
  | "fireworks_account_unavailable"
  | "usage_parse_failed"
  | "usage_probe_failed"
  | "usage_probe_timeout";

export class FireworksProbeError extends Error {
  readonly code: FireworksProbeErrorCode;

  constructor(code: FireworksProbeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FireworksProbeError";
    this.code = code;
  }
}

export async function probeFireworksUsage(
  options: FireworksProbeOptions,
): Promise<FireworksProbeResult> {
  const apiKey = await loadApiKey(options.credentialFile);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const accountId = options.accountId.trim();
  if (accountId.length === 0) {
    throw new FireworksProbeError("usage_probe_failed", "Fireworks account ID is empty");
  }

  const encodedAccountId = encodeURIComponent(accountId);
  const observedAt = (options.now ?? (() => new Date()))();
  const billingPeriod = utcMonthRange(observedAt);
  const billingUrl = new URL(
    `${FIREWORKS_API_BASE}/accounts/${encodedAccountId}/billing/summary`,
  );
  billingUrl.searchParams.set("startTime", billingPeriod.start.toISOString());
  billingUrl.searchParams.set("endTime", billingPeriod.end.toISOString());
  let accountValue: unknown;
  let quotasValue: unknown;
  let billingValue: unknown;
  try {
    [accountValue, quotasValue, billingValue] = await Promise.all([
      fetchJson(
        fetchImplementation,
        `${FIREWORKS_API_BASE}/accounts/${encodedAccountId}`,
        apiKey,
        timeoutMs,
      ),
      fetchJson(
        fetchImplementation,
        `${FIREWORKS_API_BASE}/accounts/${encodedAccountId}/quotas`,
        apiKey,
        timeoutMs,
      ),
      fetchJson(fetchImplementation, billingUrl.href, apiKey, timeoutMs),
    ]);
  } catch (error) {
    if (error instanceof FireworksProbeError) throw error;
    if (isTimeoutError(error)) {
      throw new FireworksProbeError(
        "usage_probe_timeout",
        "Fireworks usage request timed out",
        { cause: error },
      );
    }
    throw new FireworksProbeError(
      "usage_probe_failed",
      "Fireworks usage request failed",
      { cause: error },
    );
  }

  const account = parseResponse(accountSchema, accountValue, "account");
  const quotaResponse = parseResponse(quotasSchema, quotasValue, "quota");
  const billingSummary = parseResponse(billingSummarySchema, billingValue, "billing");
  const observedAccountId = resourceId(account.name, "accounts");
  if (observedAccountId !== accountId) {
    throw new FireworksProbeError(
      "usage_parse_failed",
      "Fireworks returned a different account than requested",
    );
  }
  if (
    account.state !== "READY" ||
    account.suspendState !== "UNSUSPENDED" ||
    (account.status !== undefined && account.status.code !== "OK")
  ) {
    throw new FireworksProbeError(
      "fireworks_account_unavailable",
      `Fireworks account is unavailable (${account.suspendState})`,
    );
  }

  const monthlySpend = sumBillingCosts(billingSummary.lineItems);
  const normalized = normalizeQuotas(quotaResponse.quotas, accountId, monthlySpend);
  return {
    identity: {
      email: account.email,
      accountId: observedAccountId,
      ...(account.displayName === undefined || account.displayName.trim() === ""
        ? {}
        : { organizationName: account.displayName.trim() }),
      authMethod: "api-key",
    },
    observedAt: observedAt.toISOString(),
    windows: normalized.windows,
    balances: normalized.balances,
    adapter: "fireworks-api",
    adapterVersion: 1,
  };
}

async function loadApiKey(credentialFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(credentialFile, "utf8");
  } catch (error) {
    throw new FireworksProbeError(
      "auth_required",
      "Fireworks API credential is unavailable",
      { cause: error },
    );
  }
  const apiKey = raw.trim();
  if (apiKey.length < 16 || apiKey.length > 4096 || /\s/u.test(apiKey)) {
    throw new FireworksProbeError("auth_required", "Fireworks API credential is invalid");
  }
  return apiKey;
}

async function fetchJson(
  fetchImplementation: FireworksFetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new FireworksProbeError("auth_required", "Fireworks rejected the API credential");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FireworksProbeError(
      "usage_probe_failed",
      `Fireworks usage request failed with HTTP ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FireworksProbeError("usage_parse_failed", "Fireworks response exceeded the size limit");
  }
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FireworksProbeError(
      "usage_parse_failed",
      "Fireworks returned invalid JSON",
      { cause: error },
    );
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new FireworksProbeError(
          "usage_parse_failed",
          "Fireworks response exceeded the size limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, kind: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FireworksProbeError(
      "usage_parse_failed",
      `Fireworks ${kind} response did not match the supported schema`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function resourceId(resourceName: string, collection: string): string {
  const prefix = `${collection}/`;
  if (!resourceName.startsWith(prefix) || resourceName.length === prefix.length) {
    throw new FireworksProbeError("usage_parse_failed", "Fireworks returned an invalid resource name");
  }
  return resourceName.slice(prefix.length);
}

function normalizeQuotas(
  quotas: z.infer<typeof quotaSchema>[],
  accountId: string,
  monthlySpend: number,
): {
  windows: UsageWindow[];
  balances: UsageBalance[];
} {
  const prefix = `accounts/${accountId}/quotas/`;
  const byId = new Map(quotas.map((quota) => {
    if (!quota.name.startsWith(prefix) || quota.name.length === prefix.length) {
      throw new FireworksProbeError(
        "usage_parse_failed",
        "Fireworks returned a quota for a different account",
      );
    }
    return [quota.name.slice(prefix.length), quota];
  }));
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];

  const monthlySpendQuota = byId.get("monthly-spend-usd");
  if (monthlySpendQuota !== undefined) {
    const configuredLimit = decimal(monthlySpendQuota.value);
    const maximumLimit = decimal(monthlySpendQuota.maxValue);
    const unlimited = configuredLimit !== null && maximumLimit !== null &&
      configuredLimit >= UNLIMITED_MONTHLY_SPEND_SENTINEL &&
      maximumLimit >= UNLIMITED_MONTHLY_SPEND_SENTINEL;
    balances.push({
      id: "monthly-spend",
      label: "Monthly spend",
      amount: monthlySpend,
      currency: "USD",
      used: String(monthlySpend),
      ...(configuredLimit === null ? {} : { limit: String(configuredLimit) }),
      ...(unlimited ? { unlimited: true } : {}),
    });
    if (!unlimited && configuredLimit !== null && configuredLimit > 0) {
      const usedPercent = clampPercent(monthlySpend / configuredLimit * 100);
      windows.push({
        id: "monthly-budget",
        label: "Monthly budget",
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        reached: monthlySpend >= configuredLimit,
      });
    }
  } else {
    balances.push({
      id: "monthly-spend",
      label: "Monthly spend",
      amount: monthlySpend,
      currency: "USD",
      used: String(monthlySpend),
    });
  }

  balances.push({
    id: "prepaid-balance",
    label: "Prepaid credits",
    unit: "Web only",
  });
  return { windows, balances };
}

function sumBillingCosts(
  lineItems: z.infer<typeof billingSummarySchema>["lineItems"],
): number {
  let total = 0;
  for (const lineItem of lineItems) {
    if (lineItem.totalCost.currencyCode !== "USD") {
      throw new FireworksProbeError(
        "usage_parse_failed",
        "Fireworks billing response used an unsupported currency",
      );
    }
    const units = Number(lineItem.totalCost.units);
    const value = units + lineItem.totalCost.nanos / 1_000_000_000;
    if (!Number.isSafeInteger(units) || !Number.isFinite(value)) {
      throw new FireworksProbeError(
        "usage_parse_failed",
        "Fireworks billing response contained an invalid amount",
      );
    }
    total += value;
  }
  return total;
}

function utcMonthRange(value: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)),
    end: new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)),
  };
}

function decimal(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
