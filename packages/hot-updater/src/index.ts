#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { init } from "@/commands/init";
import { version } from "@/packageJson";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import * as p from "@clack/prompts";
import { banner, getCwd, loadConfig, log } from "@hot-updater/plugin-core";
import { type FingerprintResult, nativeFingerprint } from "@rnef/tools";
import { Command, Option } from "commander";
import picocolors from "picocolors";
import semverValid from "semver/ranges/valid";
import { printBanner } from "./utils/printBanner";

const DEFAULT_CHANNEL = "production";

const program = new Command();

program
  .name("hot-updater")
  .description(banner(version))
  .version(version as string);

program.command("init").description("Initialize Hot Updater").action(init);

const fingerprintCommand = program
  .command("fingerprint")
  .description("Generate fingerprint");

fingerprintCommand.action(async () => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }

  const fingerPrintRef = {
    ios: null as FingerprintResult | null,
    android: null as FingerprintResult | null,
  };
  await p.tasks([
    {
      title: "Generating fingerprint (iOS)",
      task: async () => {
        const fingerprint = await nativeFingerprint(getCwd(), {
          platform: "ios",
          ...config.fingerprint,
        });
        fingerPrintRef.ios = fingerprint;
        return `Fingerprint(iOS): ${fingerprint.hash}`;
      },
    },
    {
      title: "Generating fingerprint (Android)",
      task: async () => {
        const fingerprint = await nativeFingerprint(getCwd(), {
          platform: "android",
          ...config.fingerprint,
        });
        fingerPrintRef.android = fingerprint;
        return `Fingerprint(Android): ${fingerprint.hash}`;
      },
    },
  ]);

  const localFingerprintPath = path.join(getCwd(), "fingerprint.json");
  if (!fs.existsSync(localFingerprintPath)) {
    return;
  }

  const readFingerprint = await fs.promises.readFile(
    localFingerprintPath,
    "utf-8",
  );
  const localFingerprint = JSON.parse(readFingerprint);
  if (localFingerprint.ios.hash !== fingerPrintRef.ios?.hash) {
    p.log.error(
      "iOS fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );
    process.exit(1);
  }

  if (localFingerprint.android.hash !== fingerPrintRef.android?.hash) {
    p.log.error(
      "Android fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );
    process.exit(1);
  }

  p.log.success("Fingerprint matched");
});

fingerprintCommand
  .command("create")
  .description("Create fingerprint")
  .action(async () => {
    await p.tasks([
      {
        title: "Creating fingerprint.json",
        task: async () => {
          const config = await loadConfig(null);
          if (config.updateStrategy === "appVersion") {
            p.log.error(
              "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
            );
            process.exit(1);
          }

          const [ios, android] = await Promise.all([
            nativeFingerprint(getCwd(), {
              platform: "ios",
              ...config.fingerprint,
            }),
            nativeFingerprint(getCwd(), {
              platform: "android",
              ...config.fingerprint,
            }),
          ]);
          const fingerprint = {
            ios: ios,
            android: android,
          };
          await fs.promises.writeFile(
            path.join(getCwd(), "fingerprint.json"),
            JSON.stringify(fingerprint, null, 2),
          );
          return "Created fingerprint.json";
        },
      },
    ]);
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
  .addOption(new Option("-i, --interactive", "interactive mode").default(false))
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
    const path = getCwd();
    const androidVersion = await getDefaultTargetAppVersion(path, "android");
    const iosVersion = await getDefaultTargetAppVersion(path, "ios");

    log.info(`Android version: ${androidVersion}`);
    log.info(`iOS version: ${iosVersion}`);
  });

program.parse(process.argv);
