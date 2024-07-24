import { getCwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import { createTable } from "@/utils/table";
import * as p from "@clack/prompts";
import { type Platform, filterTargetVersion } from "@hot-updater/internal";

export interface ListOptions {
  platform: Platform;
  targetVersion?: string;
}

export const list = async (options: ListOptions) => {
  const s = p.spinner();

  const { deploy } = await loadConfig();

  const cwd = getCwd();

  s.start("getting target version");
  let targetVersion: string | null = "*";
  if (options.targetVersion) {
    targetVersion = options.targetVersion;
  }
  if (!options.targetVersion && options.platform) {
    targetVersion = await getDefaultTargetVersion(cwd, options.platform);
  }

  if (!targetVersion) {
    throw new Error(
      "Target version not found. Please provide a target version.",
    );
  }

  const deployPlugin = deploy({
    cwd,
    spinner: s,
  });

  s.message("Checking existing updates");
  const updateSources = await deployPlugin.getUpdateJson();

  const targetVersions = filterTargetVersion(
    updateSources,
    targetVersion,
    options?.platform,
  );

  if (targetVersions.length === 0) {
    s.stop("No versions found", -1);
    return;
  }
  s.stop();

  await p.select({
    message: "Select versions to rollback",
    maxItems: 3,
    initialValue: targetVersions[0],
    // options: targetVersions.map(
    options: [...targetVersions, ...targetVersions, ...targetVersions].map(
      (source) => {
        const { table, pushTable } = createTable();
        pushTable(source);

        return {
          label: ["\n", table.toString(), "\n"].join(""),
          value: source,
        };
      },
    ),
  });
};
