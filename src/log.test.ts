import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { JsonlLogger, redact } from "./log.js";

describe("redact", () => {
  it("removes secret fields, bearer values, and configured home paths", () => {
    const value = redact(
      {
        accessToken: "secret-token",
        credentialSurfaceId: "codex-native",
        message: "Bearer abc.def from /private/codex-home",
      },
      ["/private/codex-home"],
    );
    expect(value).toEqual({
      accessToken: "[REDACTED]",
      credentialSurfaceId: "codex-native",
      message: "Bearer [REDACTED] from [REDACTED]",
    });
  });
});

describe("JsonlLogger", () => {
  it("serializes concurrent appends and rotates bounded files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-pulse-log-"));
    try {
      const logger = new JsonlLogger({ directory, maxBytes: 190, maxFiles: 2 });
      await Promise.all(
        ["one", "two", "three"].map((operationId) =>
          logger.append({
            operationId,
            kind: "system",
            outcome: "healthy",
            attemptedAt: "2026-08-11T12:00:00Z",
            details: { message: "x".repeat(50) },
          }),
        ),
      );
      const files = await readdir(directory);
      expect(files.sort()).toEqual(["events.jsonl", "events.jsonl.1"]);
      const active = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(JSON.parse(active.trim())).toMatchObject({ operationId: "three" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
