import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const resolver = path.join(import.meta.dirname, "resolve-hot-updater-cli.js");

let appRoot: string;

beforeEach(async () => {
  // A space in the path, as in a Windows user folder, which the command line
  // has to quote.
  appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hot updater app-"));
});

afterEach(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

const installCli = async (bin: unknown) => {
  const cli = path.join(appRoot, "node_modules", "hot-updater");
  await fs.mkdir(cli, { recursive: true });
  await fs.writeFile(
    path.join(cli, "package.json"),
    JSON.stringify({ name: "hot-updater", version: "1.0.0", bin }),
  );
  return fs.realpath(cli);
};

// What hot-updater-fingerprint.gradle runs: node, this file, the app root.
const resolve = () =>
  execFileSync(process.execPath, [resolver, appRoot], {
    cwd: appRoot,
    encoding: "utf8",
  }).trim();

describe("resolve-hot-updater-cli.js", () => {
  it("prints the CLI the app root resolves from a bin map", async () => {
    const cli = await installCli({ "hot-updater": "dist/index.mjs" });

    expect(resolve()).toBe(path.join(cli, "dist", "index.mjs"));
  });

  it("prints the CLI from a bin string", async () => {
    const cli = await installCli("bin/cli.js");

    expect(resolve()).toBe(path.join(cli, "bin", "cli.js"));
  });
});
