import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  PROVIDERS,
  USAGE_ADAPTERS,
  type AppConfig,
} from "./types.js";

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "must be a stable lowercase ID");
const usageWindowIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/,
    "must be a normalized usage-window ID",
  );
const labelSchema = z.string().trim().min(1).max(120);
const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "must be an absolute path");
const nonEmptySchema = z.string().trim().min(1).max(256);

const expectedIdentitySchema = z
  .strictObject({
    email: z.string().trim().email().max(320).optional(),
    organizationId: nonEmptySchema.optional(),
    accountId: nonEmptySchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "expectedIdentity must contain at least one identifier",
  });

const accountSchema = z.strictObject({
  id: idSchema,
  label: labelSchema,
  provider: z.enum(PROVIDERS),
  expectedIdentity: expectedIdentitySchema.optional(),
  usageSource: z.strictObject({
    adapter: z.enum(USAGE_ADAPTERS),
    credentialSurfaceId: idSchema,
    hiddenWindowIds: z
      .array(usageWindowIdSchema)
      .max(100)
      .refine((values) => new Set(values).size === values.length, {
        message: "must not contain duplicate usage-window IDs",
      })
      .optional(),
  }),
});

const cliCredentialSurfaceBase = {
  id: idSchema,
  home: absolutePathSchema,
  executable: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => isAbsolute(value) || !value.includes("/"), {
      message: "must be an absolute path or an executable name resolved through PATH",
    }),
};

const credentialSurfaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...cliCredentialSurfaceBase, kind: z.literal("native-codex") }),
  z.strictObject({ ...cliCredentialSurfaceBase, kind: z.literal("native-claude") }),
  z.strictObject({ ...cliCredentialSurfaceBase, kind: z.literal("native-grok") }),
  z.strictObject({ ...cliCredentialSurfaceBase, kind: z.literal("pi") }),
  z.strictObject({
    id: idSchema,
    kind: z.literal("fireworks-api"),
    credentialFile: absolutePathSchema,
  }),
]);

const triggerSchema = z.strictObject({
  type: z.literal("after-reset"),
  windowId: usageWindowIdSchema,
  offsetMinutes: z.number().int().min(0).max(1440),
});

const heartbeatBase = {
  id: idSchema,
  accountId: idSchema,
  credentialSurfaceId: idSchema,
  model: nonEmptySchema,
  reasoning: z.string().trim().min(1).max(64),
  prompt: z.string().min(1).max(500),
  trigger: triggerSchema,
  timeoutSeconds: z.number().int().min(5).max(900),
  enabled: z.boolean(),
};

const heartbeatSchema = z.discriminatedUnion("executor", [
  z.strictObject({ ...heartbeatBase, executor: z.literal("native-codex") }),
  z.strictObject({ ...heartbeatBase, executor: z.literal("native-claude") }),
  z.strictObject({ ...heartbeatBase, executor: z.literal("native-grok") }),
  z.strictObject({
    ...heartbeatBase,
    executor: z.literal("pi"),
    provider: nonEmptySchema,
  }),
]);

