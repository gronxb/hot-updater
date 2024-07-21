import { cwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import * as p from "@clack/prompts";
import { filterTargetVersion, log } from "@hot-updater/internal";
import Table from "cli-table3";

export interface ListOptions {
  platform: "ios" | "android";
  targetVersion?: string;
}

export const list = async (options: ListOptions) => {
  const s = p.spinner();

  const { deploy } = await loadConfig();

  const path = cwd();

  s.start("getting target version");
  const targetVersion =
    options.targetVersion ??
    (await getDefaultTargetVersion(path, options.platform));

  if (!targetVersion) {
    throw new Error(
      "Target version not found. Please provide a target version.",
    );
  }

  const deployPlugin = deploy({
    cwd: path,
    spinner: s,
    ...options,
  });

  s.message("Checking existing updates");
  const updateSources = await deployPlugin.getUpdateJson();

  const targetVersions = filterTargetVersion(
    options.platform,
    targetVersion,
    updateSources,
  );

  if (targetVersions.length === 0) {
    s.stop("No versions found", -1);
    return;
  }
  s.stop();

  const table = new Table({
    head: ["Version", "active"],
  });

  for (const source of targetVersions) {
    table.push([source.bundleVersion, source.enabled]);
  }

  p.log.info(table.toString());
};
