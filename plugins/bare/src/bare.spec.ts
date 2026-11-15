import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { bare } from "./bare";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** A project whose react-native CLI prints `stdout`, then exits with `code`. */
const createProject = async (cli: string) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bare-bundle-"));
  tempDirs.push(cwd);
  const reactNative = path.join(cwd, "node_modules", "react-native");
  await fs.mkdir(reactNative, { recursive: true });
  await fs.writeFile(
    path.join(reactNative, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.85.0" }),
  );
  await fs.writeFile(
    path.join(reactNative, "cli.js"),
    `#!/usr/bin/env node\n${cli}\n`,
    { mode: 0o755 },
  );
  return cwd;
};

it("fails a bundle with the CLI's exit code and its last output", async () => {
  const cwd = await createProject(
    [
      "console.log('Welcome to Metro');",
      "console.log('Transforming index.js');",
      "console.error('npm warn config production Use --omit=dev instead.');",
      "process.exit(7);",
    ].join("\n"),
  );

  const build = bare({ enableHermes: false })({ cwd }).build({
    platform: "android",
  });

  const error = await build.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  // stdout and stderr interleave in the order they arrive.
  const [first, ...tail] = (error as Error).message.split("\n");
  expect(first).toBe("react-native bundle exited with code 7.");
  expect([...tail].sort()).toEqual(
    [
      "Transforming index.js",
      "Welcome to Metro",
      "npm warn config production Use --omit=dev instead.",
    ].sort(),
  );
});
