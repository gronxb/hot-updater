// Manually place a G1 fixture in the simulator sandbox; not an OTA installer.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [udid, framework, slot] = process.argv.slice(2);
if (
  !udid ||
  !["react", "vue", "octane"].includes(framework) ||
  !["A", "B"].includes(slot)
) {
  throw new Error(
    "Usage: node place-fixture.mjs <simulator-udid> <react|vue|octane> <A|B>",
  );
}
const ios = path.dirname(fileURLToPath(import.meta.url));
const container = execFileSync(
  "xcrun",
  ["simctl", "get_app_container", udid, "com.hotupdater.lynxexample", "data"],
  { encoding: "utf8" },
).trim();
const root = path.join(
  container,
  "Library/Application Support/HotUpdaterLynxSpike",
);
const installedApp =
  slot === "A"
    ? execFileSync(
        "xcrun",
        [
          "simctl",
          "get_app_container",
          udid,
          "com.hotupdater.lynxexample",
          "app",
        ],
        { encoding: "utf8" },
      ).trim()
    : null;
const input =
  slot === "A"
    ? path.join(installedApp, "Embedded")
    : path.join(ios, ".fixtures");
await fs.mkdir(root, { recursive: true });
if (slot === "B") {
  const destination = path.join(root, "releases", framework, slot);
  // Caller must stop the process before replacing local spike fixtures.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(path.join(input, framework, slot), destination, {
    recursive: true,
  });
}
await fs.copyFile(
  path.join(input, `${framework}-${slot}.json`),
  path.join(root, "launch.json"),
);
process.stdout.write(`${root}\n`);
