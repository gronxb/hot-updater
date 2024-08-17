import { Banner } from "@/components/Banner.js";
import { getCwd } from "@/cwd.js";
import { useLog } from "@/hooks/useLog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSpinner } from "@/hooks/useSpinner.js";
import { createZip } from "@/utils/createZip.js";
import { delay } from "@/utils/delay.js";
import { formatDate } from "@/utils/formatDate.js";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion.js";
import { getFileHashFromFile } from "@/utils/getFileHash.js";
import { loadConfig } from "@/utils/loadConfig.js";
import { type Platform, filterTargetVersion } from "@hot-updater/internal";
import { StatusMessage, TextInput } from "@inkjs/ui";
import fs from "fs/promises";
import { Box } from "ink";
import { option } from "pastel";
import { useState } from "react";
import { z } from "zod";

export interface DeployOptions {
  targetVersion?: string;
  platform: Platform;
  forceUpdate: boolean;
}

export const options = z.object({
  platform: z
    .union([z.literal("ios"), z.literal("android")])
    .describe(
      option({
        description: "specify the platform",
        alias: "p",
      }),
    )
    .optional(),
  forceUpdate: z
    .boolean()
    .describe(
      option({
        description: "force update the app",
        alias: "f",
      }),
    )
    .default(false),
  targetVersion: z
    .string()
    .describe(
      option({
        description: "specify the target version",
        alias: "t",
      }),
    )
    .optional(),
  description: z
    .string()
    .describe(
      option({
        description: "bundle description",
        alias: "m",
      }),
    )
    .optional(),
});

interface Props {
  options: z.infer<typeof options>;
}

const { build, deploy } = await loadConfig();
const cwd = getCwd();

export default function Deploy({ options }: Props) {
  const { forceUpdate } = options;

  const [step, setStep] = useState<
    "description" | "platform" | "build" | "log"
  >(!options.description ? "description" : "platform");

  const { spinner, SpinnerLog } = useSpinner();
  const { log, StaticLogs } = useLog();

  const [description, setDescription] = useState(options.description);

  const { PlatformSelect } = usePlatform(options.platform);

  const handleDeploy = async (platform: Platform) => {
    setStep("build");

    if (!platform) {
      setStep("log");
      log.error("Platform not found. Please provide a platform.");
      process.exit(1);
    }

    const targetVersion =
      options.targetVersion ?? (await getDefaultTargetVersion(cwd, platform));

    if (!targetVersion) {
      setStep("log");
      log.error("Target version not found. Please provide a target version.");
      process.exit(1);
    }

    delay(50);
    const { buildPath } = await build({
      cwd,
      platform,
      log,
      spinner,
    });
    setStep("log");

    spinner.message("Checking existing updates...");

    await createZip(buildPath, "build.zip");
    const bundlePath = buildPath.concat(".zip");
    const hash = await getFileHashFromFile(bundlePath);

    const newBundleVersion = formatDate(new Date());

    const deployPlugin = deploy({
      cwd,
      log,
      spinner,
    });

    const updateSources = await deployPlugin.getUpdateJson();
    const targetVersions = filterTargetVersion(
      updateSources ?? [],
      targetVersion,
      platform,
    );

    // hash check
    if (targetVersions.length > 0) {
      const recentVersion = targetVersions[0];
      const recentHash = recentVersion?.hash;

      if (recentHash === hash) {
        spinner.error("The update already exists.");
        process.exit(1);
      }
    }

    spinner.message("Uploading bundle...");

    const { file } = await deployPlugin.uploadBundle(
      platform,
      newBundleVersion,
      bundlePath,
    );

    await deployPlugin.appendUpdateJson({
      forceUpdate,
      platform,
      file,
      hash,
      description,
      targetVersion,
      bundleVersion: newBundleVersion,
      enabled: true,
    });
    await deployPlugin.commitUpdateJson();

    await fs.rm(bundlePath);
    spinner.done("Uploading Success !");
  };

  switch (step) {
    case "description": {
      return (
        <Box flexDirection="column">
          <Banner />

          <StatusMessage variant="info">
            Please provide a description for the bundle.
          </StatusMessage>

          <TextInput
            placeholder="Description"
            onSubmit={(description) => {
              setDescription(description);
              setStep("platform");
            }}
          />
        </Box>
      );
    }
    case "platform": {
      return (
        <Box flexDirection="column">
          <Banner />

          <StatusMessage variant="info">
            Please select the platform to deploy.
          </StatusMessage>
          <PlatformSelect onNext={handleDeploy} />
        </Box>
      );
    }
    case "build": {
      return null;
    }
    case "log": {
      return (
        <Box flexDirection="column">
          <StaticLogs />
          <SpinnerLog />
        </Box>
      );
    }
  }
}
