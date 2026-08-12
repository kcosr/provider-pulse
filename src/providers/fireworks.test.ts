import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FireworksProbeError, probeFireworksUsage } from "./fireworks.js";

const ACCOUNT = {
  email: "person@example.com",
  name: "accounts/account-one",
  displayName: "Personal",
  state: "READY",
  status: { code: "OK", message: "" },
  suspendState: "UNSUSPENDED",
};

describe("probeFireworksUsage", () => {
  it("normalizes account identity, exact monthly spend, and web-only prepaid credits", async () => {
    await withCredential(async (credentialFile) => {
      const fetchImplementation = responseRouter({
        account: ACCOUNT,
        quotas: {
          quotas: [
            quota("serverless-inference-rpm", "20000", 5000),
            quota("monthly-spend-usd", "9999999", 376.48),
            quota("training-h100-count", "16", 0),
          ],
        },
        billing: billingSummary(376.481037696),
      });

      const result = await probeFireworksUsage({
        credentialFile,
        accountId: "account-one",
        fetchImplementation,
        now: () => new Date("2026-08-12T05:00:00Z"),
      });

      expect(result.identity).toEqual({
        email: "person@example.com",
        accountId: "account-one",
        organizationName: "Personal",
        authMethod: "api-key",
      });
      expect(result.windows).toEqual([]);
      expect(result.balances).toEqual([
        expect.objectContaining({
          id: "monthly-spend",
          amount: 376.481037696,
          currency: "USD",
          unlimited: true,
        }),
        { id: "prepaid-balance", label: "Prepaid credits", unit: "Web only" },
      ]);
      expect(result.observedAt).toBe("2026-08-12T05:00:00.000Z");
      expect(fetchImplementation).toHaveBeenCalledTimes(3);
      expect(fetchImplementation).toHaveBeenCalledWith(
        expect.stringContaining("/billing/summary?startTime=2026-08-01T00%3A00%3A00.000Z&endTime=2026-09-01T00%3A00%3A00.000Z"),
        expect.anything(),
      );
    });
  });

  it("reports normalized remaining monthly budget for a finite spend limit", async () => {
    await withCredential(async (credentialFile) => {
      const result = await probeFireworksUsage({
        credentialFile,
        accountId: "account-one",
        fetchImplementation: responseRouter({
          account: ACCOUNT,
          quotas: { quotas: [quota("monthly-spend-usd", "500", 125)] },
          billing: billingSummary(125),
        }),
      });

      expect(result.windows).toContainEqual({
        id: "monthly-budget",
        label: "Monthly budget",
        usedPercent: 25,
        remainingPercent: 75,
        reached: false,
      });
    });
  });

  it("maps rejected credentials to auth_required without exposing the key", async () => {
    await withCredential(async (credentialFile, apiKey) => {
      const fetchImplementation = vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 }));

      const error = await probeFireworksUsage({
        credentialFile,
        accountId: "account-one",
        fetchImplementation,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(FireworksProbeError);
      expect(error).toMatchObject({ code: "auth_required" });
      expect(String(error)).not.toContain(apiKey);
      expect(String(error)).not.toContain(credentialFile);
    });
  });

  it("fails explicitly when the provider response schema drifts", async () => {
    await withCredential(async (credentialFile) => {
      const error = await probeFireworksUsage({
        credentialFile,
        accountId: "account-one",
        fetchImplementation: responseRouter({
          account: { ...ACCOUNT, email: 123 },
          quotas: { quotas: [] },
          billing: billingSummary(0),
        }),
      }).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ code: "usage_parse_failed" });
    });
  });

  it("rejects an oversized streamed response", async () => {
    await withCredential(async (credentialFile) => {
      const oversized = "x".repeat(1024 * 1024 + 1);
      const error = await probeFireworksUsage({
        credentialFile,
        accountId: "account-one",
        fetchImplementation: vi.fn<typeof fetch>(async () =>
          new Response(oversized, { status: 200 })),
      }).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ code: "usage_parse_failed" });
    });
  });
});

function responseRouter(values: { account: unknown; quotas: unknown; billing: unknown }): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes("/billing/summary")
      ? values.billing
      : url.endsWith("/quotas")
        ? values.quotas
        : values.account;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function billingSummary(amount: number) {
  const units = Math.trunc(amount);
  const nanos = Math.round((amount - units) * 1_000_000_000);
  return {
    lineItems: [{
      totalCost: { currencyCode: "USD", units: String(units), nanos },
    }],
    usageBuckets: [],
  };
}

function quota(id: string, value: string, usage: number) {
  return {
    name: `accounts/account-one/quotas/${id}`,
    value,
    maxValue: value,
    usage,
    updateTime: "2026-08-12T04:47:05.220833Z",
  };
}

async function withCredential(
  action: (credentialFile: string, apiKey: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "provider-pulse-fireworks-"));
  const credentialFile = join(directory, "api-key");
  const apiKey = "fw_test_key_never_log";
  try {
    await writeFile(credentialFile, `${apiKey}\n`, { mode: 0o600 });
    await action(credentialFile, apiKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
