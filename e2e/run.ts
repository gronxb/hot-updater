#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runLocal } from "./local/prepare.ts";
import { parseMobileOptions, runMobile } from "./mobile/run.ts";
import { resolveMobileRuntime } from "./mobile/target.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const usage = `Usage: pnpm e2e --platform ios|android [--device <UDID|serial>]
                [--runtime react-native|lynx] [--scenario <name>] [--suite default] [--dry-run] [--list]

Local runs prepare PGlite, local S3 storage, signing keys, and the Release app.
With no --device, exactly one booted device of the selected platform is required.
--prepared runs the same suite with a caller-provided provider and native build.
`;

export async function runE2e(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  runners = { mobile: runMobile, local: runLocal },
): Promise<number> {
  const prepared = argv.includes("--prepared");
  if (argv.filter((arg) => arg === "--prepared").length > 1) {
    throw new Error("Duplicate argument: --prepared");
  }
  const forwarded = argv.filter((arg) => arg !== "--prepared");
  if (prepared) return runners.mobile(forwarded, env);
  if (forwarded.includes("--help") || forwarded.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (forwarded.includes("--list")) return runners.mobile(forwarded, env);

  const platformIndex = forwarded.indexOf("--platform");
  const platform = forwarded[platformIndex + 1];
  if (platformIndex < 0 || (platform !== "ios" && platform !== "android")) {
    throw new Error(`--platform ios|android is required.\n${usage}`);
  }
  const deviceIndex = forwarded.indexOf("--device");
  const device =
    deviceIndex >= 0
      ? forwarded[deviceIndex + 1]
      : (env.HOT_UPDATER_E2E_DEVICE_ID ??
        (platform === "android"
          ? (env.HOT_UPDATER_E2E_ANDROID_SERIAL ?? env.ANDROID_SERIAL)
          : undefined));
  // Validate every other option and the scenario selection before preparation.
  // Device discovery is deliberately deferred; this placeholder is never used
  // by the runner or sent to a native tool.
  const validated = parseMobileOptions(forwarded, {
    ...env,
    HOT_UPDATER_E2E_DEVICE_ID: device ?? "00000000-0000-0000-0000-000000000000",
  });
  if (
    validated.values.profile &&
    validated.values.profile !== "standalone-kysely"
  ) {
    throw new Error(
      "Local E2E uses standalone-kysely. Use --prepared for an externally prepared profile.",
    );
  }
  if (forwarded.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          platform,
          runtime: validated.values.runtime,
          device: device ?? "one booted device (resolved at execution)",
          profile: "standalone-kysely",
          scenarios: validated.scenarios,
          preparation: [
            "workspace build",
            "local signing key",
            "native dependencies",
            validated.values.runtime === "lynx"
              ? "committed Lynx fingerprint and source verification"
              : "fingerprint",
            "Release build",
            "local S3 + PGlite",
            "mobile scenarios",
            "owned cleanup and file restore",
          ],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  return runners.local(
    forwarded,
    repositoryRoot,
    platform,
    device,
    env,
    resolveMobileRuntime(validated.values.runtime, env),
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runE2e(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
