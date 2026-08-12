import { describe, expect, it } from "vitest";

import { ProcessRunError, runProcess } from "./process-runner.js";

describe("runProcess", () => {
  it("passes literal arguments without a shell and captures bounded output", async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "$(touch /tmp/not-executed)"],
      timeoutMs: 2_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("$(touch /tmp/not-executed)");
  });

  it("fails closed when output exceeds the configured limit", async () => {
    await expect(
      runProcess({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(10000))"],
        timeoutMs: 2_000,
        outputLimitBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "process_output_limit" } satisfies Partial<ProcessRunError>);
  });

  it("terminates a timed-out process", async () => {
    await expect(
      runProcess({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 20,
        terminationGraceMs: 20,
      }),
    ).rejects.toMatchObject({ code: "process_timeout" } satisfies Partial<ProcessRunError>);
  });
});
