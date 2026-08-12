import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderPulseApplication, validateRuntimeDependencies } from "./application.js";
import { loadConfig } from "./config.js";
import { JsonlLogger } from "./log.js";
import { buildServer } from "./server.js";

const configPath = process.env.PROVIDER_PULSE_CONFIG ?? join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "provider-pulse",
  "config.json",
);
const config = await loadConfig(configPath);
await Promise.all([
  mkdir(config.paths.stateDirectory, { recursive: true, mode: 0o700 }),
  mkdir(config.paths.probeDirectory, { recursive: true, mode: 0o700 }),
]);
await validateRuntimeDependencies(config);

const logger = new JsonlLogger({
  directory: config.paths.stateDirectory,
  redactedValues: [
    configPath,
    dirname(configPath),
    config.paths.stateDirectory,
    config.paths.probeDirectory,
    ...config.credentialSurfaces.flatMap((surface) =>
      surface.kind === "fireworks-api"
        ? [surface.credentialFile]
        : [surface.home]),
  ],
});
const application = new ProviderPulseApplication(config, { logger });
await application.initialize();
const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const server = await buildServer(application, {
  publicDirectory,
  host: config.server.host,
  port: config.server.port,
});
await server.listen({ host: config.server.host, port: config.server.port });

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.close();
  await application.close();
};
process.once("SIGINT", () => void stop().then(() => process.exit(0), () => process.exit(1)));
process.once("SIGTERM", () => void stop().then(() => process.exit(0), () => process.exit(1)));
