import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleRoot = path.join(workspaceRoot, "examples/v0.85.0");

describe("Re.Pack package resolution", () => {
  it("aliases runtime modules through their public package exports", async () => {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { fileURLToPath } from "node:url";
import config from "./rspack.config.mjs";

const aliases = config.resolve.alias;
const expected = new Map([
  [
    "@hot-updater/analytics/react-native$",
    fileURLToPath(import.meta.resolve("@hot-updater/analytics/react-native")),
  ],
  [
    "@hot-updater/react-native/runtime-metadata$",
    fileURLToPath(
      import.meta.resolve(
        "@hot-updater/react-native/runtime-metadata",
      ),
    ),
  ],
]);

for (const [specifier, resolved] of expected) {
  if (aliases[specifier] !== resolved) process.exit(1);
}
`,
      ],
      { cwd: exampleRoot },
    );
  });
});
