import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDirs = ["packages", "plugins"];
const manifestPaths = [];

for (const packageDir of packageDirs) {
  const entries = await readdir(path.join(rootDir, packageDir), {
    withFileTypes: true,
  });

  manifestPaths.push(
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packageDir, entry.name, "package.json")),
  );
}

const manifests = await Promise.all(
  manifestPaths.map(async (manifestPath) =>
    JSON.parse(await readFile(path.join(rootDir, manifestPath), "utf8")),
  ),
);

const releasePackages = manifests
  .filter(
    ({ name }) => name === "hot-updater" || name.startsWith("@hot-updater/"),
  )
  .sort((packageA, packageB) => packageA.name.localeCompare(packageB.name));

if (releasePackages.length === 0) {
  throw new Error("No Hot Updater packages found.");
}

const releaseLines = new Set(
  releasePackages.map(({ name, version }) => {
    const match = /^(\d+)\.(\d+)\./.exec(version);

    if (!match) {
      throw new Error(`${name} has an invalid version: ${version}`);
    }

    return `${match[1]}.${match[2]}`;
  }),
);

if (releaseLines.size !== 1) {
  throw new Error(
    `Packages must share one major/minor line before a coordinated minor release: ${[
      ...releaseLines,
    ].join(", ")}`,
  );
}

const [releaseLine] = releaseLines;
const packageNames = releasePackages.map(({ name }) => name);

console.log(
  `Creating a coordinated minor changeset for ${packageNames.length} packages on ${releaseLine}.x.`,
);

const require = createRequire(import.meta.url);
const changesetBin = require.resolve("@changesets/cli/bin.js");
const forwardedArgs = process.argv.slice(2);

if (forwardedArgs[0] === "--") {
  forwardedArgs.shift();
}

const result = spawnSync(
  process.execPath,
  [changesetBin, "add", "--minor", packageNames.join(","), ...forwardedArgs],
  { cwd: rootDir, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
