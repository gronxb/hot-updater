import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { BuildArtifact } from "@hot-updater/plugin-core";
import {
  assertBundleArtifactByteSize,
  assertBundleExpandedByteSize,
  findPortableArtifactPathConflict,
  getBundleArchiveEntryCount,
  getPortableArtifactPathCollisionKey,
  getUtf8ByteSize,
  MAX_BUNDLE_ARCHIVE_ENTRIES,
  MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES,
  MAX_DECLARED_BUNDLE_ARTIFACTS,
} from "@hot-updater/plugin-core";

const isCanonicalArtifactName = (name: string) =>
  !!name &&
  !name.includes("\\") &&
  !name.includes(":") &&
  !path.posix.isAbsolute(name) &&
  [...name].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && codePoint !== 0x7f;
  }) &&
  name.split("/").every((part) => part && part !== "." && part !== "..");

export interface BundleArtifactSnapshot {
  artifacts: BuildArtifact[];
  expandedByteSize: number;
  path: string;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const COPY_BUFFER_SIZE = 64 * 1024;

const copyFileHandle = async (source: FileHandle, destination: FileHandle) => {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (bytesWritten === 0) {
        throw new Error("Failed to copy build artifact into snapshot");
      }
      written += bytesWritten;
    }
    position += bytesRead;
  }
};

const hasSameIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.ctimeNs === right.ctimeNs;

