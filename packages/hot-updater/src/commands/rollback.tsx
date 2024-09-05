import { Banner } from "@/components/Banner.js";
import { BundleInfoTable } from "@/components/BundleInfoTable.js";
import { SelectInput } from "@/components/SelectInput.js";
import { useUpdateSources } from "@/hooks/useUpdateSources.js";
import {
  type Platform,
  type UpdateSource,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { StatusMessage } from "@inkjs/ui";
import { Box, Text } from "ink";
import { option } from "pastel";
import { Fragment, useEffect, useState } from "react";
import { z } from "zod";

export interface RollbackOptions {
  platform?: Platform;
  targetVersion?: string;
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
  targetVersion: z
    .string()
    .describe(
      option({
        description: "specify the target version",
        alias: "t",
      }),
    )
    .optional(),
});

interface Props {
  options: z.infer<typeof options>;
}

const { deploy } = await loadConfig();
const cwd = getCwd();
const deployPlugin = deploy({
  cwd,
});

export default function Rollback({ options }: Props) {
  const { updateSources, refresh } = useUpdateSources({
    deployPlugin,
    platform: options.platform,
    targetVersion: options.targetVersion,
  });

  const [highlightSource, setHighlightSource] = useState<UpdateSource | null>(
    null,
  );

  useEffect(() => {
    if (updateSources.length > 0 && highlightSource === null) {
      setHighlightSource(updateSources?.[0] ?? null);
    }
  }, [updateSources]);

  const handleRollback = async (updateSource: UpdateSource) => {
    const bundleVersion = updateSource.bundleVersion;

    await deployPlugin.updateUpdateJson(bundleVersion, {
      ...updateSource,
      enabled: !updateSource.enabled,
    });
    await deployPlugin.commitUpdateJson();

    const updateSources = await refresh();
    setHighlightSource(
      updateSources?.find((source) => source.bundleVersion === bundleVersion) ??
        null,
    );
  };

  return (
    <Box flexDirection="column">
      <Banner />

      <StatusMessage variant="info">
        Select the Version to Rollback ({updateSources.length})
      </StatusMessage>

      <SelectInput
        indicatorComponent={({ isSelected }) =>
          isSelected ? <Text>[*] </Text> : <Text>[ ] </Text>
        }
        initialIndex={
          updateSources.findIndex((source) => source === highlightSource) ?? 0
        }
        isFocused={true}
        items={updateSources.map((source) => {
          return {
            label: `${source.bundleVersion} (${source.platform})`,
            value: source,
            key: source.bundleVersion,
          } as { label: string; value: UpdateSource };
        })}
        onHighlight={(item) => setHighlightSource(item.value)}
        onSelect={(updateSource) => handleRollback(updateSource.value)}
      />

      {highlightSource ? (
        <Fragment>
          {highlightSource.enabled ? (
            <Text color="green">{"Current: ACTIVE"}</Text>
          ) : (
            <Text color="red">{"Current: INACTIVE"}</Text>
          )}

          <Text color="gray">Expected</Text>
          <BundleInfoTable
            source={highlightSource}
            widths={{
              active: 30,
            }}
            renders={{
              active: () =>
                highlightSource.enabled ? (
                  <Fragment>
                    <Text color="green">ACTIVE</Text>
                    <Text color="gray"> to </Text>
                    <Text color="red">INACTIVE</Text>
                  </Fragment>
                ) : (
                  <Fragment>
                    <Text color="red">INACTIVE</Text>
                    <Text color="gray"> to </Text>
                    <Text color="green">ACTIVE</Text>
                  </Fragment>
                ),
            }}
          />
        </Fragment>
      ) : null}
    </Box>
  );
}
