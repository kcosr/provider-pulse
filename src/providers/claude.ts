import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isolatedProcessEnvironment, type CommandRunner, type TerminalProbe } from "../terminal/tmux.js";

export interface ObservedClaudeIdentity {
  readonly email?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly subscriptionType?: string;
  readonly authMethod?: string;
}

export interface ParsedUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly durationMinutes: number;
  readonly resetsAt: string | null;
}

export interface ClaudeUsageSnapshot {
  readonly adapter: "claude-tmux";
  readonly adapterVersion: 2;
  readonly identity: ObservedClaudeIdentity;
  readonly windows: readonly ParsedUsageWindow[];
}

export interface ClaudeUsageSurface {
  readonly executable: string;
  readonly home: string;
  readonly probeDirectory: string;
}

export class ClaudeAdapterError extends Error {
  public readonly code: "auth_required" | "identity_parse_failed" | "usage_parse_failed";

  public constructor(
    code: "auth_required" | "identity_parse_failed" | "usage_parse_failed",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeAdapterError";
    this.code = code;
  }
}

const AUTH_TIMEOUT_MS = 15_000;
const AUTH_OUTPUT_LIMIT = 128 * 1024;
const USAGE_OUTPUT_LIMIT = 256 * 1024;
const USAGE_CACHE_LIMIT = 256 * 1024;

export class ClaudeUsageAdapter {
  readonly #runner: CommandRunner;
  readonly #terminal: TerminalProbe;
  readonly #now: () => Date;

  public constructor(
    runner: CommandRunner,
    terminal: TerminalProbe,
    now: () => Date = () => new Date(),
  ) {
    this.#runner = runner;
    this.#terminal = terminal;
    this.#now = now;
  }

  public async poll(surface: ClaudeUsageSurface): Promise<ClaudeUsageSnapshot> {
    const identity = await this.#readIdentity(surface);
    const claudeEnvironment = environmentForClaudeHome(surface.home);
    const probe = await this.#terminal.probe({
      sessionPrefix: "provider-pulse-claude",
      executable: surface.executable,
      args: [
        "--permission-mode",
        "plan",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-chrome",
        "--ax-screen-reader",
      ],
      cwd: surface.probeDirectory,
      env: claudeEnvironment,
      command: "/usage",
      isReady: isClaudeReady,
      isComplete: (pane) => canParseClaudeUsage(pane, this.#now()),
      startupActions: [
        {
          id: "accept-default-theme",
          matches: isClaudeThemePicker,
          inputs: [
            { kind: "literal", value: "2" },
            { kind: "key", value: "Enter" },
          ],
        },
        {
          id: "trust-configured-probe-directory",
          matches: isClaudeWorkspaceTrustPrompt,
          inputs: [
            { kind: "literal", value: "y" },
            { kind: "key", value: "Enter" },
          ],
        },
      ],
      startupTimeoutMs: 30_000,
      responseTimeoutMs: 30_000,
      totalTimeoutMs: 70_000,
      maxOutputBytes: USAGE_OUTPUT_LIMIT,
    });

    const terminalWindows = parseClaudeUsage(probe.output, this.#now());
    const cachedWindows = await readClaudeUsageCache(surface.home);
    return {
      adapter: "claude-tmux",
      adapterVersion: 2,
      identity,
      windows: mergeClaudeUsageWindows(terminalWindows, cachedWindows),
    };
  }

  async #readIdentity(surface: ClaudeUsageSurface): Promise<ObservedClaudeIdentity> {
    const result = await this.#runner.run({
      executable: surface.executable,
      args: ["auth", "status", "--json"],
      env: isolatedProcessEnvironment(environmentForClaudeHome(surface.home)),
      clearEnvironment: true,
      timeoutMs: AUTH_TIMEOUT_MS,
      maxOutputBytes: AUTH_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0) {
      throw new ClaudeAdapterError("auth_required", "Claude authentication status is unavailable");
    }
    return parseClaudeIdentity(result.stdout);
  }
}

