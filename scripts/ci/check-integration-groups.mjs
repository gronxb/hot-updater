// @ts-check
/**
 * Checks that the integration groups (integration-groups.mjs) split the
 * integration files exactly: every file the integration projects select runs
 * in exactly one group, every group but `rest` runs a file, and every glob of
 * a group matches one. It asks Vitest for each selection with
 * `vitest list --filesOnly`, which resolves the globs a run would, but runs
 * no test and starts no service.
 *
 *   node scripts/ci/check-integration-groups.mjs
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  INTEGRATION_GROUP_ENV,
  integrationGroups,
  REST_GROUP,
} from "./integration-groups.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

/**
 * The integration files a group runs, or every integration file without a
 * group: each as its path from the repository root, and as a key that names
 * its project too.
 * @param {string} directory
 * @param {string} [group]
 * @returns {Promise<{ file: string; key: string }[]>}
 */
async function listFiles(directory, group) {
  const output = path.join(directory, `${group ?? "all"}.json`);
  const env = { ...process.env };
  delete env[INTEGRATION_GROUP_ENV];
  if (group) {
    env[INTEGRATION_GROUP_ENV] = group;
  }
  try {
    await run(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--filesOnly",
        "--project=integration:*",
        `--json=${output}`,
      ],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const { stdout, stderr } =
      /** @type {{ stdout?: string; stderr?: string }} */ (error);
    const files = group ? `group "${group}"` : "the integration projects";
    throw new Error(
      [`Listing the files of ${files} failed.`, stdout, stderr]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
  /** @type {{ file: string; projectName?: string }[]} */
  const listed = JSON.parse(await readFile(output, "utf8"));
  return listed
    .map(({ file, projectName = "" }) => {
      const relative = path.relative(root, file).split(path.sep).join("/");
      return { file: relative, key: `${projectName}: ${relative}` };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

const directory = await mkdtemp(
  path.join(os.tmpdir(), "hot-updater-integration-groups-"),
);
try {
  const [all, ...selections] = await Promise.all([
    listFiles(directory),
    ...integrationGroups.map((group) => listFiles(directory, group.name)),
  ]);

  const problems = [];
  const everyFile = new Set(all.map(({ key }) => key));
  /** @type {Map<string, string>} */
  const owners = new Map();
  if (all.length === 0) {
    problems.push("The integration projects select no files.");
  }
  integrationGroups.forEach((group, index) => {
    const files = selections[index] ?? [];
    if (files.length === 0 && group.name !== REST_GROUP) {
      problems.push(`Group "${group.name}" runs no files.`);
    }
    for (const glob of group.include ?? []) {
      if (!files.some(({ file }) => path.matchesGlob(file, glob))) {
        problems.push(
          `Group "${group.name}" has a glob no file matches: ${glob}`,
        );
      }
    }
    for (const { key } of files) {
      const owner = owners.get(key);
      if (owner) {
        problems.push(`${key} runs in both "${owner}" and "${group.name}".`);
      } else {
        owners.set(key, group.name);
      }
      if (!everyFile.has(key)) {
        problems.push(
          `Group "${group.name}" runs ${key}, which the integration projects do not select.`,
        );
      }
    }
  });
  for (const { key } of all) {
    if (!owners.has(key)) {
      problems.push(`${key} runs in no group.`);
    }
  }

  integrationGroups.forEach((group, index) => {
    const files = selections[index] ?? [];
    console.log(`${group.name} (${files.length})`);
    for (const { key } of files) {
      console.log(`  ${key}`);
    }
  });
  if (problems.length > 0) {
    console.error(`\n${problems.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n${all.length} integration files, each in exactly one of ${integrationGroups.length} groups.`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
