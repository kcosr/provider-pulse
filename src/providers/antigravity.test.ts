import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessRunError, type runProcess } from "../process-runner.js";
import { parseAntigravityUsage, probeAntigravityUsage } from "./antigravity.js";

const report = readFileSync(new URL("./fixtures/antigravity-usage-1.5.15.tsv", import.meta.url), "utf8");
const observedAt = new Date("2026-11-23T18:32:14Z");
const surface = { executable: "/opt/bin/agy", home: "/profile", probeDirectory: "/probes" };
const ok = { exitCode: 0, signal: null, stderr: "", durationMs: 10 } as const;

afterEach(() => vi.unstubAllEnvs());

describe("Antigravity usage", () => {
  it("keeps Gemini weekly first and retains every reported quota window", () => {
    const reordered = report.trimEnd().split("\n").reverse().join("\n");
    const windows = parseAntigravityUsage(reordered, observedAt);
    expect(windows).toEqual([
      { id: "gemini:weekly", label: "Gemini Models · Weekly", remainingPercent: 16, durationMinutes: 10_080, resetsAt: "2026-11-29T08:00:12.000Z" },
      { id: "gemini:five-hour", label: "Gemini Models · Five-hour", remainingPercent: 63, durationMinutes: 300, resetsAt: "2026-11-23T21:54:36.000Z" },
      { id: "claude-gpt:weekly", label: "Claude and GPT models · Weekly", remainingPercent: 100, durationMinutes: 10_080, resetsAt: "2026-11-29T14:02:47.000Z" },
      { id: "claude-gpt:five-hour", label: "Claude and GPT models · Five-hour", remainingPercent: 100, durationMinutes: 300 },
      { id: "gemini-4-argon:weekly", label: "Gemini 4 Argon · Weekly", remainingPercent: 100, durationMinutes: 10_080 },
    ]);
    expect(parseAntigravityUsage(report.split("\n").slice(0, 2).join("\n"), observedAt)).toEqual(windows.slice(0, 2));
  });

  it("keeps named quota groups through cosmetic changes and skips unrelated meters", () => {
    const variant = report.replaceAll("Gemini Models\t", "Gemini Models – Pro\t")
      .replaceAll("Claude and GPT models\t", "Claude & GPT Models\t") +
      "Gemini 4 Argon\tGemini 4 Argon Five Hour Limit\t50%\t2026-11-23T19:00:00Z\n" +
      "Gemini Models – Pro\tMonthly credit balance\t5\t\n";
    const windows = parseAntigravityUsage(variant, observedAt);
    expect(windows[0]?.id).toBe("gemini:weekly");
    expect(windows[2]?.id).toBe("claude-gpt:weekly");
    expect(windows.at(-1)).toMatchObject({ id: "gemini-4-argon:five-hour", remainingPercent: 50 });
    expect(windows).toHaveLength(6);
  });

  it("keeps a decorated group distinct when the main Gemini group is also reported", () => {
    const variant = "Gemini Models (Pro)\tWeekly Limit Remaining\t42%\t2026-11-29T10:00:00Z\n" + report;
    const windows = parseAntigravityUsage(variant, observedAt);
    expect(windows[0]).toMatchObject({ id: "gemini:weekly", remainingPercent: 16 });
    expect(windows.find(w => w.id === "gemini-models-pro:weekly")?.remainingPercent).toBe(42);
  });

  it("omits a full window's moving deadline within clock tolerance and retains active resets", () => {
    const laterClock = new Date("2026-11-23T18:33:25Z");
    const active = report.replace("2026-11-23T23:32:13Z", "2026-11-23T23:31:24Z");
    expect(parseAntigravityUsage(report, laterClock).find(w => w.id === "claude-gpt:five-hour")?.resetsAt).toBeUndefined();
    expect(parseAntigravityUsage(active, laterClock).find(w => w.id === "claude-gpt:five-hour")?.resetsAt).toBe("2026-11-23T23:31:24.000Z");
  });

  it.each([
    report.split("\n").slice(1).join("\n"),
    report + report.split("\n")[0],
    report.replace("16%", "116%"),
    report.replace("2026-11-29", "2026-11-31"),
    "Authentication required",
  ])("rejects missing, duplicate, malformed, and non-usage output (%#)", (input) => {
    expect(() => parseAntigravityUsage(input, observedAt)).toThrowError(expect.objectContaining({ code: "usage_parse_failed" }));
  });

  it.each(["1.1.11", "1.5.15", "2.0.0"])("runs the standalone quota command using the isolated monitoring home with agy %s", async (cliVersion) => {
    vi.stubEnv("GEMINI_API_KEY", "ambient-gemini-key");
    vi.stubEnv("GOOGLE_API_KEY", "ambient-google-key");
    const run = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce({ ...ok, stdout: `${cliVersion}\n` })
      .mockResolvedValueOnce({ ...ok, stdout: report });
    const result = await probeAntigravityUsage(surface, run, () => observedAt);
    expect(result.cliVersion).toBe(cliVersion);
    expect(result.snapshot.windows[0]?.id).toBe("gemini:weekly");
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({ args: ["--version"], cwd: "/probes" }));
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      executable: "/opt/bin/agy",
      cwd: "/probes",
      args: expect.arrayContaining(["-p", "/usage", "--output-format", "text"]),
      env: expect.objectContaining({ HOME: "/profile", AGY_CLI_DISABLE_AUTO_UPDATE: "1" }),
      abortOnOutput: "Authentication required",
    }));
    for (const [request] of run.mock.calls) {
      expect(request.env?.HOME).toBe("/profile");
      expect(request.env).not.toHaveProperty("GEMINI_API_KEY");
      expect(request.env).not.toHaveProperty("GOOGLE_API_KEY");
    }
  });

  it("rejects older CLI versions before invoking print mode", async () => {
    const run = vi.fn<typeof runProcess>().mockResolvedValue({ ...ok, stdout: "1.1.10\n" });
    await expect(probeAntigravityUsage(surface, run)).rejects.toMatchObject({ code: "unsupported_cli_version" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("maps the stopped login prompt to an actionable auth error", async () => {
    const run = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce({ ...ok, stdout: "1.5.15\n" })
      .mockRejectedValueOnce(new ProcessRunError("process_output_stop", "Stopped"));
    await expect(probeAntigravityUsage(surface, run)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("keeps a nonzero usage exit distinct from authentication failure", async () => {
    const run = vi.fn<typeof runProcess>()
      .mockResolvedValueOnce({ ...ok, stdout: "1.5.15\n" })
      .mockResolvedValueOnce({ ...ok, exitCode: 2, stdout: report, stderr: "private CLI output" });
    await expect(probeAntigravityUsage(surface, run)).rejects.toMatchObject({
      code: "usage_probe_failed",
      message: "Antigravity CLI did not return a usage report",
    });
  });
});