export function parseClaudeUsageCache(json: string): readonly ParsedUsageWindow[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ClaudeAdapterError("usage_parse_failed", "Claude returned invalid cached usage JSON");
  }
  if (!isRecord(value)) throw new ClaudeAdapterError("usage_parse_failed", "Claude cached usage state is invalid");
  const cache = value["cachedUsageUtilization"];
  if (!isRecord(cache) || !isRecord(cache["utilization"]) || !Array.isArray(cache["utilization"]["limits"])) {
    return [];
  }

  const windows: ParsedUsageWindow[] = [];
  for (const entry of cache["utilization"]["limits"]) {
    if (!isRecord(entry) || typeof entry["percent"] !== "number" || !Number.isFinite(entry["percent"])) continue;
    const kind = entry["kind"];
    let heading: { id: string; label: string } | undefined;
    if (kind === "session") heading = { id: "session", label: "Current session" };
    if (kind === "weekly_all") heading = { id: "weekly", label: "Current week (all models)" };
    if (kind === "weekly_scoped" && isRecord(entry["scope"]) && isRecord(entry["scope"]["model"])) {
      const model = safeString(entry["scope"]["model"]["display_name"]);
      if (model !== undefined) heading = scopedClaudeHeading(model);
    }
    if (heading === undefined) continue;
    const usedPercent = clampPercent(entry["percent"]);
    windows.push({
      ...heading,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      durationMinutes: claudeWindowDurationMinutes(heading.id),
      resetsAt: safeTimestamp(entry["resets_at"]),
    });
  }
  return windows;
}

export function mergeClaudeUsageWindows(
  terminalWindows: readonly ParsedUsageWindow[],
  cachedWindows: readonly ParsedUsageWindow[],
): readonly ParsedUsageWindow[] {
  const cachedById = new Map(cachedWindows.map((window) => [window.id, window]));
  const merged = terminalWindows.map((window) => ({
    ...window,
    resetsAt: window.resetsAt ?? cachedById.get(window.id)?.resetsAt ?? null,
  }));
  const terminalIds = new Set(terminalWindows.map((window) => window.id));
  merged.push(...cachedWindows.filter((window) => !terminalIds.has(window.id)));
  return merged;
}

function claudeWindowDurationMinutes(id: string): number {
  return id === "session" ? 5 * 60 : 7 * 24 * 60;
}

async function readClaudeUsageCache(home: string): Promise<readonly ParsedUsageWindow[]> {
  try {
    const path = claudeStateFile(home);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > USAGE_CACHE_LIMIT) return [];
    return parseClaudeUsageCache(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

function claudeStateFile(home: string): string {
  const ambientHome = process.env.HOME;
  if (ambientHome !== undefined && resolve(home) === resolve(ambientHome, ".claude")) {
    return resolve(ambientHome, ".claude.json");
  }
  return join(home, ".claude.json");
}

export function parseClaudeIdentity(json: string): ObservedClaudeIdentity {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ClaudeAdapterError("identity_parse_failed", "Claude returned invalid authentication status JSON");
  }
  if (!isRecord(value)) {
    throw new ClaudeAdapterError("identity_parse_failed", "Claude returned an invalid authentication status object");
  }
  if (value["loggedIn"] !== true) {
    throw new ClaudeAdapterError("auth_required", "Claude is not authenticated in the configured credential home");
  }

  return compactIdentity({
    email: safeString(value["email"]),
    organizationId: safeString(value["orgId"]),
    organizationName: safeString(value["orgName"]),
    subscriptionType: safeString(value["subscriptionType"]),
    authMethod: safeString(value["authMethod"]),
  });
}

export function parseClaudeUsage(output: string, now = new Date()): readonly ParsedUsageWindow[] {
  const text = normalizeTerminalText(output);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const windows: ParsedUsageWindow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const heading = parseClaudeUsageHeading(line);
    if (heading === undefined) continue;

    const nextHeadingIndex = lines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && parseClaudeUsageHeading(candidate) !== undefined,
    );
    const end = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
    const block = lines.slice(index + 1, end);
    const used = extractUsedPercent(block);
    if (used === null) continue;
    const resetDescription = block.find((candidate) => /^resets?\b/i.test(candidate)) ?? null;
    windows.push({
      id: heading.id,
      label: heading.label,
      usedPercent: used,
      remainingPercent: clampPercent(100 - used),
      durationMinutes: claudeWindowDurationMinutes(heading.id),
      resetsAt: resetDescription === null ? null : parseResetTime(resetDescription, now),
    });
  }

  if (windows.length === 0) {
    throw new ClaudeAdapterError("usage_parse_failed", "Claude usage output did not contain a supported quota window");
  }
  return windows;
}

