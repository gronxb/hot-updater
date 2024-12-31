#!/usr/bin/env node
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { generateSecretKey } from "@/commands/generateSecretKey";
import { prune } from "@/commands/prune";
import { banner } from "@/components/banner";
import { version } from "@/packageJson";
import { getPlatform } from "@/prompts/getPlatform";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import { getCwd, log } from "@hot-updater/plugin-core";
import { Command, Option } from "commander";
import picocolors from "picocolors";

const program = new Command();

program
  .name("hot-updater")
  .description(banner)
  .version(version as string);

program
  .command("init")
  .description("Initialize Hot Updater")
  .action(() => {
    console.log("Initializing Hot Updater");
  });

program
  .command("deploy")
  .description("deploy a new version")
  .addOption(
    new Option("-p, --platform <platform>", "specify the platform").choices([
      "ios",
      "android",
    ]),
  )
  .addOption(
    new Option(
      "-t, --target-version <targetAppVersion>",
      "specify the platform",
    ),
  )
  .addOption(
    new Option("-f, --force-update", "force update the app").default(false),
  )
  .action(async (options: DeployOptions) => {
    if (!options.platform) {
      options.platform = await getPlatform(
        "Which platform do you want to deploy?",
      );
    }
    deploy(options);
  });

program
  .command("console")
  .description("open the console")
  .action(async () => {
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
  .command("generate-secret-key")
  .description("generate a new secret key")
  .action(generateSecretKey);

program
  .command("app-version")
  .description("get the current app version")

  .action(async () => {
    const path = getCwd();
    const androidVersion = await getDefaultTargetAppVersion(path, "android");
    const iosVersion = await getDefaultTargetAppVersion(path, "ios");

    log.info(`Android version: ${androidVersion}`);
    log.info(`iOS version: ${iosVersion}`);
  });

program
  .command("prune")
  .description("prune all the inactive versions")
  .action(prune);
program.parse(process.argv);
