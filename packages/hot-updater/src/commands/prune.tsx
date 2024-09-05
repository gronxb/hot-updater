import { Banner } from "@/components/Banner.js";
import { SelectInput } from "@/components/SelectInput.js";
import { useLog } from "@/hooks/useLog.js";
import { useSpinner } from "@/hooks/useSpinner.js";
import { useUpdateSources } from "@/hooks/useUpdateSources.js";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";
import { StatusMessage } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { option } from "pastel";
import { z } from "zod";

export interface PruneOptions {
  platform?: Platform;
}

export const options = z.object({
  platform: z.union([z.literal("ios"), z.literal("android")]).describe(
    option({
      description: "specify the platform",
      alias: "p",
    }),
  ),
});

interface Props {
  options: z.infer<typeof options>;
}

const { deploy } = await loadConfig();
const cwd = getCwd();
const deployPlugin = deploy({
  cwd,
});

export default function Prune({ options }: Props) {
  const { updateSources } = useUpdateSources({
    deployPlugin,
    platform: options.platform,
  });

  const { StaticLogs, log } = useLog();
  const { SpinnerLog, spinner } = useSpinner();
  const { exit } = useApp();

  const inactiveSources = updateSources.filter((source) => !source.enabled);

  const handlePrune = async () => {
    const activeSources = updateSources.filter((source) => source.enabled);
    const inactiveSources = updateSources.filter((source) => !source.enabled);

    if (inactiveSources.length === 0) {
      log.error("No inactive versions found");
      exit();
      return;
    }

    spinner.message("Pruning updates");

    await deployPlugin.setUpdateJson(activeSources);
    await deployPlugin.commitUpdateJson();

    for (const source of inactiveSources) {
      const key = await deployPlugin.deleteBundle(
        options.platform,
        source.bundleVersion,
      );
      log.success(`deleting: ${key}`);
    }
  };

  return (
    <Box flexDirection="column">
      <Banner />

      <StatusMessage variant="info">
        Found {inactiveSources.length} inactive bundles. Do you want to delete
        them?
      </StatusMessage>

      <SelectInput
        indicatorComponent={({ isSelected }) =>
          isSelected ? <Text>[*] </Text> : <Text>[ ] </Text>
        }
        items={[
          {
            label: "No",
            value: false,
          },
          {
            label: "Yes",
            value: true,
          },
        ]}
        onSelect={(item) => {
          if (!item.value) {
            exit();
          }
          handlePrune();
        }}
      />

      <StaticLogs />
      <SpinnerLog />
    </Box>
  );
}