function parseClaudeUsageHeading(line: string): { id: string; label: string } | undefined {
  if (/^current session$/i.test(line)) {
    return { id: "session", label: "Current session" };
  }
  if (/^current week\s*\(all models\)$/i.test(line)) {
    return { id: "weekly", label: "Current week (all models)" };
  }
  const model = line.match(/^current week\s*\((.+?)\s+only\)$/i)?.[1]?.trim();
  if (model === undefined || model.length === 0 || model.length > 80) return undefined;
  return scopedClaudeHeading(model);
}

function scopedClaudeHeading(model: string): { id: string; label: string } | undefined {
  const modelId = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (modelId.length === 0) return undefined;
  return { id: `${modelId}-weekly`, label: `Current week (${model})` };
}

function isClaudeReady(pane: string): boolean {
  const text = normalizeTerminalText(pane);
  return /claude code/i.test(text) && /(?:^|\n)\s*[$>❯]\s*/m.test(text);
}

function isClaudeThemePicker(pane: string): boolean {
  const text = normalizeTerminalText(pane);
  return (
    /choose the text style that looks best with your terminal/i.test(text) &&
    /dark mode/i.test(text) &&
    /light mode/i.test(text)
  );
}

function isClaudeWorkspaceTrustPrompt(pane: string): boolean {
  const text = normalizeTerminalText(pane);
  return (
    /permission required:\s*accessing workspace/i.test(text) &&
    /is this a project you created or one you trust/i.test(text) &&
    /yes, i trust this folder/i.test(text) &&
    /enter y\/n/i.test(text)
  );
}

function canParseClaudeUsage(pane: string, now: Date): boolean {
  try {
    return parseClaudeUsage(pane, now).length > 0;
  } catch {
    return false;
  }
}

function environmentForClaudeHome(home: string): Readonly<Record<string, string>> {
  const ambientHome = process.env.HOME;
  if (ambientHome !== undefined && resolve(home) === resolve(ambientHome, ".claude")) return {};
  return { CLAUDE_CONFIG_DIR: home };
}

function extractUsedPercent(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = line.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i);
    if (match?.[1] !== undefined) return clampPercent(Number(match[1]));
  }
  return null;
}

function parseResetTime(description: string, now: Date): string | null {
  const value = description.replace(/^resets?\s*/i, "").trim();
  const relative = parseRelativeReset(value, now);
  if (relative !== null) return relative.toISOString();

  const explicitYear = /\b\d{4}\b/.test(value);
  const normalized = value.replace(/\bat\b/i, "").replace(/,/g, " ").replace(/\s+/g, " ");
  const withYear = explicitYear ? normalized : `${normalized} ${now.getFullYear()}`;
  const parsed = new Date(withYear);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!explicitYear && parsed.getTime() <= now.getTime()) parsed.setFullYear(parsed.getFullYear() + 1);
  return parsed.toISOString();
}

function parseRelativeReset(value: string, now: Date): Date | null {
  if (!/^in\b/i.test(value)) return null;
  const hours = Number(value.match(/(\d+)\s*(?:h|hr|hour)/i)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)\s*(?:m|min|minute)/i)?.[1] ?? 0);
  const days = Number(value.match(/(\d+)\s*(?:d|day)/i)?.[1] ?? 0);
  if (hours === 0 && minutes === 0 && days === 0) return null;
  return new Date(now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000);
}

function normalizeTerminalText(value: string): string {
  return value
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll(/[│┃╭╮╰╯┌┐└┘]/g, " ")
    .replaceAll(/\r/g, "")
    .replaceAll(/[ \t]+$/gm, "");
}

function compactIdentity(value: {
  email: string | undefined;
  organizationId: string | undefined;
  organizationName: string | undefined;
  subscriptionType: string | undefined;
  authMethod: string | undefined;
}): ObservedClaudeIdentity {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
