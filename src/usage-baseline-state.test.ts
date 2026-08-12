import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  emptyUsageBaselineState,
  loadUsageBaselineState,
  UsageBaselineStateError,
  writeUsageBaselineStateAtomic,
} from "./usage-baseline-state.js";

describe("usage baseline state", () => {
  it("starts empty when the file does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-pulse-baseline-"));
    await expect(loadUsageBaselineState(join(directory, "missing.json")))
      .resolves.toEqual(emptyUsageBaselineState());
  });

  it("writes and reloads an owner-only atomic snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-pulse-baseline-"));
    const filePath = join(directory, "usage-baseline.json");
    const state = {
      version: 1 as const,
      updatedAt: "2026-08-12T20:00:00.000Z",
      metrics: [{
        accountId: "claude-one",
        metricKind: "window" as const,
        metricId: "weekly",
        remainingPercent: 72,
        resetAt: "2026-08-17T20:00:00.000Z",
        capturedAt: "2026-08-12T20:00:00.000Z",
      }],
    };

    await writeUsageBaselineStateAtomic(filePath, state);

    expect(await loadUsageBaselineState(filePath)).toEqual(state);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects corrupt or duplicate state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-pulse-baseline-"));
    const filePath = join(directory, "usage-baseline.json");
    await writeFile(filePath, "not-json");
    await expect(loadUsageBaselineState(filePath)).rejects.toBeInstanceOf(UsageBaselineStateError);

    const metric = {
      accountId: "one",
      metricKind: "window",
      metricId: "weekly",
      remainingPercent: 50,
      resetAt: null,
      capturedAt: "2026-08-12T20:00:00.000Z",
    };
    await writeFile(filePath, JSON.stringify({
      version: 1,
      updatedAt: "2026-08-12T20:00:00.000Z",
      metrics: [metric, metric],
    }));
    await expect(loadUsageBaselineState(filePath)).rejects.toBeInstanceOf(UsageBaselineStateError);
  });
});
