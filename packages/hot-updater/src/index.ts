#!/usr/bin/env node
import {
  Command,
  InvalidArgumentError,
  Option,
} from "@commander-js/extra-typings";
import type { AndroidNativeRunOptions } from "@hot-updater/android-helper";
import type { IosNativeRunOptions } from "@hot-updater/apple-helper";
import { banner, p } from "@hot-updater/cli-tools";
import type { NativeBuildOptions } from "@hot-updater/plugin-core";
import { normalizeRange } from "verkit";

import {
  appIdSuffixCommandOption,
  deviceCommandOption,
  interactiveCommandOption,
  nativeBuildOutputCommandOption,
  nativeBuildSchemeCommandOption,
  platformCommandOption,
  portCommandOption,
} from "@/commandOptions";
import { handleAppVersion } from "@/commands/appVersion";
import { buildAndroidNative, buildIosNative } from "@/commands/buildNative";
import { getConsolePort, openConsole } from "@/commands/console";
import {
  type DeployOptions,
  deploy,
  normalizeRolloutPercentage,
} from "@/commands/deploy";
import { init } from "@/commands/init";
import { initHelp } from "@/commands/initHelp";
import { INIT_PROVIDER_NAMES } from "@/commands/initProviders";
import { type PatchOptions, createPatch } from "@/commands/patch";
import { runAndroidNative, runIosNative } from "@/commands/runNative";
import { version } from "@/packageJson";
import { ensureNoConflicts } from "@/utils/conflictDetection";
import { printBanner } from "@/utils/printBanner";

import {
  handleApiKeyCreate,
  handleApiKeyList,
  handleApiKeyRevoke,
} from "./commands/apiKey";
import {
  handleBundleDelete,
  handleBundleList,
  handleBundleShow,
} from "./commands/bundle";
import {
  handleCatalogPreflight,
  handleCatalogRebuild,
} from "./commands/catalog";
import { handleChannel, handleSetChannel } from "./commands/channel";
import { handleDoctor } from "./commands/doctor";
import {
  handleCreateFingerprint,
  handleFingerprint,
} from "./commands/fingerprint";
import { generate } from "./commands/generate";
import { keysExportPublic, keysGenerate, keysRemove } from "./commands/keys";
import { migrate } from "./commands/migrate";
import { handlePromote } from "./commands/promote";
import {
  handleReleaseDelete,
  handleReleaseEnablement,
  handleReleaseList,
  handleReleasePreflight,
  handleReleaseShow,
  handleReleaseUpdate,
} from "./commands/release";
import {
  DEFAULT_STORAGE_PRUNE_PROTECTION_MS,
  handleStoragePrune,
  parseStoragePruneProtection,
} from "./commands/storage";

const DEFAULT_CHANNEL = "production";
const parseBooleanOption = (value: string) => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new InvalidArgumentError("must be true or false");
};

const parseRolloutCohortCount = (value: string) => {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new InvalidArgumentError("must be an integer between 0 and 1000");
  }
  return count;
};

const program = new Command();

program
  .name("hot-updater")
  .description(banner(version))
  .version(version as string);

program
  .command("init")
  .description("Initialize Hot Updater")
  .addOption(
    new Option(
      "--provider <provider>",
      "provider to use; skips the prompt",
    ).choices(INIT_PROVIDER_NAMES),
  )
  .addOption(
    new Option(
      "--build <plugin>",
      "build plugin to use; skips the prompt",
    ).choices(["bare", "rock", "expo"]),
  )
  .option(
    "--from-env-file <path>",
    "load saved init inputs and fail if any are missing",
  )
  .addHelpText("after", initHelp)
  .action(({ fromEnvFile, ...options }) =>
    init({ ...options, envFile: fromEnvFile }),
  );

program
  .command("doctor")
  .description("Check the health of Hot Updater")
  .option(
    "--server-base-url <url>",
    "server base URL used by update checks (doctor appends /version)",
  )
  .option("--json", "output machine-readable doctor result")
  .action(handleDoctor);

const fingerprintCommand = program
  .command("fingerprint")
  .description("Check current fingerprints against fingerprint.json");

