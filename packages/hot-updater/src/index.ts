#!/usr/bin/env node
import { Command, Option } from "@commander-js/extra-typings";
import { banner, colors, log, p } from "@hot-updater/cli-tools";
import semverValid from "semver/ranges/valid";
import {
  interactiveCommandOption,
  platformCommandOption,
} from "@/commandOptions";
import { type NativeBuildOptions, nativeBuild } from "@/commands/buildNative";
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { init } from "@/commands/init";
import { version } from "@/packageJson";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import { handleChannel, handleSetChannel } from "./commands/channel";
import { handleDoctor } from "./commands/doctor";
import {
  handleCreateFingerprint,
  handleFingerprint,
} from "./commands/fingerprint";
import { generate } from "./commands/generate";
import { keysExportPublic, keysGenerate } from "./commands/keys";
import { migrate } from "./commands/migrate";

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
  .option("-f, --fix", "fix the issues", false)
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
  .command("console")
  .description("open the console")
  .action(async () => {
    printBanner();

    const port = await getConsolePort();

    await openConsole(port, (info) => {
      console.log(
        `Server running on ${colors.magenta(
          colors.underline(`http://localhost:${info.port}`),
        )}`,
      );
    });
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
  .argument("<configPath>", "path to the config file that exports hotUpdater")
  .option("-y, --yes", "skip confirmation prompt", false)
  .action(async (configPath: string, options: { yes: boolean }) => {
    await migrate({ configPath, skipConfirm: options.yes });
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
    },
  );

// developing command groups
if (process.env["NODE_ENV"] === "development") {
  program
    .command("build:native")
    .description("build a new native artifact and deploy")
    .addOption(
      new Option("-p, --platform <platform>", "specify the platform").choices([
        "ios",
        "android",
      ]),
    )
    .addOption(
      new Option(
        "-o, --output-path <outputPath>",
        "the path where the artifacts will be generated",
      ),
    )
    .addOption(interactiveCommandOption)
    .addOption(
      new Option(
        "-m, --message <message>",
        "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
      ),
    )
    .action(async (options: NativeBuildOptions) => {
      nativeBuild(options);
    });
}

program.parse(process.argv);
