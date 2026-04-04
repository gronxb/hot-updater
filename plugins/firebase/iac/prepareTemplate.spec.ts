import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { copyDirToTmp } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareFirebaseTemplate } from "./prepareTemplate";

vi.mock("@hot-updater/cli-tools", () => ({
  copyDirToTmp: vi.fn(),
}));

const copyDirToTmpMock = vi.mocked(copyDirToTmp);

describe("prepareFirebaseTemplate", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    copyDirToTmpMock.mockReset();

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("stages firebase public files and built functions into the init directory", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "firebase-template-"),
    );
    tempDirs.push(fixtureRoot);

    const outputDir = path.join(fixtureRoot, "output");
    const publicDir = path.join(fixtureRoot, "public");
    const builtFunctionsDir = path.join(fixtureRoot, "functions");

    await mkdir(path.join(publicDir, "functions"), { recursive: true });
    await mkdir(builtFunctionsDir, { recursive: true });

    await writeFile(path.join(publicDir, "firebase.json"), '{"functions":{}}');
    await writeFile(
      path.join(publicDir, "firestore.indexes.json"),
      '{"indexes":[],"fieldOverrides":[]}',
    );
    await writeFile(
      path.join(publicDir, "functions", "_package.json"),
      '{"name":"functions-template"}',
    );
    await writeFile(
      path.join(builtFunctionsDir, "index.cjs"),
      "module.exports = {};",
    );

    copyDirToTmpMock.mockImplementation(async (dir: string) => {
      await mkdir(outputDir, { recursive: true });
      await cp(dir, outputDir, { recursive: true });

      return {
        tmpDir: outputDir,
        removeTmpDir: async () => {
          await rm(outputDir, { recursive: true, force: true });
        },
      };
    });

    const staged = await prepareFirebaseTemplate(fixtureRoot);

    expect(staged.tmpDir).toBe(outputDir);
    expect(staged.functionsDir).toBe(path.join(outputDir, "functions"));
    expect(await readFile(path.join(outputDir, "firebase.json"), "utf8")).toBe(
      '{"functions":{}}',
    );
    expect(
      await readFile(path.join(outputDir, "firestore.indexes.json"), "utf8"),
    ).toBe('{"indexes":[],"fieldOverrides":[]}');
    expect(
      await readFile(path.join(outputDir, "functions", "package.json"), "utf8"),
    ).toBe('{"name":"functions-template"}');
    expect(
      await readFile(path.join(outputDir, "functions", "index.cjs"), "utf8"),
    ).toBe("module.exports = {};");
    await expect(
      readFile(path.join(outputDir, "functions", "_package.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
