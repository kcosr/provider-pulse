import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid UTC timestamp");

const usageBaselineStateSchema = z
  .object({
    version: z.literal(1),
    updatedAt: timestampSchema.nullable(),
    metrics: z.array(z.object({
      accountId: z.string().min(1).max(256),
      metricKind: z.enum(["window", "balance"]),
      metricId: z.string().min(1).max(256),
      remainingPercent: z.number().finite().min(0).max(100),
      resetAt: timestampSchema.nullable(),
      capturedAt: timestampSchema,
    }).strict()),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    value.metrics.forEach((metric, index) => {
      const key = usageBaselineMetricKey(metric.accountId, metric.metricKind, metric.metricId);
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate usage baseline metric",
          path: ["metrics", index],
        });
      }
      keys.add(key);
    });
  });

export type UsageBaselineState = z.infer<typeof usageBaselineStateSchema>;
export type StoredUsageBaselineMetric = UsageBaselineState["metrics"][number];

export function emptyUsageBaselineState(): UsageBaselineState {
  return { version: 1, updatedAt: null, metrics: [] };
}

export function usageBaselineMetricKey(
  accountId: string,
  metricKind: "window" | "balance",
  metricId: string,
): string {
  return `${accountId}\u0000${metricKind}\u0000${metricId}`;
}

export async function loadUsageBaselineState(filePath: string): Promise<UsageBaselineState> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyUsageBaselineState();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error: unknown) {
    throw new UsageBaselineStateError(
      "usage_baseline_state_invalid",
      "Usage baseline state is not valid JSON",
      error,
    );
  }
  const parsed = usageBaselineStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageBaselineStateError(
      "usage_baseline_state_invalid",
      "Usage baseline state does not match version 1 schema",
      parsed.error,
    );
  }
  return parsed.data;
}

export async function writeUsageBaselineStateAtomic(
  filePath: string,
  state: UsageBaselineState,
): Promise<void> {
  const validated = usageBaselineStateSchema.parse(state);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const file = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let renamed = false;
  try {
    await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, 0o600);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await file.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export class UsageBaselineStateError extends Error {
  readonly code: "usage_baseline_state_invalid";

  constructor(
    code: "usage_baseline_state_invalid",
    message: string,
    options?: unknown,
  ) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = "UsageBaselineStateError";
    this.code = code;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