fingerprintCommand.action(handleFingerprint);

fingerprintCommand
  .command("create")
  .description("Create fingerprint")
  .action(handleCreateFingerprint);

const channelCommand = program
  .command("channel")
  .description("Show and manage native default channels");

channelCommand.action(handleChannel);

channelCommand
  .command("set")
  .description(
    "Set the native default channel for Android (BuildConfig) and iOS (Info.plist)",
  )
  .argument("<channel>", "the channel to set")
  .action(handleSetChannel);

const apiKeyCommand = program.command("api-key").description("Manage API keys");

apiKeyCommand
  .command("create")
  .description("Create an API key")
  .argument("[configPath]", "path to the config file that exports hotUpdater")
  .requiredOption("--name <name>", "name used to identify the API key")
  .action((configPath: string | undefined, options: { name: string }) =>
    handleApiKeyCreate(options.name, { configPath }),
  );

apiKeyCommand
  .command("list")
  .description("List API keys")
  .argument("[configPath]", "path to the config file that exports hotUpdater")
  .option("--json", "output API key metadata as JSON")
  .action((configPath: string | undefined, options: { json?: boolean }) =>
    handleApiKeyList({ ...options, configPath }),
  );

apiKeyCommand
  .command("revoke")
  .description("Revoke an API key")
  .argument("<id>", "API key id")
  .argument("[configPath]", "path to the config file that exports hotUpdater")
  .option("-y, --yes", "skip confirmation prompt")
  .action(
    (id: string, configPath: string | undefined, options: { yes?: boolean }) =>
      handleApiKeyRevoke(id, { ...options, configPath }),
  );

const bundleCommand = program.command("bundle").description("Manage bundles");

bundleCommand
  .command("list")
  .description("List immutable Bundle artifacts, most recent first")
  .option("--json", "output raw bundle data as JSON")
  .addOption(platformCommandOption)
  .option(
    "--limit <n>",
    "limit the number of results",
    (value) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new InvalidArgumentError("must be a positive integer");
      }
      return n;
    },
    20,
  )
  .action(handleBundleList);

bundleCommand
  .command("show")
  .description("Show one Bundle artifact and its Release references")
  .argument("<bundle-id>", "the bundle id to show")
  .option("--json", "output raw bundle data as JSON")
  .action((bundleId: string, options: { json?: boolean }) =>
    handleBundleShow(bundleId, options),
  );

bundleCommand
  .command("delete")
  .description("Delete Bundle records that have no Release references")
  .argument("<bundle-ids...>", "the bundle id(s) to delete")
  .option("-y, --yes", "skip confirmation prompt")
  .action((bundleIds: string[], options: { yes?: boolean }) =>
    handleBundleDelete(bundleIds, options),
  );

const releaseCommand = program
  .command("release")
  .description("Manage Release delivery policy");

releaseCommand
  .command("list")
  .description("List Releases, most recent first")
  .option("-c, --channel <channel>", "filter by channel")
  .option("--bundle-id <bundle-id>", "filter by referenced Bundle id")
  .option("--json", "output raw Release rows as JSON")
  .addOption(platformCommandOption)
  .option(
    "--limit <n>",
    "limit the number of results",
    (value) => {
      const count = Number.parseInt(value, 10);
      if (!Number.isInteger(count) || count <= 0 || count > 1000) {
        throw new InvalidArgumentError("must be an integer from 1 to 1000");
      }
      return count;
    },
    20,
  )
  .action(handleReleaseList);

releaseCommand
  .command("show")
  .description("Show one Release")
  .argument("<release-id>", "the Release id")
  .option("--json", "output the raw Release row as JSON")
  .action(handleReleaseShow);

const addReleasePolicyOptions = <
  TArgs extends unknown[],
  TOptions extends Record<string, unknown>,
  TGlobalOptions extends Record<string, unknown>,
