#!/usr/bin/env node
import { type NativeBuildOptions, nativeBuild } from "@/commands/buildNative";
import {
  interactiveCommandOption,
  platformCommandOption,
} from "@/commandOptions";
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { init } from "@/commands/init";
import { version } from "@/packageJson";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import * as p from "@clack/prompts";
import { Command, Option } from "@commander-js/extra-typings";
import { banner, log } from "@hot-updater/plugin-core";
import picocolors from "picocolors";
import semverValid from "semver/ranges/valid";
import { handleChannel, handleSetChannel } from "./commands/channel";
import { handleDoctor } from "./commands/doctor";
import {
  handleCreateFingerprint,
  handleFingerprint,
} from "./commands/fingerprint";

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
        `Server running on ${picocolors.magenta(
          picocolors.underline(`http://localhost:${info.port}`),
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
