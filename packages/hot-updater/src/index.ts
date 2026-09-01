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
import { handleArtifactDelete } from "./commands/artifact";
import {
  handleBundleDelete,
  handleBundleEnablement,
  handleBundleList,
  handleBundlePreflight,
  handleBundleShow,
  handleBundleUpdate,
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

const resolveArtifactIdOption = (
  artifactId: string | undefined,
  legacyBundleId: string | undefined,
  flag: "--artifact-id" | "--base-artifact-id",
): string => {
  if (artifactId && legacyBundleId && artifactId !== legacyBundleId) {
    p.log.error(`Provide only one value for ${flag}.`);
    process.exit(1);
  }
  const value = artifactId ?? legacyBundleId;
  if (!value) {
    p.log.error(`Missing required option ${flag} <artifact-id>.`);
    process.exit(1);
  }
  return value;
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
  .description("List bundles, most recent first")
  .option("-c, --channel <channel>", "filter by channel")
  .option(
    "--target-app-version <targetAppVersion>",
    "filter by exact target app version",
  )
  .option("--json", "output raw internal data as JSON")
  .addOption(platformCommandOption)
  .option(
    "--limit <n>",
    "limit the number of results",
    (value) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0 || n > 1000) {
        throw new InvalidArgumentError("must be an integer from 1 to 1000");
      }
      return n;
    },
    20,
  )
  .action(handleBundleList);

bundleCommand
  .command("show")
  .description("Show one bundle by ID")
  .argument("<id>", "the ID shown in the console or HotUpdater.getBundleId()")
  .option("--json", "output raw internal data as JSON")
  .action((id: string, options: { json?: boolean }) =>
    handleBundleShow(id, options),
  );

const addBundlePolicyOptions = <
  TArgs extends unknown[],
  TOptions extends Record<string, unknown>,
  TGlobalOptions extends Record<string, unknown>,
>(
  command: Command<TArgs, TOptions, TGlobalOptions>,
) =>
  command
    .option("--message <message>", "set the bundle message")
    .option("--clear-message", "clear the bundle message")
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
      "fail if the bundle revision changed",
      (value) => {
        const revision = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return revision;
      },
    )
    .option("--json", "output JSON");

addBundlePolicyOptions(
  bundleCommand
    .command("update")
    .description("Update bundle rollout and targeting")
    .argument("<id>", "the ID shown in the console or HotUpdater.getBundleId()")
    .option("-y, --yes", "skip confirmation prompt"),
).action(handleBundleUpdate);

addBundlePolicyOptions(
  bundleCommand
    .command("preflight")
    .description("Validate a bundle update without saving")
    .argument(
      "<id>",
      "the ID shown in the console or HotUpdater.getBundleId()",
    ),
).action(handleBundlePreflight);

for (const [name, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  bundleCommand
    .command(name)
    .description(
      enabled
        ? "Enable a bundle"
        : "Disable a bundle and re-resolve compatible delivery",
    )
    .argument("<id>", "the ID shown in the console or HotUpdater.getBundleId()")
    .option(
      "--expected-revision <revision>",
      "expected bundle revision",
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
      handleBundleEnablement(releaseId, enabled, options),
    );
}

bundleCommand
  .command("delete")
  .description("Delete a disabled bundle")
  .argument("<id>", "the ID shown in the console or HotUpdater.getBundleId()")
  .option(
    "--expected-revision <revision>",
    "expected bundle revision",
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
  .action(handleBundleDelete);

bundleCommand
  .command("promote")
  .description("Copy or move a bundle to another channel")
  .argument("<source-id>", "the source ID shown in the console")
  .requiredOption("-t, --target <channel>", "target channel")
  .addOption(
    new Option(
      "-a, --action <action>",
      "copy keeps the source enabled; move disables it",
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

const artifactCommand = bundleCommand
  .command("artifact")
  .description("Advanced immutable artifact maintenance");

artifactCommand
  .command("delete")
  .description("Delete unreferenced artifact records")
  .argument("<artifact-ids...>", "the artifact ID(s) from Advanced diagnostics")
  .option("-y, --yes", "skip confirmation prompt")
  .action((artifactIds: string[], options: { yes?: boolean }) =>
    handleArtifactDelete(artifactIds, options),
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
  .option(
    "-o, --output <path>",
    "write the public key to an Expo trust-anchor file",
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
  .description("Build and deploy a bundle")
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
    new Option("-d, --disabled", "create the bundle disabled").default(false),
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
      "specify the rollout percentage for the new bundle (0-100)",
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
  .option(
    "-b, --artifact-id <artifact-id>",
    "target artifact ID from Advanced diagnostics",
  )
  .option(
    "--base-artifact-id <artifact-id>",
    "older artifact ID from Advanced diagnostics to use as the patch base",
  )
  .addOption(
    new Option(
      "--bundle-id <artifact-id>",
      "deprecated alias for --artifact-id",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--base-bundle-id <artifact-id>",
      "deprecated alias for --base-artifact-id",
    ).hideHelp(),
  )
  .addOption(platformCommandOption)
  .addOption(interactiveCommandOption)
  .addOption(
    new Option(
      "-c, --channel <channel>",
      "specify the channel used to load config",
    ).default(DEFAULT_CHANNEL),
  )
  .action(async (options) => {
    if (options.bundleId) {
      p.log.warn(
        "--bundle-id is deprecated. Use --artifact-id with an Artifact ID from Advanced diagnostics.",
      );
    }
    if (options.baseBundleId) {
      p.log.warn(
        "--base-bundle-id is deprecated. Use --base-artifact-id with an Artifact ID from Advanced diagnostics.",
      );
    }
    await createPatch({
      ...options,
      bundleId: resolveArtifactIdOption(
        options.artifactId,
        options.bundleId,
        "--artifact-id",
      ),
      baseBundleId: resolveArtifactIdOption(
        options.baseArtifactId,
        options.baseBundleId,
        "--base-artifact-id",
      ),
    } satisfies PatchOptions);
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