const configSchema = z
  .strictObject({
    version: z.literal(1),
    server: z.strictObject({
      host: z.union([z.literal("127.0.0.1"), z.literal("::1"), z.literal("localhost")]),
      port: z.number().int().min(1).max(65535),
    }),
    paths: z.strictObject({
      stateDirectory: absolutePathSchema,
      probeDirectory: absolutePathSchema,
    }),
    polling: z.strictObject({
      automaticIntervalMinutes: z.number().int().min(1).max(43_200).nullable(),
      startupCheck: z.boolean(),
      maxConcurrency: z.number().int().min(1).max(16),
      staleAfterMinutes: z.number().int().min(1).max(43_200),
    }),
    accounts: z.array(accountSchema).min(1).max(100),
    credentialSurfaces: z.array(credentialSurfaceSchema).min(1).max(200),
    heartbeatJobs: z.array(heartbeatSchema).max(200),
  })
  .superRefine((config, context) => {
    checkUnique(config.accounts, "accounts", context);
    checkUnique(config.credentialSurfaces, "credentialSurfaces", context);
    checkUnique(config.heartbeatJobs, "heartbeatJobs", context);

    const surfaces = new Map(config.credentialSurfaces.map((surface) => [surface.id, surface]));
    const accounts = new Map(config.accounts.map((account) => [account.id, account]));
    const expectedUsagePair = {
      "codex-app-server": { provider: "codex", surface: "native-codex" },
      "claude-tmux": { provider: "claude", surface: "native-claude" },
      "grok-tmux": { provider: "grok", surface: "native-grok" },
      "fireworks-api": { provider: "fireworks", surface: "fireworks-api" },
    } as const;

    config.accounts.forEach((account, index) => {
      const surface = surfaces.get(account.usageSource.credentialSurfaceId);
      if (surface === undefined) {
        addIssue(context, ["accounts", index, "usageSource", "credentialSurfaceId"], "references an unknown credential surface");
        return;
      }
      const expected = expectedUsagePair[account.usageSource.adapter];
      if (account.provider !== expected.provider) {
        addIssue(context, ["accounts", index, "usageSource", "adapter"], `is not valid for provider ${account.provider}`);
      }
      if (surface.kind !== expected.surface) {
        addIssue(context, ["accounts", index, "usageSource", "credentialSurfaceId"], `requires a ${expected.surface} credential surface`);
      }
      if (account.provider === "fireworks" && account.expectedIdentity?.accountId === undefined) {
        addIssue(
          context,
          ["accounts", index, "expectedIdentity", "accountId"],
          "is required to select and verify a Fireworks account",
        );
      }
    });

    config.heartbeatJobs.forEach((job, index) => {
      const account = accounts.get(job.accountId);
      if (account === undefined) {
        addIssue(context, ["heartbeatJobs", index, "accountId"], "references an unknown account");
      } else if (account.provider === "fireworks") {
        addIssue(
          context,
          ["heartbeatJobs", index, "accountId"],
          "Fireworks accounts do not support heartbeats",
        );
      } else if (account.usageSource.hiddenWindowIds?.includes(job.trigger.windowId) === true) {
        addIssue(
          context,
          ["heartbeatJobs", index, "trigger", "windowId"],
          "cannot target a hidden usage window",
        );
      } else if (job.executor !== "pi") {
        const expectedProvider = job.executor.replace(/^native-/, "");
        if (account.provider !== expectedProvider) {
          addIssue(
            context,
            ["heartbeatJobs", index, "executor"],
            `is not valid for provider ${account.provider}`,
          );
        }
      }
      const surface = surfaces.get(job.credentialSurfaceId);
      if (surface === undefined) {
        addIssue(context, ["heartbeatJobs", index, "credentialSurfaceId"], "references an unknown credential surface");
      } else if (surface.kind !== job.executor) {
        addIssue(context, ["heartbeatJobs", index, "credentialSurfaceId"], `requires a ${job.executor} credential surface`);
      }
    });
  });

function checkUnique(
  values: readonly { id: string }[],
  field: "accounts" | "credentialSurfaces" | "heartbeatJobs",
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      addIssue(context, [field, index, "id"], `duplicate ID: ${value.id}`);
    }
    seen.add(value.id);
  });
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}

export function parseConfig(value: unknown): AppConfig {
  return configSchema.parse(value) as AppConfig;
}

export async function loadConfig(filePath: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigLoadError(`Unable to read configuration at ${filePath}`, error);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigLoadError(`Configuration at ${filePath} is not valid JSON`, error);
  }

  try {
    return parseConfig(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigLoadError(`Configuration at ${filePath} is invalid: ${z.prettifyError(error)}`, error);
    }
    throw error;
  }
}

export class ConfigLoadError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ConfigLoadError";
    this.cause = cause;
  }
}
