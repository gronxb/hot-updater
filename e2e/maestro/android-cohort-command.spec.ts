import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const controllerSourcePath = path.join(
  import.meta.dirname,
  "server",
  "controller.ts",
);

async function readWriteAndroidE2ECohortSource(): Promise<string> {
  const source = await fs.readFile(controllerSourcePath, "utf8");
  const start = source.indexOf("function writeAndroidE2ECohort");
  const end = source.indexOf(
    "\n}\n\nasync function seedMissingE2ECohort",
    start,
  );

  return source.slice(start, end);
}

describe("Android E2E cohort command", () => {
  it("quotes the sh -c command string for adb shell run-as", async () => {
    // Given: adb shell re-parses run-as arguments on the remote shell.
    const source = await readWriteAndroidE2ECohortSource();

    // When: the control server seeds Android SharedPreferences before launch.
    const shellCommandStart = source.indexOf('"sh",');
    const shellCommandSource = source.slice(shellCommandStart);

    // Then: sh receives one quoted command string, not split argv after -c.
    expect(shellCommandSource).toContain('"sh",');
    expect(shellCommandSource).toContain('"-c",');
    expect(shellCommandSource).toMatch(/"-c",\s+shellSingleQuote\(\s+\[/);
    expect(shellCommandSource).not.toMatch(/"-c",\s+\[/);
  });
});
