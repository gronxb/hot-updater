import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { selectReactNativeArtifacts } from "./build";

const directories: string[] = [];

describe("React Native build artifact policy", () => {
  afterEach(async () => {
    await Promise.all(
      directories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    directories.length = 0;
  });

  it("keeps historical Hermes output names, exclusions, and compression", async () => {
    const buildPath = await fs.mkdtemp(path.join(os.tmpdir(), "rn-artifacts-"));
    directories.push(buildPath);
    await fs.mkdir(path.join(buildPath, "assets"));
    await Promise.all([
      fs.writeFile(path.join(buildPath, "index.ios.bundle"), "javascript"),
      fs.writeFile(path.join(buildPath, "index.ios.bundle.hbc"), "bytecode"),
      fs.writeFile(path.join(buildPath, "index.ios.bundle.map"), "js map"),
      fs.writeFile(path.join(buildPath, "index.ios.bundle.hbc.map"), "hbc map"),
      fs.writeFile(path.join(buildPath, "assets", "logo.png"), "image"),
    ]);

    await expect(
      selectReactNativeArtifacts({ buildPath, platform: "ios" }),
    ).resolves.toEqual({
      artifacts: [
        {
          path: path.join(buildPath, "assets", "logo.png"),
          name: "assets/logo.png",
          downloadCompression: null,
        },
        {
          path: path.join(buildPath, "index.ios.bundle.hbc"),
          name: "index.ios.bundle",
          downloadCompression: "br",
        },
      ],
      patchAssetPath: "index.ios.bundle",
    });
  });

  it("selects the JavaScript bundle when Hermes output is absent", async () => {
    const buildPath = await fs.mkdtemp(path.join(os.tmpdir(), "rn-artifacts-"));
    directories.push(buildPath);
    const bundle = path.join(buildPath, "index.android.bundle");
    await fs.writeFile(bundle, "javascript");

    await expect(
      selectReactNativeArtifacts({ buildPath, platform: "android" }),
    ).resolves.toEqual({
      artifacts: [
        {
          path: bundle,
          name: "index.android.bundle",
          downloadCompression: "br",
        },
      ],
      patchAssetPath: "index.android.bundle",
    });
  });

  it("orders Unicode artifact names by locale-independent UTF-16 code units", async () => {
    const buildPath = await fs.mkdtemp(path.join(os.tmpdir(), "rn-artifacts-"));
    directories.push(buildPath);
    await Promise.all([
      fs.writeFile(path.join(buildPath, "index.ios.bundle"), "javascript"),
      fs.writeFile(path.join(buildPath, "Z.asset"), "upper"),
      fs.writeFile(path.join(buildPath, "ä.asset"), "non-ascii"),
    ]);

    const result = await selectReactNativeArtifacts({
      buildPath,
      platform: "ios",
    });

    expect(result.artifacts.map(({ name }) => name)).toEqual([
      "Z.asset",
      "index.ios.bundle",
      "ä.asset",
    ]);
  });

  it("fails when the platform entry is absent", async () => {
    const buildPath = await fs.mkdtemp(path.join(os.tmpdir(), "rn-artifacts-"));
    directories.push(buildPath);
    await fs.writeFile(path.join(buildPath, "other.bin"), "data");

    await expect(
      selectReactNativeArtifacts({ buildPath, platform: "ios" }),
    ).rejects.toThrow("index.ios.bundle");
  });
});
