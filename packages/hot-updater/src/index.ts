#!/usr/bin/env node
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { getPluginEnv } from "@/commands/getPluginEnv";
import { init } from "@/commands/init";
import { banner, printBanner } from "@/components/banner";
import { version } from "@/packageJson";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import * as p from "@clack/prompts";
import { getCwd, log } from "@hot-updater/plugin-core";
import { Command, Option } from "commander";
import picocolors from "picocolors";
import semverValid from "semver/ranges/valid";

const program = new Command();

program
  .name("hot-updater")
  .description(banner)
  .version(version as string);

program.command("init").description("Initialize Hot Updater").action(init);

program
  .command("get-plugin-env")
  .description("Get the environment variables for the plugin")
  .action(getPluginEnv);

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
  .addOption(new Option("-i, --interactive", "interactive mode").default(false))
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
    const path = getCwd();
    const androidVersion = await getDefaultTargetAppVersion(path, "android");
    const iosVersion = await getDefaultTargetAppVersion(path, "ios");

    log.info(`Android version: ${androidVersion}`);
    log.info(`iOS version: ${iosVersion}`);
  });

program.parse(process.argv);
