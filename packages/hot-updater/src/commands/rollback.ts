import { cwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import * as p from "@clack/prompts";
import { filterTargetVersion, log } from "@hot-updater/internal";

export interface RollbackOptions {
  platform: "ios" | "android";
  targetVersion?: string;
}

export const rollback = async (options: RollbackOptions) => {
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
    s.stop("No active versions found", -1);
    return;
  }
  s.stop();

  const activeVersions = targetVersions.filter((source) => source.enabled);

  const group = await p.group({
    version: () =>
      p.select({
        maxItems: 5,
        message: `Select versions to rollback (${options.platform})`,
        initialValue: activeVersions[0],
        options: targetVersions.map((source) => ({
          label: String(source.bundleVersion),
          value: source,
          hint: `current: ${source.enabled ? "active" : "inactive"}, ${
            source.enabled ? "active -> inactive" : "inactive -> active"
          }`,
        })),
      }),
  });

  s.start("Rolling back versions");

  await deployPlugin.updateUpdateJson(group.version.bundleVersion, {
    ...group.version,
    enabled: !group.version.enabled,
  });
  await deployPlugin.commitUpdateJson();

  const direction = group.version.enabled
    ? "active -> inactive"
    : "inactive -> active";

  s.stop(`Done. Version ${group.version.bundleVersion} ${direction}`);
};
