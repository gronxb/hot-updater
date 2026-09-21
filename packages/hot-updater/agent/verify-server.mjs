import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verifyServer } from "../src/commands/doctor/server.ts";

try {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      platform: { type: "string" },
      channel: { type: "string" },
      "app-version": { type: "string" },
      fingerprint: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest.serverVersion !== "string" ||
    !Number.isInteger(manifest.infrastructureGeneration)
  )
    throw new Error("Invalid manifest");
  const result = await verifyServer({
    cwd: process.cwd(),
    infraDir: fileURLToPath(new URL("..", import.meta.url)),
    baseUrl: values["base-url"],
    platform: values.platform,
    channel: values.channel,
    appVersion: values["app-version"],
    fingerprint: values.fingerprint,
    serverVersion: manifest.serverVersion,
    infrastructureGeneration: manifest.infrastructureGeneration,
  });
  console.log(JSON.stringify(result));
  if (result.status !== "verified") process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      status: "failed",
      check: "inputs",
      error: "Cannot read verification inputs or scaffold manifest.",
    }),
  );
  process.exitCode = 1;
}
