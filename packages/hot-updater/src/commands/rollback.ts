import { getCwd } from "@/cwd.js";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion.js";
import { loadConfig } from "@/utils/loadConfig.js";
import { createTable } from "@/utils/table.js";
import * as p from "@clack/prompts";
import { type Platform, filterTargetVersion } from "@hot-updater/internal";
import picocolors from "picocolors";

export interface RollbackOptions {
  platform?: Platform;
  targetVersion?: string;
}

export const rollback = async (options: RollbackOptions) => {
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

  const group = await p.group(
    {
      version: () =>
        p.select({
          message: "Select versions to rollback",
          maxItems: 3,
          initialValue: targetVersions[0],
          options: targetVersions.map((source) => {
            const { table, pushTable } = createTable();
            pushTable(source);

            const hint = source.enabled
              ? [
                  'Selecting this bundle will set "active" to ',
                  picocolors.red("false"),
                ].join("")
              : [
                  'Selecting this bundle will set "active" to ',
                  picocolors.green("true"),
                ].join("");
            return {
              label: ["\n", table.toString(), "\n", hint, "\n"].join(""),
              value: source,
            };
          }),
        }),
      confirm: ({ results }) => {
        if (!results.version) {
          return;
        }

        const curr = createTable();
        const next = createTable();
        curr.pushTable(results.version);
        next.pushTable({
          ...results.version,
          enabled: !results.version.enabled,
        });

        return p.confirm({
          message: [
            "",
            picocolors.bgRed("Current bundle:"),
            curr.table.toString(),
            "",
            picocolors.bgGreen(picocolors.black("Next bundle:")),
            next.table.toString(),
            "",
            "Are you sure you want to rollback?",
          ].join("\n"),
        });
      },
    },
    {
      onCancel: () => {
        s.stop("Rollback cancelled", 0);
        process.exit(0);
      },
    },
  );

  if (!group.confirm) {
    s.stop("Rollback cancelled", 0);
    return;
  }

  s.start("Rollback in progress");

  await deployPlugin.updateUpdateJson(group.version.bundleVersion, {
    ...group.version,
    enabled: !group.version.enabled,
  });
  await deployPlugin.commitUpdateJson();

  s.stop("Done", 0);
};
