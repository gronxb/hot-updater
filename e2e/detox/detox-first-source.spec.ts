import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxDir = path.join(repoDir, "e2e/detox");
const scenarioDir = path.join(detoxDir, "scenarios");
const retiredFlowDir = ["e2e", "ma" + "estro", ""].join("/");
const retiredHarnessMarkerPattern = new RegExp(["ma", "estro"].join(""), "i");
const detoxFlowFilePattern = new RegExp(
  ["e2e/detox/.*\\.", "ya?", "ml$"].join(""),
  "i",
);
const retiredMigrationModelPattern = new RegExp(
  [
    "\\bDetoxScenario",
    "Wave\\b|\\bdetoxScenario",
    "Waves\\b|\\bwave[1-4]Scenarios\\b|\\bwave:\\s*[1-4]\\b",
  ].join(""),
);

async function readSourceFiles(
  rootDir: string,
): Promise<readonly { readonly file: string; readonly source: string }[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) return readSourceFiles(absolutePath);
      if (!/\.(?:js|ts)$/.test(entry.name)) return [];
      return [
        {
          file: path.relative(repoDir, absolutePath),
          source: await fs.readFile(absolutePath, "utf8"),
        },
      ];
    }),
  );
  return files.flat();
}

function trackedE2eFiles(): readonly string[] {
  const result = spawnSync("git", ["ls-files", "e2e"], {
    cwd: repoDir,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

describe("Detox-first source shape", () => {
  it("keeps active E2E source free of retired flow files", () => {
    const activeE2eFiles = trackedE2eFiles();

    expect(
      activeE2eFiles.filter((file) => file.startsWith(retiredFlowDir)),
    ).toEqual([]);
    expect(
      activeE2eFiles.filter((file) => detoxFlowFilePattern.test(file)),
    ).toEqual([]);
  });

  it("keeps example app ignore rules free of retired harness artifacts", async () => {
    const exampleIgnoreSource = await fs.readFile(
      path.join(repoDir, "examples/v0.85.0/.gitignore"),
      "utf8",
    );

    expect(exampleIgnoreSource).not.toMatch(retiredHarnessMarkerPattern);
  });

  it("groups scenarios by user flow instead of migration waves", async () => {
    const scenarioFiles = await fs.readdir(scenarioDir);
    const detoxSources = await readSourceFiles(detoxDir);

    expect(scenarioFiles.filter((file) => /^wave\d+\.ts$/.test(file))).toEqual(
      [],
    );
    expect(detoxSources.map(({ source }) => source).join("\n")).not.toMatch(
      retiredMigrationModelPattern,
    );
  });
});
