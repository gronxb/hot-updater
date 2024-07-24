import { getCwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import * as p from "@clack/prompts";
import { type Platform, filterTargetVersion, log } from "@hot-updater/internal";
import Table from "cli-table3";
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

  const createTable = () =>
    new Table({
      head: [
        "Platform",
        "Active",
        "Description",
        "Target App Version",
        "Bundle Version",
      ],
      style: { head: ["cyan"] },
    });

  const group = await p.group(
    {
      version: () =>
        p.select({
          message: "Select versions to rollback",
          maxItems: 3,
          initialValue: targetVersions[0],
          options: targetVersions.map((source) => {
            const table = createTable();
            table.push([
              source.platform,
              source.enabled
                ? picocolors.green("true")
                : picocolors.red("false"),
              source.description || "-",
              source.targetVersion,
              source.bundleVersion,
            ]);

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

        const currTable = createTable();
        const nextTable = createTable();
        currTable.push([
          results.version.platform,
          results.version.enabled
            ? picocolors.green("true")
            : picocolors.red("false"),
          results.version.description || "-",
          results.version.targetVersion,
          results.version.bundleVersion,
        ]);

        nextTable.push([
          results.version.platform,
          !results.version.enabled
            ? picocolors.green("true")
            : picocolors.red("false"),
          results.version.description || "-",
          results.version.targetVersion,
          results.version.bundleVersion,
        ]);

        return p.confirm({
          message: [
            "",
            picocolors.bgRed("Current bundle:"),
            currTable.toString(),
            "",
            picocolors.bgGreen(picocolors.black("Next bundle:")),
            nextTable.toString(),
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
