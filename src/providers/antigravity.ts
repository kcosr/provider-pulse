import { ProcessRunError, runProcess } from "../process-runner.js";
import { isolatedProcessEnvironment } from "../terminal/tmux.js";
import type { UsageSnapshot, UsageWindow } from "../types.js";

const WEEK_MINUTES = 7 * 24 * 60;
const FIVE_HOUR_MINUTES = 5 * 60;
const RESET_CLOCK_TOLERANCE_MS = 2 * 60_000;
const AUTH_PROMPT = "Authentication required";
const GEMINI_WEEKLY_ID = "gemini:weekly";
const WINDOW_ORDER = [GEMINI_WEEKLY_ID, "gemini:five-hour", "claude-gpt:weekly", "claude-gpt:five-hour"];

class AntigravityUsageError extends Error {
  readonly code: "auth_required" | "unsupported_cli_version" | "usage_probe_failed" | "usage_parse_failed";

  constructor(code: AntigravityUsageError["code"], message: string) {
    super(message);
    this.name = "AntigravityUsageError";
    this.code = code;
  }
}

export async function probeAntigravityUsage(
  surface: { executable: string; home: string; probeDirectory: string },
  run: typeof runProcess = runProcess,
  now: () => Date = () => new Date(),
): Promise<{ snapshot: UsageSnapshot; cliVersion: string }> {
  const processSpec = {
    executable: surface.executable,
    cwd: surface.probeDirectory,
    env: {
      ...isolatedProcessEnvironment(),
      HOME: surface.home,
      NO_COLOR: "1",
      TERM: "dumb",
      BROWSER: "false",
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    },
    timeoutMs: 40_000,
    outputLimitBytes: 32 * 1024,
  };
  const version = await run({ ...processSpec, args: ["--version"], timeoutMs: 5_000 });
  const cliVersion = version.stdout.trim();
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[\w.-]{1,64})?$/.exec(cliVersion);
  const [major, minor, patch] = (match?.slice(1, 4) ?? []).map(Number);
  const supported = major !== undefined && minor !== undefined && patch !== undefined && (
    major > 1 || (major === 1 && (minor > 1 || (minor === 1 &&
      (patch > 11 || (patch === 11 && match?.[4] === undefined)))))
  );
  if (version.exitCode !== 0 || !supported) {
    throw new AntigravityUsageError("unsupported_cli_version", "Antigravity usage requires agy 1.1.11 or newer for the headless quota report");
  }

  try {
    const report = await run({
      ...processSpec,
      args: [
        "--settings", '{"disableSlashCommands":false,"useG1Credits":false}',
        "-p", "/usage", "--output-format", "text",
      ],
      abortOnOutput: AUTH_PROMPT,
    });
    if (report.exitCode !== 0) {
      throw new AntigravityUsageError("usage_probe_failed", "Antigravity CLI did not return a usage report");
    }
    const observedAt = now();
    return { cliVersion, snapshot: { observedAt: observedAt.toISOString(), windows: parseAntigravityUsage(report.stdout, observedAt), balances: [] } };
  } catch (error) {
    if (error instanceof ProcessRunError && error.code === "process_output_stop") {
      throw new AntigravityUsageError("auth_required", "Sign in to the configured Antigravity monitoring profile");
    }
    throw error;
  }
}

export function parseAntigravityUsage(report: string, observedAt: Date): UsageWindow[] {
  const rows = report.split(/\r?\n/).filter((row) => row.trim()).map((row) => row.split("\t"));
  const groupNames = new Set(rows.map(([group]) => group?.trim().toLowerCase()));
  const windows = new Map<string, UsageWindow>();
  for (const [group, meter, percentage, reset, extra] of rows) {
    if (group === undefined || meter === undefined || percentage === undefined || reset === undefined || extra !== undefined) {
      throw invalidReport();
    }
    const name = group.trim();
    const lowerName = name.toLowerCase();
    const meterName = meter.trim().toLowerCase();
    const limit = (meterName.startsWith(`${lowerName} `) ? meterName.slice(lowerName.length + 1) : meterName)
      .replace(/ remaining$/, "");
    const weekly = limit === "weekly limit";
    if (!weekly && limit !== "five hour limit") continue;
    const groupId = quotaGroupId(lowerName, groupNames);
    const id = `${groupId}:${weekly ? "weekly" : "five-hour"}`;
    const durationMinutes = weekly ? WEEK_MINUTES : FIVE_HOUR_MINUTES;
    const percent = percentage.trim();
    const remainingPercent = Number(percent.slice(0, -1));
    if (!groupId || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name) ||
        windows.has(id) || !/^\d{1,3}(?:\.\d+)?%$/.test(percent) || remainingPercent > 100) {
      throw invalidReport();
    }

    const timestamp = reset.trim();
    const resetAt = timestamp ? parseReset(timestamp) : undefined;
    // An unused bucket's deadline moves with the report clock. Leave room for
    // refresh latency and clock skew so successive polls preserve its baseline.
    const inactiveDeadline = remainingPercent === 100 && resetAt !== undefined &&
      Math.abs(resetAt.getTime() - observedAt.getTime() - durationMinutes * 60_000) <= RESET_CLOCK_TOLERANCE_MS;
    windows.set(id, {
      id,
      label: `${name} · ${weekly ? "Weekly" : "Five-hour"}`,
      remainingPercent,
      durationMinutes,
      ...(resetAt === undefined || inactiveDeadline ? {} : { resetsAt: resetAt.toISOString() }),
    });
  }

  if (!windows.has(GEMINI_WEEKLY_ID)) throw invalidReport();
  const preferred: UsageWindow[] = [];
  for (const id of WINDOW_ORDER) {
    const window = windows.get(id);
    if (window !== undefined) preferred.push(window);
    windows.delete(id);
  }
  return [...preferred, ...windows.values()];
}

function quotaGroupId(name: string, names: ReadonlySet<string | undefined>): string {
  // A decorated label can stand in for the main group if the bare group is
  // absent. When both are reported, keep their windows distinct.
  if (name === "gemini models" || (!names.has("gemini models") && /^gemini models\s*[(:–—-]/.test(name))) {
    return "gemini";
  }
  if (name === "claude and gpt models" || (!names.has("claude and gpt models") &&
      /^claude (?:and|&) gpt models(?:\s*[(:–—-]|$)/.test(name))) {
    return "claude-gpt";
  }
  return name.replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseReset(value: string): Date {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (match === null) throw invalidReport();
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw invalidReport();
  return date;
}

function invalidReport(): AntigravityUsageError {
  return new AntigravityUsageError("usage_parse_failed", "Antigravity CLI returned an unsupported usage report");
}
