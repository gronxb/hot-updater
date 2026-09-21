import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress } from "node:zlib";

import type { ManifestArchive } from "@hot-updater/core";
import * as tar from "tar";

/** Build the one supported bulk transport from the exact manifest file set. */
export async function createTarBrTargetFiles({
  outfile,
  targetFiles,
}: {
  outfile: string;
  targetFiles: { path: string; name: string }[];
}): Promise<ManifestArchive> {
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  const staging = await fs.mkdtemp(
    path.join(path.dirname(outfile), ".tar-br-"),
  );
  try {
    const names = new Set<string>();
    for (const target of targetFiles) {
      const name = target.name;
      if (
        !name ||
        name !== name.trim() ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.startsWith("/") ||
        /^[A-Za-z]:/.test(name) ||
        name
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        name === "manifest.json" ||
        name === "bundle.tar.br" ||
        names.has(name)
      ) {
        throw new Error(`Invalid or duplicate archive asset path: ${name}`);
      }
      if (!(await fs.lstat(target.path)).isFile()) {
        throw new Error(`Archive asset is not a regular file: ${name}`);
      }
      names.add(name);
      const destination = path.join(staging, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(target.path, destination);
      await fs.chmod(destination, 0o644);
    }
    let tarByteSize = 0;
    const countTarBytes = new Transform({
      transform(chunk, _encoding, callback) {
        tarByteSize += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(
      tar.create(
        { cwd: staging, portable: true, mtime: new Date(0), gzip: false },
        [...names].sort(),
      ),
      countTarBytes,
      createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
      createWriteStream(outfile),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(outfile)) hash.update(chunk);
    return {
      downloadFileHash: hash.digest("hex"),
      downloadByteSize: (await fs.stat(outfile)).size,
      tarByteSize,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
