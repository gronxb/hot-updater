import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MODULE = pathToFileURL(
  path.join(import.meta.dirname, "createRandomTmpDir.ts"),
).href;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-tmp-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Runs `body` in a Node process whose temporary directory is `tmpDir`, after
 * it creates a directory `directory` holding a file.
 */
const runInProcess = (body: string) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { writeFileSync } from "node:fs";
      const { createRandomTmpDir } = await import(${JSON.stringify(MODULE)});
      const directory = await createRandomTmpDir();
      writeFileSync(directory + "/DerivedData", "");
      ${body}
      `,
    ],
    {
      env: { ...process.env, TMPDIR: tmpDir },
      encoding: "utf-8",
      timeout: 10_000,
    },
  );

describe("createRandomTmpDir", () => {
  it("removes its directories when the process is interrupted, and still ends with the signal", async () => {
    const child = runInProcess(`
      process.kill(process.pid, "SIGINT");
      setTimeout(() => {}, 5_000);
    `);

    expect(child.signal).toBe("SIGINT");
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("removes its directories when another listener, such as a running xcodebuild's, handles the interrupt", async () => {
    const child = runInProcess(`
      process.once("SIGINT", () => console.log("xcodebuild stopped"));
      process.kill(process.pid, "SIGINT");
      setTimeout(() => process.exit(0), 100);
    `);

    expect(child.stdout).toContain("xcodebuild stopped");
    expect(child.status).toBe(0);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("removes its directories when the process exits", async () => {
    const child = runInProcess("process.exit(1);");

    expect(child.status).toBe(1);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("keeps a directory until the process ends or removeTmpDir removes it", async () => {
    const child = runInProcess(`
      const { readdirSync } = await import("node:fs");
      const { removeTmpDir } = await import(${JSON.stringify(MODULE)});
      console.log(readdirSync(process.env.TMPDIR).length);
      await removeTmpDir(directory);
      console.log(readdirSync(process.env.TMPDIR).length);
    `);

    expect(child.stderr).toBe("");
    expect(child.stdout.trim().split("\n")).toEqual(["1", "0"]);
  });
});
