import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

// Private G1 tooling. This is not a public build API or a CLI deployment test.
const require = createRequire(
  new URL("../packages/lynx/package.json", import.meta.url),
);
const { uuidv7 } = require("uuidv7");
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    entry: { type: "string" },
    platform: { type: "string" },
    "runtime-id": { type: "string" },
  },
});

for (const key of ["source", "output", "entry", "platform", "runtime-id"]) {
  if (!values[key]?.trim()) throw new Error(`Missing --${key}`);
}
if (!["ios", "android"].includes(values.platform)) {
  throw new Error("--platform must be ios or android");
}
const isRelativeFile = (name) =>
  !path.posix.isAbsolute(name) &&
  !name.includes("\\") &&
  !name.includes(":") &&
  name.split("/").every((part) => part && part !== "." && part !== "..");
if (!isRelativeFile(values.entry)) throw new Error("Invalid relative entry");

const source = await fs.realpath(values.source);
await fs.mkdir(values.output, { recursive: true });
const output = await fs.realpath(values.output);
const relativeOutput = path.relative(source, output);
if (
  !relativeOutput ||
  (!relativeOutput.startsWith(`..${path.sep}`) &&
    relativeOutput !== ".." &&
    !path.isAbsolute(relativeOutput))
) {
  throw new Error("Output must not be inside the input tree");
}

const files = [];
for (const name of await fs.readdir(source, { recursive: true })) {
  if (!isRelativeFile(name)) throw new Error(`Invalid input path: ${name}`);
  const stat = await fs.lstat(path.join(source, name));
  if (stat.isSymbolicLink()) throw new Error(`Symbolic link: ${name}`);
  if (["manifest.json", "hot-updater-lynx.json"].includes(name)) {
    throw new Error(`Reserved input path: ${name}`);
  }
  if (stat.isDirectory()) continue;
  if (!stat.isFile()) throw new Error(`Not a regular file: ${name}`);
  files.push(name);
}
if (
  !files.includes(values.entry) ||
  (await fs.stat(path.join(source, values.entry))).size === 0
) {
  throw new Error("Entry must be a non-empty input file");
}

const bundleId = uuidv7();
const releaseId = uuidv7();
const buildPath = path.join(output, bundleId);
await fs.mkdir(buildPath);
try {
  for (const name of files) {
    const destination = path.join(buildPath, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, name), destination);
  }
  const metadata = {
    schemaVersion: 1,
    bundleId,
    platform: values.platform,
    entry: values.entry,
    runtimeId: values["runtime-id"],
  };
  await fs.writeFile(
    path.join(buildPath, "hot-updater-lynx.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  files.push("hot-updater-lynx.json");
  const assets = Object.fromEntries(
    await Promise.all(
      files.sort().map(async (name) => [
        name,
        {
          fileHash: createHash("sha256")
            .update(await fs.readFile(path.join(buildPath, name)))
            .digest("hex"),
        },
      ]),
    ),
  );
  const manifest = `${JSON.stringify({ bundleId, assets }, null, 2)}\n`;
  await fs.writeFile(path.join(buildPath, "manifest.json"), manifest);
  process.stdout.write(
    `${JSON.stringify(
      {
        buildPath,
        releaseId,
        ...metadata,
        manifestFileHash: createHash("sha256").update(manifest).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  await fs.rm(buildPath, { recursive: true, force: true });
  throw error;
}