export async function getBundleZipTargets(
  basePath: string,
  artifacts: readonly BuildArtifact[],
): Promise<BundleArtifactSnapshot> {
  const base = path.resolve(basePath);
  const realBase = await fs.realpath(base);
  const checkedDirectories = new Set<string>();
  const checkDirectory = async (directory: string): Promise<void> => {
    if (checkedDirectories.has(directory)) return;
    const parent = path.dirname(directory);
    if (directory !== base) await checkDirectory(parent);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Build directory must not contain symbolic links: ${directory}`,
      );
    }
    checkedDirectories.add(directory);
  };
  await checkDirectory(base);

  const reserved = await fs
    .lstat(path.join(base, "manifest.json"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  if (reserved) throw new Error("Build output contains reserved manifest.json");
  if (artifacts.length === 0) {
    throw new Error("Build integration did not declare any artifacts");
  }
  if (artifacts.length > MAX_DECLARED_BUNDLE_ARTIFACTS) {
    throw new Error(
      `Build integration declared more than ${MAX_DECLARED_BUNDLE_ARTIFACTS} artifacts`,
    );
  }

  for (const artifact of artifacts) {
    if (!isCanonicalArtifactName(artifact.name)) {
      throw new Error(`Invalid build artifact name: ${artifact.name}`);
    }
    if (getUtf8ByteSize(artifact.name) > MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES) {
      throw new Error(
        `Build artifact name exceeds ${MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES} UTF-8 bytes: ${artifact.name}`,
      );
    }
    const portableName = getPortableArtifactPathCollisionKey(artifact.name);
    if (
      portableName === "manifest.json" ||
      portableName.startsWith("manifest.json/")
    ) {
      throw new Error("Build output contains reserved manifest.json");
    }
  }
  const pathConflict = findPortableArtifactPathConflict(
    artifacts.map(({ name }) => name),
  );
  if (pathConflict?.kind === "duplicate") {
    throw new Error(`Duplicate build artifact name: ${pathConflict.second}`);
  }
  if (pathConflict?.kind === "ancestor") {
    throw new Error(
      `Build artifact names conflict as file and descendant: ${pathConflict.ancestor}, ${pathConflict.descendant}`,
    );
  }
  if (pathConflict?.kind === "directory-alias") {
    throw new Error(
      `Build artifact directories have a portable name collision: ${pathConflict.first}, ${pathConflict.second}`,
    );
  }
  if (
    getBundleArchiveEntryCount(artifacts.map(({ name }) => name)) >
    MAX_BUNDLE_ARCHIVE_ENTRIES
  ) {
    throw new Error(
      `Build artifact archive would contain more than ${MAX_BUNDLE_ARCHIVE_ENTRIES} entries`,
    );
  }

  const validated: {
    artifact: BuildArtifact;
    initialStat: BigIntStats;
    path: string;
    relativePath: string;
  }[] = [];
  let expandedByteSize = 0n;
  for (const artifact of artifacts) {
    if (
      artifact.downloadCompression !== null &&
      artifact.downloadCompression !== "br"
    ) {
      throw new Error(
        `Invalid download compression for build artifact: ${artifact.name}`,
      );
    }
    if (
      (path.sep !== "\\" && artifact.path.includes("\\")) ||
      artifact.path.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`Invalid build artifact path: ${artifact.path}`);
    }
    const absolute = path.resolve(base, artifact.path);
    const relative = path.relative(base, absolute);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Build artifact is outside the build directory: ${artifact.path}`,
      );
    }
    await checkDirectory(path.dirname(absolute));
    const stat = await fs.lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Build artifact must be a regular file: ${artifact.path}`,
      );
    }
    assertBundleArtifactByteSize(stat.size, artifact.name);
    expandedByteSize += stat.size;
    assertBundleExpandedByteSize(expandedByteSize);
    validated.push({
      artifact,
      initialStat: stat,
      path: absolute,
      relativePath: relative,
    });
  }

  const openedSources: {
    source: FileHandle;
    stat: BigIntStats;
    target: (typeof validated)[number];
  }[] = [];
  let snapshotPath: string | null = null;
  let operationError: unknown;
  let operationFailed = false;
  let result: BundleArtifactSnapshot | undefined;
  const targets: BuildArtifact[] = [];
  try {
    for (const target of validated) {
      const source = await fs.open(target.path, constants.O_RDONLY | noFollow);
      try {
        const openedStat = await source.stat({ bigint: true });
        const namedStat = await fs.lstat(target.path, { bigint: true });
        const realSource = await fs.realpath(target.path);
        if (
          !openedStat.isFile() ||
          namedStat.isSymbolicLink() ||
          !namedStat.isFile() ||
          !hasSameIdentity(target.initialStat, openedStat) ||
          !hasSameIdentity(target.initialStat, namedStat) ||
          realSource !== path.join(realBase, target.relativePath)
        ) {
          throw new Error(
            `Build artifact changed during snapshot: ${target.artifact.path}`,
          );
        }
        openedSources.push({ source, stat: openedStat, target });
      } catch (error) {
        await source.close().catch(() => {});
        throw error;
      }
    }

    snapshotPath = await fs.mkdtemp(path.join(base, ".hot-updater-snapshot-"));
    for (const [index, { source, stat, target }] of openedSources.entries()) {
      const snapshotFile = path.join(
        snapshotPath,
        `artifact-${String(index).padStart(6, "0")}`,
      );
      const destination = await fs.open(
        snapshotFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o400,
      );
      try {
        await copyFileHandle(source, destination);
        await destination.sync();
      } finally {
        await destination.close();
      }
      const copiedStat = await source.stat({ bigint: true });
      if (
        !hasSameIdentity(stat, copiedStat) ||
        copiedStat.mtimeNs !== stat.mtimeNs
      ) {
        throw new Error(
          `Build artifact changed during snapshot: ${target.artifact.path}`,
        );
      }
      targets.push({ ...target.artifact, path: snapshotFile });
    }
    result = {
      artifacts: targets,
      expandedByteSize: Number(expandedByteSize),
      path: snapshotPath,
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (snapshotPath) {
      await fs
        .rm(snapshotPath, { recursive: true, force: true })
        .catch(() => {});
    }
  }

  const closeResults = await Promise.allSettled(
    openedSources.map(({ source }) => source.close()),
  );
  if (operationFailed) throw operationError;

  const closeFailure = closeResults.find(
    (closeResult): closeResult is PromiseRejectedResult =>
      closeResult.status === "rejected",
  );
  if (closeFailure) {
    if (snapshotPath) {
      await fs.rm(snapshotPath, { recursive: true, force: true });
    }
    throw closeFailure.reason;
  }
  return result!;
}
