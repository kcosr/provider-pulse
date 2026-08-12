import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalProbe } from "../terminal/tmux.js";
import type { ParsedUsageWindow } from "./claude.js";

export interface ObservedGrokIdentity {
  readonly email?: string;
  readonly accountId?: string;
  readonly organizationId?: string;
  readonly authMethod?: string;
}

export interface GrokUsageSnapshot {
  readonly adapter: "grok-tmux";
  readonly adapterVersion: 1;
  readonly identity: ObservedGrokIdentity;
  readonly windows: readonly ParsedUsageWindow[];
}

export interface GrokUsageSurface {
  readonly executable: string;
  readonly home: string;
  readonly probeDirectory: string;
}

export class GrokAdapterError extends Error {
  public readonly code: "auth_required" | "identity_parse_failed" | "usage_parse_failed";

  public constructor(
    code: "auth_required" | "identity_parse_failed" | "usage_parse_failed",
    message: string,
  ) {
    super(message);
    this.name = "GrokAdapterError";
    this.code = code;
  }
}

const AUTH_FILE_LIMIT = 256 * 1024;
const USAGE_OUTPUT_LIMIT = 256 * 1024;

export class GrokUsageAdapter {
  readonly #terminal: TerminalProbe;
  readonly #loadFile: (path: string) => Promise<string>;
  readonly #now: () => Date;

  public constructor(
    terminal: TerminalProbe,
    loadFile: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
    now: () => Date = () => new Date(),
  ) {
    this.#terminal = terminal;
    this.#loadFile = loadFile;
    this.#now = now;
  }

  public async poll(surface: GrokUsageSurface): Promise<GrokUsageSnapshot> {
    const identity = await this.#readIdentity(surface.home);
    const probe = await this.#terminal.probe({
      sessionPrefix: "provider-pulse-grok",
      executable: surface.executable,
      args: [
        "--no-alt-screen",
        "--tools",
        "",
        "--disable-web-search",
        "--no-memory",
        "--no-subagents",
        "--no-plan",
      ],
      cwd: surface.probeDirectory,
      env: { GROK_HOME: surface.home },
      command: "/usage",
      isReady: isGrokReady,
      isComplete: (pane) => canParseGrokUsage(pane, this.#now()),
      startupTimeoutMs: 30_000,
      responseTimeoutMs: 30_000,
      totalTimeoutMs: 70_000,
      maxOutputBytes: USAGE_OUTPUT_LIMIT,
    });

    return {
      adapter: "grok-tmux",
      adapterVersion: 1,
      identity,
      windows: parseGrokUsage(probe.output, this.#now()),
    };
  }

  async #readIdentity(home: string): Promise<ObservedGrokIdentity> {
    let json: string;
    try {
      json = await this.#loadFile(join(home, "auth.json"));
    } catch {
      throw new GrokAdapterError("auth_required", "Grok authentication metadata is unavailable");
    }
    if (Buffer.byteLength(json, "utf8") > AUTH_FILE_LIMIT) {
      throw new GrokAdapterError("identity_parse_failed", "Grok authentication metadata exceeds its size limit");
    }
    return parseGrokIdentity(json);
  }
}

export function parseGrokIdentity(json: string): ObservedGrokIdentity {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new GrokAdapterError("identity_parse_failed", "Grok authentication metadata is invalid JSON");
  }
  if (!isRecord(value)) {
    throw new GrokAdapterError("identity_parse_failed", "Grok authentication metadata is invalid");
  }

  const records = Object.values(value).filter(isRecord).filter((record) => safeString(record["email"]) !== undefined);
  if (records.length === 0) {
    throw new GrokAdapterError("auth_required", "Grok is not authenticated in the configured credential home");
  }
  const identities = records.map((record) => ({
    email: safeString(record["email"]),
    accountId: safeString(record["principal_id"]),
    organizationId: safeString(record["team_id"]),
    authMethod: safeString(record["auth_mode"]),
    createdAt: parseCreationTime(record["create_time"]),
  }));
  const emails = new Set(identities.map((identity) => identity.email?.toLowerCase()));
  if (emails.size !== 1) {
    throw new GrokAdapterError("identity_parse_failed", "Grok authentication metadata contains multiple identities");
  }
  const selected = identities.sort((left, right) => right.createdAt - left.createdAt)[0];
  if (selected === undefined) {
    throw new GrokAdapterError("auth_required", "Grok is not authenticated in the configured credential home");
  }
  return Object.fromEntries(
    Object.entries({
      email: selected.email,
      accountId: selected.accountId,
      organizationId: selected.organizationId,
      authMethod: selected.authMethod,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function parseCreationTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parseGrokUsage(output: string, now = new Date()): readonly ParsedUsageWindow[] {
  const text = normalizeTerminalText(output);
  const usedMatch = text.match(
    /(?:weekly(?:\s+(?:usage|limit))?[\s\S]{0,240}?)(\d{1,3}(?:\.\d+)?)\s*%(?:\s*used\b)?/i,
  );
  if (usedMatch?.[1] === undefined) {
    throw new GrokAdapterError("usage_parse_failed", "Grok usage output did not contain the weekly quota window");
  }
  const used = clampPercent(Number(usedMatch[1]));
  const resetDescription = text.match(/^\s*((?:next\s+reset\s*:|resets?\b)[^\n]*)/im)?.[1]?.trim() ?? null;
  return [{
    id: "weekly",
    label: "Weekly limit",
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt: resetDescription === null ? null : parseResetTime(resetDescription, now),
  }];
}

function isGrokReady(pane: string): boolean {
  const text = normalizeTerminalText(pane);
  return /grok/i.test(text) && /(?:^|\n)\s*[>❯]\s*/m.test(text);
}

function canParseGrokUsage(pane: string, now: Date): boolean {
  try {
    return parseGrokUsage(pane, now).length > 0;
  } catch {
    return false;
  }
}

function parseResetTime(description: string, now: Date): string | null {
  const value = description.replace(/^(?:next\s+reset\s*:|resets?)\s*/i, "").trim();
  const relative = value.match(/^in\s+(?:(\d+)\s*(?:d|day)s?)?\s*(?:(\d+)\s*(?:h|hr|hour)s?)?\s*(?:(\d+)\s*(?:m|min|minute)s?)?/i);
  if (relative !== null) {
    const days = Number(relative[1] ?? 0);
    const hours = Number(relative[2] ?? 0);
    const minutes = Number(relative[3] ?? 0);
    if (days + hours + minutes > 0) {
      return new Date(now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000).toISOString();
    }
  }

  const explicitYear = /\b\d{4}\b/.test(value);
  const normalized = value.replace(/\bat\b/i, "").replace(/,/g, " ").replace(/\s+/g, " ");
  const parsed = new Date(explicitYear ? normalized : `${normalized} ${now.getFullYear()}`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!explicitYear && parsed.getTime() <= now.getTime()) parsed.setFullYear(parsed.getFullYear() + 1);
  return parsed.toISOString();
}

function normalizeTerminalText(value: string): string {
  return value
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll(/[│┃╭╮╰╯┌┐└┘]/g, " ")
    .replaceAll(/\r/g, "")
    .replaceAll(/[ \t]+$/gm, "");
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
