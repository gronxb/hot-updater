// G1-only local fixture preparation; this is not the public deployment path.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ios = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(ios, "../../..");
const runtimeId =
  "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2";
const variantArgument = process.argv.find((arg) =>
  arg.startsWith("--variant="),
);
const variant =
  variantArgument?.slice("--variant=".length) ??
  (process.argv.includes("--resources") ? "resources-managed" : "");
if (
  ![
    "",
    "resources-managed",
    "fonts-managed",
    "external-managed",
    "external2-managed",
  ].includes(variant)
)
  throw new Error("Unsupported fixture variant");
const frameworks = process.argv
  .slice(2)
  .filter((arg) => arg !== "--resources" && arg !== variantArgument);
if (
  !frameworks.length ||
  frameworks.some((name) => !["react", "vue", "octane"].includes(name))
) {
  throw new Error(
    "Usage: node prepare-fixtures.mjs <react|vue|octane> [...] [--variant=resources-managed|fonts-managed|external-managed]",
  );
}
for (const framework of frameworks) {
  for (const slot of ["A", "B"]) {
    const staged = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "scripts/lynx-g1-stage.mjs",
          "--source",
          `examples/lynx/.hot-updater/g1/${framework}/${slot}${variant ? `-${variant}` : ""}`,
          "--output",
          "examples/lynx/.hot-updater/g1-staged/ios",
          "--entry",
          "main.lynx.bundle",
          "--platform",
          "ios",
          "--runtime-id",
          runtimeId,
        ],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    const selection = {
      release: `${framework}/${slot}`,
      entry: staged.entry,
      bundleId: staged.bundleId,
      releaseId: staged.releaseId,
      manifestFileHash: staged.manifestFileHash,
      scope: `g1-${framework}`,
      requiredResources: JSON.stringify(
        (
          await Promise.all(
            ["assets/probe.png", "assets/probe.ttf", "assets/bootstrap.js"].map(
              async (resource) =>
                (await fs
                  .stat(path.join(staged.buildPath, resource))
                  .catch(() => null))
                  ? resource
                  : null,
            ),
          )
        ).filter(Boolean),
      ),
      embedded: slot === "A" ? "true" : "false",
    };
    const fixture = path.join(
      ios,
      slot === "A" ? "Embedded" : ".fixtures",
      framework,
      slot,
    );
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.mkdir(path.dirname(fixture), { recursive: true });
    await fs.cp(staged.buildPath, fixture, { recursive: true });
    await fs.writeFile(
      path.join(
        ios,
        slot === "A" ? "Embedded" : ".fixtures",
        `${framework}-${slot}.json`,
      ),
      `${JSON.stringify(selection, null, 2)}\n`,
    );
    process.stdout.write(
      `${framework}/${slot}: ${staged.bundleId} ${staged.manifestFileHash}\n`,
    );
  }
}
