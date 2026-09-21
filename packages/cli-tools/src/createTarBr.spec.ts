import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { createTarBrTargetFiles } from "./createTarBr";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-tar-br-"),
  );
  directories.push(directory);
  const source = path.join(directory, "source");
  await fs.writeFile(source, "asset bytes");
  return { directory, source, outfile: path.join(directory, "bundle.tar.br") };
}

describe("tar.br target archive", () => {
  it("produces deterministic target-only bytes with authenticated lengths and long PAX paths", async () => {
    const { directory, source, outfile } = await fixture();
    const longName = `assets/${"nested/".repeat(20)}한글.png`;
    const targetFiles = [
      { path: source, name: longName },
      { path: source, name: "index.ios.bundle" },
    ];
    const metadata = await createTarBrTargetFiles({ outfile, targetFiles });
    const compressed = await fs.readFile(outfile);
    const archive = brotliDecompressSync(compressed);
    expect(metadata).toEqual({
      downloadFileHash: createHash("sha256").update(compressed).digest("hex"),
      downloadByteSize: compressed.length,
      tarByteSize: archive.length,
    });
    const tarPath = path.join(directory, "bundle.tar");
    await fs.writeFile(tarPath, archive);
    const entries: Record<string, string> = {};
    await tar.t({
      file: tarPath,
      onReadEntry(entry) {
        expect(entry.type).toBe("File");
        expect(entry.mode).toBe(0o644);
        expect(entry.mtime?.getTime()).toBe(0);
        entries[entry.path] = "";
        entry.on("data", (chunk) => {
          entries[entry.path] += chunk.toString();
        });
      },
    });
    expect(entries).toEqual({
      [longName]: "asset bytes",
      "index.ios.bundle": "asset bytes",
    });
    await fs.utimes(source, new Date(), new Date());
    await fs.chmod(source, 0o755);
    expect(
      await createTarBrTargetFiles({
        outfile,
        targetFiles: [...targetFiles].reverse(),
      }),
    ).toEqual(metadata);
    expect(await fs.readFile(outfile)).toEqual(compressed);
  });

  it.each([
    "manifest.json",
    "bundle.tar.br",
    "../escape",
    "/absolute",
    "a/../b",
    "a//b",
    "a\\b",
  ])("rejects invalid target %s before publication", async (name) => {
    const { source, outfile } = await fixture();
    await expect(
      createTarBrTargetFiles({
        outfile,
        targetFiles: [{ path: source, name }],
      }),
    ).rejects.toThrow("archive asset path");
  });

  it("rejects duplicate paths and symlink sources", async () => {
    const { directory, source, outfile } = await fixture();
    const target = { path: source, name: "index.ios.bundle" };
    await expect(
      createTarBrTargetFiles({ outfile, targetFiles: [target, target] }),
    ).rejects.toThrow("duplicate");
    const link = path.join(directory, "link");
    await fs.symlink(source, link);
    await expect(
      createTarBrTargetFiles({
        outfile,
        targetFiles: [{ path: link, name: target.name }],
      }),
    ).rejects.toThrow("regular file");
  });
});
