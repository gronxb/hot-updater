#!/usr/bin/env node
import { Command, Option } from "@commander-js/extra-typings";
import type { AndroidNativeRunOptions } from "@hot-updater/android-helper";
import type { IosNativeRunOptions } from "@hot-updater/apple-helper";
import { banner, log, p } from "@hot-updater/cli-tools";
import type { NativeBuildOptions } from "@hot-updater/plugin-core";
import semverValid from "semver/ranges/valid";

import {
  appIdSuffixCommandOption,
  deviceCommandOption,
  interactiveCommandOption,
  nativeBuildOutputCommandOption,
  nativeBuildSchemeCommandOption,
  platformCommandOption,
  portCommandOption,
} from "@/commandOptions";
import { buildAndroidNative, buildIosNative } from "@/commands/buildNative";
import { getConsolePort, openConsole } from "@/commands/console";
import {
  type DeployOptions,
  deploy,
  normalizeRolloutPercentage,
} from "@/commands/deploy";
import { init } from "@/commands/init";
import { runAndroidNative, runIosNative } from "@/commands/runNative";
import { version } from "@/packageJson";
import { ensureNoConflicts } from "@/utils/conflictDetection";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { handleChannel, handleSetChannel } from "./commands/channel";
import { handleDoctor } from "./commands/doctor";
import {
  handleCreateFingerprint,
  handleFingerprint,
} from "./commands/fingerprint";
import { generate } from "./commands/generate";
import { keysExportPublic, keysGenerate, keysRemove } from "./commands/keys";
import { migrate } from "./commands/migrate";
import { handleRollback } from "./commands/rollback";

const DEFAULT_CHANNEL = "production";

const program = new Command();

program
  .name("hot-updater")
  .description(banner(version))
  .version(version as string);

program.command("init").description("Initialize Hot Updater").action(init);

program
  .command("doctor")
  .description("Check the health of Hot Updater")
  .option(
    "--server-base-url <url>",
    "server base URL used by update checks (doctor appends /version)",
  )
  .action(handleDoctor);

const fingerprintCommand = program
  .command("fingerprint")
  .description("Generate fingerprint");

fingerprintCommand.action(handleFingerprint);

fingerprintCommand
  .command("create")
  .description("Create fingerprint")
  .action(handleCreateFingerprint);

const channelCommand = program
  .command("channel")
  .description("Manage channels");

channelCommand.action(handleChannel);

channelCommand
  .command("set")
  .description("Set the channel for Android (BuildConfig) and iOS (Info.plist)")
  .argument("<channel>", "the channel to set")
  .action(handleSetChannel);

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
    "path to private key file (default: from config signing.privateKeyPath in hot-updater.config.ts)",
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
  .description("deploy a new version")
  .addOption(platformCommandOption)
  .addOption(
    new Option(
      "-t, --target-app-version <targetAppVersion>",
      "specify the target app version (semver format e.g. 1.0.0, 1.x.x)",
    ).argParser((value) => {
      if (!semverValid(value)) {
        p.log.error("Invalid semver format (e.g. 1.0.0, 1.x.x)");
        process.exit(1);
      }
      return value;
    }),
  )
  .addOption(new Option("-d, --disabled", "disable the update").default(false))
  .addOption(
    new Option("-f, --force-update", "force update the app").default(false),
  )
  .addOption(
    new Option(
      "-o, --bundle-output-path <bundleOutputPath>",
      "the path where the bundle.zip will be generated",
    ),
  )
  .addOption(
    new Option(
      "-r, --rollout <percentage>",
      "specify the rollout percentage for the deployed bundle (0-100)",
    )
      .argParser((value) => {
        try {
          return normalizeRolloutPercentage(value);
        } catch (error) {
          p.log.error((error as Error).message);
          process.exit(1);
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
  .action(async (options: DeployOptions) => {
    deploy(options);
  });

program
  .command("rollback")
  .description("Disable the most recent enabled bundle on a channel")
  .argument("<channel>", "the channel to roll back")
  .addOption(platformCommandOption)
  .option("-y, --yes", "skip confirmation prompt")
  .option(
    "--confirm-revert-to-binary",
    "allow rollback even when no other enabled bundle exists for that platform",
  )
  .option(
    "--target <bundle-id>",
    "scope rollback to exactly this bundle id (use to retry a failed rollback)",
  )
  .addHelpText(
    "after",
    `\nFour phases: read (pull up to two most-recent enabled bundles per platform),\nvalidate (refuse if a platform would have no enabled bundle, unless\n--confirm-revert-to-binary), mutate (one commitBundle for all platforms\n— note: commit is sequential, not atomic across platforms), verify\n(re-read each target).\n\nExit codes:\n  0  rollback succeeded and verified\n  1  validation, mutation, or post-mutate verification failed\n  2  user declined the interactive confirmation\n\nWhen rollback partially fails, the FAILED line names the exact bundle id;\nretry the failed platform with: hot-updater rollback <channel> -p <platform> --target <bundle-id>\n\nExamples:\n  hot-updater rollback production -y\n  hot-updater rollback production -p ios --confirm-revert-to-binary -y\n  hot-updater rollback production -p android --target 0195a408-... -y\n`,
  )
  .action(
    (
      channel: string,
      options: {
        platform?: "ios" | "android";
        yes?: boolean;
        confirmRevertToBinary?: boolean;
        target?: string;
      },
    ) => handleRollback(channel, options),
  );

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
  .action(async () => {
    const androidVersion = await getNativeAppVersion("android");
    const iosVersion = await getNativeAppVersion("ios");

    log.info(`Android version: ${androidVersion}`);
    log.info(`iOS version: ${iosVersion}`);
  });

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
      await generate({
        configPath: configPath || "",
        outputDir,
        skipConfirm: options.yes,
        sql: options.sql === true ? true : options.sql || false,
      });
      process.exit(0);
    },
  );

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
