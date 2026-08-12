import { mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DiagnosticEvent {
  operationId: string;
  kind: "usage-check" | "heartbeat" | "system";
  outcome: string;
  attemptedAt: string;
  completedAt?: string;
  durationMs?: number;
  accountId?: string;
  heartbeatId?: string;
  implementation?: string;
  implementationVersion?: string;
  error?: { code: string; message: string };
  details?: Record<string, unknown>;
}

export interface JsonlLoggerOptions {
  directory: string;
  maxBytes?: number;
  maxFiles?: number;
  redactedValues?: readonly string[];
}

const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api[-_]?key)/i;
const STRING_SECRET = /\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;

export class JsonlLogger {
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #redactedValues: readonly string[];
  #pending: Promise<void> = Promise.resolve();

  constructor(options: JsonlLoggerOptions) {
    this.#directory = options.directory;
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.#maxFiles = options.maxFiles ?? 3;
    this.#redactedValues = [...(options.redactedValues ?? [])]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
    if (this.#maxBytes <= 0 || this.#maxFiles < 1) {
      throw new Error("JSONL logger limits must be positive");
    }
  }

  append(event: DiagnosticEvent): Promise<void> {
    const line = `${JSON.stringify(redact(event, this.#redactedValues))}\n`;
    this.#pending = this.#pending.then(() => this.#write(line));
    return this.#pending;
  }

  async #write(line: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const activePath = join(this.#directory, "events.jsonl");
    const currentSize = await fileSize(activePath);
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > this.#maxBytes) {
      await this.#rotate(activePath);
    }
    const handle = await open(activePath, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
    } finally {
      await handle.close();
    }
  }

  async #rotate(activePath: string): Promise<void> {
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? activePath : `${activePath}.${index - 1}`;
      const destination = `${activePath}.${index}`;
      try {
        await rename(source, destination);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

export function redact<T>(value: T, redactedValues: readonly string[] = []): T {
  return redactValue(value, redactedValues) as T;
}

function redactValue(value: unknown, redactedValues: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value.replace(STRING_SECRET, "Bearer [REDACTED]");
    for (const secret of redactedValues) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactedValues));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, redactedValues),
      ]),
    );
  }
  return value;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
