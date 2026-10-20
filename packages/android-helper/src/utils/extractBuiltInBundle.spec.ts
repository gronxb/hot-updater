import fs from "fs";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractBuiltInBundle } from "./extractBuiltInBundle";

describe("extractBuiltInBundle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "built-in-"));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const artifact = async (
    name: string,
    entries: Record<string, string | Uint8Array>,
    compression: "STORE" | "DEFLATE" = "DEFLATE",
  ) => {
    const zip = new JSZip();
    for (const [entry, contents] of Object.entries(entries)) {
      zip.file(entry, contents);
    }
    const artifactPath = path.join(dir, name);
    await fs.promises.writeFile(
      artifactPath,
      await zip.generateAsync({ type: "uint8array", compression }),
    );
    return artifactPath;
  };

  it.each([
    ["app-release.apk", "assets/index.android.bundle"],
    ["app-release.aab", "base/assets/index.android.bundle"],
  ])("copies the bundle of %s from %s, byte for byte", async (name, entry) => {
    const artifactPath = await artifact(name, {
      [entry]: "hermes bytecode",
      "assets/other.txt": "not the bundle",
    });
    const outputPath = path.join(dir, "out", "index.android.bundle");

    await extractBuiltInBundle({ artifactPath, outputPath });

    await expect(fs.promises.readFile(outputPath, "utf8")).resolves.toBe(
      "hermes bytecode",
    );
  });

  it.each(["STORE", "DEFLATE"] as const)(
    "streams a large %s entry byte for byte",
    async (compression) => {
      const bytes = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 251;
      const artifactPath = await artifact(
        "app-release.apk",
        {
          "AndroidManifest.xml": "manifest",
          "assets/index.android.bundle": bytes,
          "res/raw/zzz.bin": "after the bundle",
        },
        compression,
      );
      const outputPath = path.join(dir, "out", "index.android.bundle");

      await extractBuiltInBundle({ artifactPath, outputPath });

      expect(
        Buffer.compare(await fs.promises.readFile(outputPath), bytes),
      ).toBe(0);
    },
  );

  it("names the entry a build without a bundle lacks", async () => {
    const artifactPath = await artifact("app-release.aab", {
      "assets/index.android.bundle": "at the wrong path for an .aab",
    });

    await expect(
      extractBuiltInBundle({
        artifactPath,
        outputPath: path.join(dir, "index.android.bundle"),
      }),
    ).rejects.toThrow(
      "app-release.aab has no base/assets/index.android.bundle",
    );
  });
});
