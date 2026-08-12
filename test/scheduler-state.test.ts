import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptySchedulerCursor,
  loadSchedulerCursor,
  SchedulerStateError,
  writeSchedulerCursorAtomic,
} from "../src/scheduler-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cursorPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "provider-pulse-scheduler-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "scheduler-state.json");
}

describe("scheduler cursor persistence", () => {
  it("returns an empty cursor for a missing file", async () => {
    expect(await loadSchedulerCursor(await cursorPath())).toEqual(emptySchedulerCursor());
  });

  it("atomically writes a restrictive versioned cursor", async () => {
    const path = await cursorPath();
    const cursor = {
      version: 1 as const,
      jobs: {
        weekly: {
          lastObservedResetAt: "2026-08-13T06:31:00.000Z",
          lastHandledResetAt: null,
        },
      },
    };
    await writeSchedulerCursorAtomic(path, cursor);

    expect(await loadSchedulerCursor(path)).toEqual(cursor);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(cursor);
  });

  it("fails closed for corrupt or structurally invalid state", async () => {
    const path = await cursorPath();
    await writeSchedulerCursorAtomic(path, emptySchedulerCursor());
    await writeFile(path, "not-json", { encoding: "utf8", mode: 0o600 });
    await expect(loadSchedulerCursor(path)).rejects.toBeInstanceOf(SchedulerStateError);

    await writeFile(path, JSON.stringify({ version: 1, jobs: {}, surprise: true }), "utf8");
    await expect(loadSchedulerCursor(path)).rejects.toMatchObject({ code: "scheduler_state_invalid" });
  });
});