>(
  command: Command<TArgs, TOptions, TGlobalOptions>,
) =>
  command
    .option("--message <message>", "set the public Release message")
    .option("--clear-message", "clear the Release message")
    .option(
      "--target-app-version <range>",
      "set the app-version compatibility range",
    )
    .option(
      "--rollout-cohort-count <count>",
      "rollout cohort count from 0 to 1000",
      parseRolloutCohortCount,
    )
    .option(
      "--force-update <value>",
      "set the force-update flag",
      parseBooleanOption,
    )
    .option(
      "--target-cohorts <cohorts>",
      "comma-separated public target cohort names",
    )
    .option("--clear-target-cohorts", "clear public target cohort names")
    .option(
      "--expected-revision <revision>",
      "fail if the Release revision changed",
      (value) => {
        const revision = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return revision;
      },
    )
    .option("--json", "output JSON");

addReleasePolicyOptions(
  releaseCommand
    .command("update")
    .description("Update mutable Release delivery policy")
    .argument("<release-id>", "the Release id")
    .option("-y, --yes", "skip confirmation prompt"),
).action(handleReleaseUpdate);

addReleasePolicyOptions(
  releaseCommand
    .command("preflight")
    .description("Compile and size-check a Release mutation without saving")
    .argument("<release-id>", "the Release id"),
).action(handleReleasePreflight);

for (const [name, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  releaseCommand
    .command(name)
    .description(
      enabled
        ? "Enable an exact Release"
        : "Disable an exact Release and re-resolve compatible delivery",
    )
    .argument("<release-id>", "the Release id")
    .option(
      "--expected-revision <revision>",
      "expected Release revision",
      (value) => {
        const revision = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return revision;
      },
    )
    .option("--json", "output JSON")
    .option("-y, --yes", "skip confirmation prompt")
    .action((releaseId, options) =>
      handleReleaseEnablement(releaseId, enabled, options),
    );
}

releaseCommand
  .command("delete")
  .description("Hard-delete a disabled Release")
  .argument("<release-id>", "the Release id")
  .option(
    "--expected-revision <revision>",
    "expected Release revision",
    (value) => {
      const revision = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new InvalidArgumentError("must be a positive integer");
      }
      return revision;
    },
  )
  .option("--json", "output JSON")
  .option("-y, --yes", "skip confirmation prompt")
  .action(handleReleaseDelete);

releaseCommand
  .command("promote")
  .description("Create a target-channel Release reusing the same Bundle")
  .argument("<source-release-id>", "the source Release id")
  .requiredOption("-t, --target <channel>", "target channel")
  .addOption(
    new Option(
      "-a, --action <action>",
      "copy creates a target Release; move also disables the source Release",
    )
      .choices(["copy", "move"])
      .default("copy"),
  )
  .option("-y, --yes", "skip confirmation prompt")
  .action(
    (
      sourceReleaseId: string,
      options: {
        target: string;
        action: "copy" | "move";
        yes?: boolean;
      },
    ) => handlePromote(sourceReleaseId, options),
  );

const storageCommand = program
  .command("storage")
  .description("Manage stored bundle artifacts");

