// #!/usr/bin/env node
// import meow from "meow";
export {};
// import { type Platform, log } from "@hot-updater/internal";
// import { render } from "ink";
// import { App } from "./App.js";
// import { Deploy, deploy } from "./commands/deploy.js";
// import { Rollback } from "./commands/rollback.js";
// import { CliContext } from "./context.js";
// import { getCwd } from "./cwd.js";
// import { getDefaultTargetVersion } from "./utils/getDefaultTargetVersion.js";
// import { loadConfig } from "./utils/loadConfig.js";
// const cli = meow(
//   `
//     Usage
//       $ hot-updater <command> [options]
//     Commands
//       version                 Get the current version
//       deploy                  Deploy a new version
//       generate-secret-key     Generate a new secret key
//       app-version             Get the current app version
//       rollback                Rollback to the previous version
//       list                    List all the versions
//       prune                   Prune all the inactive versions
//       Options
//       -p, --platform <platform>        Specify the platform (choices: ios, android)
//       -t, --target-version <targetVersion>  Specify the target version
//       -f, --force-update              Force update the app (default: false)
//   `,
//   {
//     importMeta: import.meta,
//     flags: {
//       platform: {
//         type: "string",
//         shortFlag: "p",
//         choices: ["ios", "android"],
//       },
//       targetVersion: {
//         type: "string",
//         shortFlag: "t",
//       },
//       forceUpdate: {
//         type: "boolean",
//         shortFlag: "f",
//         default: false,
//       },
//     },
//   },
// );
// if (cli.input.length === 0) {
//   log.normal(cli.help);
//   process.exit(0);
// }
// const run = async () => {
//   const config = await loadConfig();
//   const cwd = getCwd();
//   switch (cli.input.at(0)) {
//     case "deploy": {
//       const { waitUntilExit } = render(
//         <CliContext.Provider value={{ config, cwd }}>
//           <Deploy
//             platform={cli.flags.platform as Platform}
//             targetVersion={cli.flags.targetVersion}
//             forceUpdate={cli.flags.forceUpdate}
//           />
//         </CliContext.Provider>,
//       );
//       break;
//     }
//     case "rollback": {
//       render(
//         <CliContext.Provider value={{ config, cwd }}>
//           <Rollback
//             platform={cli.flags.platform as Platform}
//             targetVersion={cli.flags.targetVersion}
//           />
//         </CliContext.Provider>,
//       );
//       break;
//     }
//     default: {
//       log.normal(cli.help);
//       break;
//     }
//   }
// };
// run();
// // intro(`${picocolors.bgCyan(picocolors.black(" hot-updater "))}`);
// // const program = new Command();
// // program
// //   .name("hot-updater")
// //   .description("CLI to React Native OTA solution for self-hosted")
// //   .version(version);
// // program
// //   .command("deploy")
// //   .description("deploy a new version")
// //   .addOption(
// //     new Option("-p, --platform <platform>", "specify the platform").choices([
// //       "ios",
// //       "android",
// //     ]),
// //   )
// //   .addOption(
// //     new Option("-t, --target-version <targetVersion>", "specify the platform"),
// //   )
// //   .addOption(
// //     new Option("-f, --force-update", "force update the app").default(false),
// //   )
// //   .action(async (options: DeployOptions) => {
// //     if (!options.platform) {
// //       options.platform = await getPlatform(
// //         "Which platform do you want to deploy?",
// //       );
// //     }
// //     deploy(options);
// //   });
// // program
// //   .command("generate-secret-key")
// //   .description("generate a new secret key")
// //   .action(generateSecretKey);
// // program
// //   .command("app-version")
// //   .description("get the current app version")
// //   .action(async () => {
// //     const path = getCwd();
// //     const androidVersion = await getDefaultTargetVersion(path, "android");
// //     const iosVersion = await getDefaultTargetVersion(path, "ios");
// //     log.info(`Android version: ${androidVersion}`);
// //     log.info(`iOS version: ${iosVersion}`);
// //   });
// // program
// //   .command("rollback")
// //   .description("rollback to the previous version")
// //   .addOption(
// //     new Option("-t, --target-version <targetVersion>", "specify the platform"),
// //   )
// //   .addOption(
// //     new Option("-p, --platform <platform>", "specify the platform").choices([
// //       "ios",
// //       "android",
// //     ]),
// //   )
// //   .action(async (options) => {
// //     rollback(options);
// //   });
// // program
// //   .command("list")
// //   .description("list all the versions")
// //   .addOption(
// //     new Option("-t, --target-version <targetVersion>", "specify the platform"),
// //   )
// //   .addOption(
// //     new Option("-p, --platform <platform>", "specify the platform").choices([
// //       "ios",
// //       "android",
// //     ]),
// //   )
// //   .action(async (options) => {
// //     list(options);
// //   });
// // program
// //   .command("prune")
// //   .description("prune all the inactive versions")
// //   .addOption(
// //     new Option("-p, --platform <platform>", "specify the platform").choices([
// //       "ios",
// //       "android",
// //     ]),
// //   )
// //   .action(async (options) => {
// //     if (!options.platform) {
// //       options.platform = await getPlatform(
// //         "Which platform do you want to prune?",
// //       );
// //     }
// //     prune(options);
// //   });
// // program.parse();
