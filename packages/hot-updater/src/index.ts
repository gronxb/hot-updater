#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { getConsolePort, openConsole } from "@/commands/console";
import { type DeployOptions, deploy } from "@/commands/deploy";
import { init } from "@/commands/init";
import { version } from "@/packageJson";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import * as p from "@clack/prompts";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type ConfigResponse,
  banner,
  getCwd,
  loadConfig,
  log,
} from "@hot-updater/plugin-core";
import { type FingerprintResult, nativeFingerprint } from "@rnef/tools";

import picocolors from "picocolors";
import semverValid from "semver/ranges/valid";
import { printBanner } from "./utils/printBanner";
import { getChannel, setChannel } from "./utils/setChannel";

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
    const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");

    const createFingerprintData = async (config: ConfigResponse) => {
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
      return { ios, android };
    };

    const readLocalFingerprint = async (): Promise<{
      ios: FingerprintResult | null;
      android: FingerprintResult | null;
    } | null> => {
      try {
        const content = await fs.promises.readFile(
          FINGERPRINT_FILE_PATH,
          "utf-8",
        );
        return JSON.parse(content);
      } catch {
        return null;
      }
    };

    let diffChanged = false;
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

          const newFingerprint = await createFingerprintData(config);
          const localFingerprint = await readLocalFingerprint();

          if (
            !localFingerprint ||
            localFingerprint?.ios?.hash !== newFingerprint.ios.hash ||
            localFingerprint?.android?.hash !== newFingerprint.android.hash
          ) {
            diffChanged = true;
          }

          await fs.promises.writeFile(
            FINGERPRINT_FILE_PATH,
            JSON.stringify(newFingerprint, null, 2),
          );
          return "Created fingerprint.json";
        },
      },
    ]);

    if (diffChanged) {
      p.log.success(
        picocolors.bold(
          `${picocolors.blue("fingerprint.json")} has changed, you need to rebuild the native app.`,
        ),
      );
    }
  });

const channelCommand = program
  .command("channel")
  .description("Manage channels");

channelCommand.action(async () => {
  const androidChannel = await getChannel("android");
  const iosChannel = await getChannel("ios");
  p.log.info(
    `Current Android channel: ${picocolors.green(androidChannel.value)}`,
  );
  p.log.info(`  from: ${picocolors.blue(androidChannel.path)}`);
  p.log.info(`Current iOS channel: ${picocolors.green(iosChannel.value)}`);
  p.log.info(`  from: ${picocolors.blue(iosChannel.path)}`);
});

channelCommand
  .command("set")
  .description("Set the channel for Android (BuildConfig) and iOS (Info.plist)")
  .argument("<channel>", "the channel to set")
  .action(async (channel) => {
    const { path: androidPath } = await setChannel("android", channel);
    p.log.success(`Set Android channel to: ${picocolors.green(channel)}`);
    p.log.info(`  from: ${picocolors.blue(androidPath)}`);

    const { path: iosPath } = await setChannel("ios", channel);
    p.log.success(`Set iOS channel to: ${picocolors.green(channel)}`);
    p.log.info(`  from: ${picocolors.blue(iosPath)}`);

    p.log.success(
      "You need to rebuild the native app if the channel has changed.",
    );
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
