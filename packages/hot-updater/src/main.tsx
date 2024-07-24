#!/usr/bin/env node
import { render } from "ink";
import { App } from "./App.js";

render(<App name={"Ad"} />);

// intro(`${picocolors.bgCyan(picocolors.black(" hot-updater "))}`);

// const program = new Command();
// program
//   .name("hot-updater")
//   .description("CLI to React Native OTA solution for self-hosted")
//   .version(version);

// program
//   .command("deploy")
//   .description("deploy a new version")
//   .addOption(
//     new Option("-p, --platform <platform>", "specify the platform").choices([
//       "ios",
//       "android",
//     ]),
//   )
//   .addOption(
//     new Option("-t, --target-version <targetVersion>", "specify the platform"),
//   )
//   .addOption(
//     new Option("-f, --force-update", "force update the app").default(false),
//   )
//   .action(async (options: DeployOptions) => {
//     if (!options.platform) {
//       options.platform = await getPlatform(
//         "Which platform do you want to deploy?",
//       );
//     }
//     deploy(options);
//   });

// program
//   .command("generate-secret-key")
//   .description("generate a new secret key")
//   .action(generateSecretKey);

// program
//   .command("app-version")
//   .description("get the current app version")

//   .action(async () => {
//     const path = getCwd();
//     const androidVersion = await getDefaultTargetVersion(path, "android");
//     const iosVersion = await getDefaultTargetVersion(path, "ios");

//     log.info(`Android version: ${androidVersion}`);
//     log.info(`iOS version: ${iosVersion}`);
//   });

// program
//   .command("rollback")
//   .description("rollback to the previous version")
//   .addOption(
//     new Option("-t, --target-version <targetVersion>", "specify the platform"),
//   )
//   .addOption(
//     new Option("-p, --platform <platform>", "specify the platform").choices([
//       "ios",
//       "android",
//     ]),
//   )
//   .action(async (options) => {
//     rollback(options);
//   });

// program
//   .command("list")
//   .description("list all the versions")
//   .addOption(
//     new Option("-t, --target-version <targetVersion>", "specify the platform"),
//   )
//   .addOption(
//     new Option("-p, --platform <platform>", "specify the platform").choices([
//       "ios",
//       "android",
//     ]),
//   )
//   .action(async (options) => {
//     list(options);
//   });

// program
//   .command("prune")
//   .description("prune all the inactive versions")
//   .addOption(
//     new Option("-p, --platform <platform>", "specify the platform").choices([
//       "ios",
//       "android",
//     ]),
//   )
//   .action(async (options) => {
//     if (!options.platform) {
//       options.platform = await getPlatform(
//         "Which platform do you want to prune?",
//       );
//     }
//     prune(options);
//   });

// program.parse();
