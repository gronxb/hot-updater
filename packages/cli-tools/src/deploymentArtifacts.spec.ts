import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  planDeploymentArtifacts,
  writeDeploymentArtifacts,
} from "./deploymentArtifacts";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-artifacts-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("deployment artifacts", () => {
  it("writes nested artifacts in deterministic path order", async () => {
    const outputDir = await createTemporaryDirectory();

    const results = await writeDeploymentArtifacts({
      artifacts: [
        { contents: "second", path: "components/zeta/schema.sql" },
        { contents: "first", path: "components/audit/schema.sql" },
      ],
      outputDir,
    });

    expect(
      results.map(({ path: filePath }) => path.relative(outputDir, filePath)),
    ).toEqual([
      path.join("components", "audit", "schema.sql"),
      path.join("components", "zeta", "schema.sql"),
    ]);
    await expect(
      fs.readFile(path.join(outputDir, "components/audit/schema.sql"), "utf-8"),
    ).resolves.toBe("first");
  });

  it("does not rewrite an identical artifact", async () => {
    const outputDir = await createTemporaryDirectory();
    const artifacts = [{ contents: "stable", path: "component/schema.sql" }];

    await expect(
      writeDeploymentArtifacts({ artifacts, outputDir }),
    ).resolves.toEqual([
      {
        path: path.join(outputDir, "component/schema.sql"),
        status: "written",
      },
    ]);
    await expect(
      writeDeploymentArtifacts({ artifacts, outputDir }),
    ).resolves.toEqual([
      {
        path: path.join(outputDir, "component/schema.sql"),
        status: "unchanged",
      },
    ]);
  });

  it("does not overwrite an unrelated file at the artifact path", async () => {
    const outputDir = await createTemporaryDirectory();
    await fs.writeFile(path.join(outputDir, "schema.sql"), "user-owned");

    await expect(
      writeDeploymentArtifacts({
        artifacts: [{ contents: "generated", path: "schema.sql" }],
        outputDir,
      }),
    ).rejects.toThrow("Deployment artifact path collision");
    await expect(
      fs.readFile(path.join(outputDir, "schema.sql"), "utf-8"),
    ).resolves.toBe("user-owned");
  });

  it("returns no writes for an inactive component set", async () => {
    const outputDir = await createTemporaryDirectory();

    await expect(
      writeDeploymentArtifacts({ artifacts: [], outputDir }),
    ).resolves.toEqual([]);
    await expect(fs.readdir(outputDir)).resolves.toEqual([]);
  });

  it.each(["../escape.sql", "/tmp/escape.sql", "C:\\tmp\\escape.sql"])(
    "rejects unsafe artifact path %s",
    (artifactPath) => {
      expect(() =>
        planDeploymentArtifacts([{ contents: "unsafe", path: artifactPath }]),
      ).toThrow("Deployment artifact path");
    },
  );

  it("rejects paths that collide after normalization or case folding", () => {
    expect(() =>
      planDeploymentArtifacts([
        { contents: "first", path: "schema.sql" },
        { contents: "second", path: "SCHEMA.sql" },
      ]),
    ).toThrow("Deployment artifact path collision");
  });
});