storageCommand
  .command("prune")
  .description("Find or delete unreferenced bundle objects and shared assets")
  .addOption(
    new Option(
      "--protect-newer-than <duration>",
      "protect unreferenced objects modified within this duration",
    )
      .argParser((value) => {
        try {
          return parseStoragePruneProtection(value);
        } catch (error) {
          throw new InvalidArgumentError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .default(DEFAULT_STORAGE_PRUNE_PROTECTION_MS, "24h"),
  )
  .addOption(
    new Option(
      "--dry-run",
      "list eligible objects without deleting them (default)",
    ).conflicts("yes"),
  )
  .addOption(
    new Option(
      "-y, --yes",
      "delete eligible objects after reference validation",
    ).conflicts("dryRun"),
  )
  .addHelpText(
    "after",
    `
Examples:
  $ hot-updater storage prune --dry-run
  $ hot-updater storage prune --protect-newer-than 24h --yes

Only unreferenced bundle objects and shared assets are eligible.
Protection uses object modification time, not time since bundle deletion.
Deletion requires exclusive storage access; stop deploy and patch first.
Object listing and deletion require a capable Storage plugin such as s3Storage.
`,
  )
  .action(
    (options: { dryRun?: boolean; protectNewerThan: number; yes?: boolean }) =>
      handleStoragePrune(options),
  );

const keysCommand = program
  .command("keys")
  .description("Code signing key management");

keysCommand
  .command("generate")
  .description("Generate RSA key pair for code signing")
  .option("-o, --output <dir>", "output directory for keys", "./keys")
  .option(
    "-k, --key-size <size>",
    "key size (2048 or 4096)",
    (value) => {
      const size = Number.parseInt(value, 10);
      if (size !== 2048 && size !== 4096) {
        p.log.error("Key size must be 2048 or 4096");
        process.exit(1);
      }
      return size as 2048 | 4096;
    },
    4096,
  )
  .action(keysGenerate);

keysCommand
  .command("export-public")
  .description("Export public key for native configuration")
  .option(
    "-i, --input <path>",
    "path to a legacy private key file (default: configured public signing key)",
  )
  .option(
    "-p, --print-only",
    "only print the public key without writing to native files",
  )
  .option("-y, --yes", "skip confirmation prompt when writing to native files")
  .action(keysExportPublic);

keysCommand
  .command("remove")
  .description("Remove public keys from native configuration files")
  .option("-y, --yes", "skip confirmation prompt")
  .action(keysRemove);

program
  .command("deploy")
  .description("Build an immutable Bundle and create a Release")
  .addOption(platformCommandOption)
  .addOption(
    new Option(
      "-t, --target-app-version <targetAppVersion>",
      "specify the target app version (semver format e.g. 1.0.0, 1.x.x)",
    ).argParser((value) => {
      if (!normalizeRange(value)) {
        p.log.error("Invalid semver format (e.g. 1.0.0, 1.x.x)");
        process.exit(1);
      }
      return value;
    }),
  )
  .addOption(
    new Option("-d, --disabled", "create the Release disabled").default(false),
  )
  .addOption(
    new Option("-f, --force-update", "force update the app").default(false),
  )
  .addOption(
    new Option(
      "-o, --bundle-output-path <bundleOutputPath>",
      "the directory where bundle archives will be generated",
    ),
  )
  .addOption(
    new Option(
      "-r, --rollout <percentage>",
      "specify the rollout percentage for the new Release (0-100)",
    )
      .argParser((value) => {
        try {
          return normalizeRolloutPercentage(value);
        } catch (error) {
          if (error instanceof Error) {
            p.log.error(error.message);
            process.exit(1);
          }
          throw error;
        }
      })
      .default(100),
  )
  .addOption(interactiveCommandOption)
  .addOption(
    new Option(
      "-c, --channel <channel>",
      "specify the channel to deploy",
    ).default(DEFAULT_CHANNEL),
  )
  .addOption(
    new Option(
      "-m, --message <message>",
      "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
    ),
  )
  .action(async (options: DeployOptions) => deploy(options));

program
  .command("patch")
  .description("create patch artifacts for a deployed bundle")
  .requiredOption(
    "-b, --bundle-id <bundleId>",
    "target bundle id that should receive the patch artifact",
  )
  .requiredOption(
    "--base-bundle-id <baseBundleId>",
    "older bundle id to use as the patch base",
  )
  .addOption(platformCommandOption)
  .addOption(interactiveCommandOption)
  .addOption(
    new Option(
      "-c, --channel <channel>",
      "specify the channel used to load config",
    ).default(DEFAULT_CHANNEL),
  )
  .action(async (options: PatchOptions) => {
    await createPatch(options);
  });

program
  .command("console")
  .description("open the console")
  .action(async () => {
    printBanner();

    const port = await getConsolePort();

    await openConsole(port);
  });

program
  .command("app-version")
  .description("get the current app version")
  .option("--json", "output app versions as JSON")
  .action(handleAppVersion);

// Database migration commands
const dbCommand = program
  .command("db")
  .description("Database migration commands");

// db migrate - Primary migration command (always to latest)
dbCommand
  .command("migrate")
  .description("Run database migration (creates tables directly in database)")
  .argument("[configPath]", "path to the config file that exports hotUpdater")
  .option("-y, --yes", "skip confirmation prompt", false)
  .action(async (configPath: string | undefined, options: { yes: boolean }) => {
    await migrate({ configPath: configPath || "", skipConfirm: options.yes });
  });

// db generate - SQL generation command
dbCommand
  .command("generate")
  .description("Generate SQL migration file (does not execute)")
  .argument(
    "[configPath]",
    "path to the config file that exports hotUpdater (not required with --sql)",
  )
  .argument("[outputDir]", "output directory (default: hot-updater_migrations)")
  .option("-y, --yes", "skip confirmation prompt", false)
  .option(
    "--sql [provider]",
    "generate standalone SQL file without reading config. Optional provider: postgresql, mysql, sqlite (default: interactive selection)",
  )
  .action(
    async (
      configPath: string | undefined,
      outputDir: string | undefined,
      options: { yes: boolean; sql?: string | true },
    ) => {
      const sql = options.sql === true ? true : options.sql || false;
      const isStandaloneSql = sql !== false;

      await generate({
        configPath: isStandaloneSql ? "" : configPath || "",
        outputDir:
          isStandaloneSql && outputDir === undefined ? configPath : outputDir,
        skipConfirm: options.yes,
        sql,
      });
      process.exit(0);
    },
  );

const catalogCommand = dbCommand
  .command("catalog")
  .description("Verify and rebuild compiled Release catalogs");

catalogCommand
  .command("preflight")
  .description("Verify catalog projections without writing")
  .argument(
    "[scope-keys...]",
    "specific scope keys; defaults to all Release and Catalog scopes",
  )
  .option("--json", "output JSON")
  .action(handleCatalogPreflight);

catalogCommand
  .command("rebuild")
  .description("Create missing or rebuild drifted catalog projections")
  .argument(
    "[scope-keys...]",
    "specific scope keys; defaults to all Release and Catalog scopes",
  )
  .option("--json", "output JSON")
  .option("-y, --yes", "skip confirmation prompt")
  .action(handleCatalogRebuild);

program
  .command("build:android")
  .description("build a new Android native artifact")
  .addOption(nativeBuildOutputCommandOption)
  .addOption(interactiveCommandOption)
  .addOption(nativeBuildSchemeCommandOption)
  .addOption(
    new Option(
      "-m, --message <message>",
      "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
    ),
  )
  .action(async (options: Omit<NativeBuildOptions, "platform">) => {
    await buildAndroidNative(options);
  });

if (process.env["EXPERIMENTAL"]) {
  program
    .command("build:ios")
    .description("build a new iOS native artifact")
    .addOption(nativeBuildOutputCommandOption)
    .addOption(interactiveCommandOption)
    .addOption(nativeBuildSchemeCommandOption)
    .addOption(
      new Option(
        "-m, --message <message>",
        "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
      ),
    )
    .action(async (options: Omit<NativeBuildOptions, "platform">) => {
      await buildIosNative(options);
    });

  program
    .command("run:android")
    .description("build and run Android app to device or emulator")
    .addOption(nativeBuildOutputCommandOption)
    .addOption(interactiveCommandOption)
    .addOption(nativeBuildSchemeCommandOption)
    .addOption(deviceCommandOption)
    .addOption(portCommandOption)
    .addOption(appIdSuffixCommandOption)
    .addOption(
      new Option(
        "-m, --message <message>",
        "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
      ),
    )
    .action(async (options: AndroidNativeRunOptions) => {
      await runAndroidNative(options);
    });

  program
    .command("run:ios")
    .description("build and run iOS app to device or simulator")
    .addOption(nativeBuildOutputCommandOption)
    .addOption(interactiveCommandOption)
    .addOption(nativeBuildSchemeCommandOption)
    .addOption(deviceCommandOption)
    .addOption(
      new Option(
        "-m, --message <message>",
        "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
      ),
    )
    .action(async (options: IosNativeRunOptions) => {
      await runIosNative(options);
    });
}

program.hook("preAction", () => {
  ensureNoConflicts();
});

program.parse(process.argv);
