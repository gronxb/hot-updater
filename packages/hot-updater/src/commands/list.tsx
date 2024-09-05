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

export interface ListOptions {
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

export default function List({ options }: Props) {
  const { updateSources } = useUpdateSources({
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

  return (
    <Box flexDirection="column">
      <Banner />

      <StatusMessage variant="info">
        List ({updateSources.length})
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
      />

      {highlightSource ? (
        <Fragment>
          <Text color="gray">Current</Text>
          <BundleInfoTable source={highlightSource} />
        </Fragment>
      ) : null}
    </Box>
  );
}
