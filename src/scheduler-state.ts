import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid UTC timestamp");

const schedulerCursorSchema = z
  .object({
    version: z.literal(1),
    jobs: z.record(
      z.string().min(1),
      z
        .object({
          lastObservedResetAt: timestampSchema,
          lastHandledResetAt: timestampSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type SchedulerCursor = z.infer<typeof schedulerCursorSchema>;
export type SchedulerJobCursor = SchedulerCursor["jobs"][string];

export function emptySchedulerCursor(): SchedulerCursor {
  return { version: 1, jobs: {} };
}

export async function loadSchedulerCursor(filePath: string): Promise<SchedulerCursor> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptySchedulerCursor();
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error: unknown) {
    throw new SchedulerStateError("scheduler_state_invalid", "Scheduler cursor is not valid JSON", error);
  }

  const parsed = schedulerCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new SchedulerStateError(
      "scheduler_state_invalid",
      "Scheduler cursor does not match version 1 schema",
      parsed.error,
    );
  }
  return parsed.data;
}

export async function writeSchedulerCursorAtomic(
  filePath: string,
  cursor: SchedulerCursor,
): Promise<void> {
  const validated = schedulerCursorSchema.parse(cursor);
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
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export class SchedulerStateError extends Error {
  readonly code: "scheduler_state_invalid";

  constructor(
    code: "scheduler_state_invalid",
    message: string,
    options?: unknown,
  ) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = "SchedulerStateError";
    this.code = code;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
