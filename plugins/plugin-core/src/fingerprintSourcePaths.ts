import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { compareStringsByCodeUnit } from "./deterministicOrder";

export interface FingerprintSourcePath {
  absolutePath: string;
  filePath: string;
  type: "file" | "dir";
  allowedRoot?: string;
  followSymbolicLinks?: boolean;
  includeDirectories?: boolean;
  initialFileStat?: BigIntStats;
  resolvedFilePath?: string;
  resolvedLinkTarget?: string;
  symbolicLinkTarget?: string;
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

export async function resolveFingerprintSourcePaths({
  allowedRoot: configuredAllowedRoot,
  cwd,
  followSymbolicLinks = false,
  ignore = [],
  includeDirectories = false,
  patterns,
}: {
  allowedRoot?: string;
  cwd: string;
  followSymbolicLinks?: boolean;
  ignore?: readonly string[];
  includeDirectories?: boolean;
  patterns: readonly string[];
}): Promise<FingerprintSourcePath[]> {
  const allowedRoot = await fs.realpath(configuredAllowedRoot ?? cwd);
  const realCwd = await fs.realpath(cwd);
  if (!isWithinRoot(allowedRoot, realCwd)) {
    throw new Error("Fingerprint source directory escaped its allowed root");
  }
  const matches = await fg([...patterns], {
    absolute: true,
    cwd,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...ignore],
    onlyFiles: false,
    unique: true,
  });
  const sources = new Map<string, FingerprintSourcePath>();
  for (const absolutePath of matches) {
    const linkStat = await fs.lstat(absolutePath, { bigint: true });
    const filePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
    if (linkStat.isSymbolicLink()) {
      const symbolicLinkTarget = await fs.readlink(absolutePath);
      let resolvedLinkTarget: string | undefined;
      let type: FingerprintSourcePath["type"] = "file";
      try {
        const candidate = await fs.realpath(absolutePath);
        if (isWithinRoot(allowedRoot, candidate)) {
          const targetStat = await fs.stat(candidate);
          if (targetStat.isFile()) {
            resolvedLinkTarget = candidate;
          } else if (
            targetStat.isDirectory() &&
            includeDirectories &&
            followSymbolicLinks
          ) {
            type = "dir";
            resolvedLinkTarget = candidate;
          }
        }
      } catch {
        // Broken and cyclic links still contribute their link target identity.
      }
      sources.set(`${type}:${filePath}`, {
        absolutePath,
        filePath,
        type,
        allowedRoot,
        followSymbolicLinks,
        includeDirectories,
        resolvedLinkTarget,
        symbolicLinkTarget,
      });
      continue;
    }
    const type = linkStat.isDirectory()
      ? "dir"
      : linkStat.isFile()
        ? "file"
        : null;
    if (!type || (!includeDirectories && type === "dir")) continue;
    const resolvedFilePath =
      type === "file" ? await fs.realpath(absolutePath) : undefined;
    if (resolvedFilePath && !isWithinRoot(allowedRoot, resolvedFilePath)) {
      throw new Error(
        `Fingerprint source escaped its allowed root: ${filePath}`,
      );
    }
    sources.set(`${type}:${filePath}`, {
      absolutePath,
      allowedRoot,
      filePath,
      followSymbolicLinks,
      includeDirectories,
      initialFileStat: type === "file" ? linkStat : undefined,
      resolvedFilePath,
      type,
    });
  }
  return [...sources.values()].sort((left, right) =>
    compareStringsByCodeUnit(left.filePath, right.filePath),
  );
}

const hasSameFileIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.ctimeNs === right.ctimeNs;

const readVerifiedRegularFile = async ({
  absolutePath,
  allowedRoot,
  filePath,
  initialStat,
  resolvedFilePath,
}: {
  absolutePath: string;
  allowedRoot?: string;
  filePath: string;
  initialStat: BigIntStats;
  resolvedFilePath: string;
}) => {
  const handle = await fs.open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const [openedStat, namedStat, currentResolvedPath] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(absolutePath, { bigint: true }),
      fs.realpath(absolutePath),
    ]);
    if (
      !openedStat.isFile() ||
      namedStat.isSymbolicLink() ||
      !namedStat.isFile() ||
      !hasSameFileIdentity(initialStat, openedStat) ||
      !hasSameFileIdentity(initialStat, namedStat) ||
      currentResolvedPath !== resolvedFilePath ||
      (allowedRoot !== undefined &&
        !isWithinRoot(allowedRoot, currentResolvedPath))
    ) {
      throw new Error(`Fingerprint source changed: ${filePath}`);
    }

    const bytes = await handle.readFile();
    const [finalOpenedStat, finalNamedStat, finalResolvedPath] =
      await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(absolutePath, { bigint: true }),
        fs.realpath(absolutePath),
      ]);
    if (
      finalNamedStat.isSymbolicLink() ||
      !finalNamedStat.isFile() ||
      !hasSameFileIdentity(initialStat, finalOpenedStat) ||
      !hasSameFileIdentity(initialStat, finalNamedStat) ||
      finalResolvedPath !== resolvedFilePath ||
      (allowedRoot !== undefined &&
        !isWithinRoot(allowedRoot, finalResolvedPath))
    ) {
      throw new Error(`Fingerprint source changed: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const hashSymbolicLink = async (
  source: FingerprintSourcePath,
  visitedDirectories: ReadonlySet<string>,
) => {
  const digest = createHash("sha256");
  const linkTarget = source.symbolicLinkTarget!;
  digest.update("symlink\0");
  digest.update(linkTarget);
  digest.update("\0");
  let byteSize = Buffer.byteLength(linkTarget);

  if (source.resolvedLinkTarget && source.allowedRoot) {
    const [currentTarget, currentLinkTarget] = await Promise.all([
      fs.realpath(source.absolutePath),
      fs.readlink(source.absolutePath),
    ]);
    if (
      currentTarget !== source.resolvedLinkTarget ||
      currentLinkTarget !== linkTarget ||
      !isWithinRoot(source.allowedRoot, currentTarget)
    ) {
      throw new Error(`Fingerprint source changed: ${source.filePath}`);
    }
    if (source.type === "dir") {
      const canonicalTarget = await fs.realpath(source.resolvedLinkTarget);
      if (
        canonicalTarget !== source.resolvedLinkTarget ||
        !isWithinRoot(source.allowedRoot, canonicalTarget)
      ) {
        throw new Error(
          `Fingerprint symlink target escaped its root: ${source.filePath}`,
        );
      }
      if (visitedDirectories.has(canonicalTarget)) {
        digest.update("cycle");
      } else {
        const targetHash = await hashFingerprintSourcePathInternal(
          {
            absolutePath: canonicalTarget,
            allowedRoot: source.allowedRoot,
            filePath: source.filePath,
            followSymbolicLinks: source.followSymbolicLinks,
            includeDirectories: source.includeDirectories,
            type: "dir",
          },
          visitedDirectories,
        );
        byteSize += targetHash.byteSize;
        digest.update(targetHash.hash);
      }
      const [finalTarget, finalLinkTarget] = await Promise.all([
        fs.realpath(source.absolutePath),
        fs.readlink(source.absolutePath),
      ]);
      if (
        finalTarget !== source.resolvedLinkTarget ||
        finalLinkTarget !== linkTarget ||
        !isWithinRoot(source.allowedRoot, finalTarget)
      ) {
        throw new Error(`Fingerprint source changed: ${source.filePath}`);
      }
      digest.update("\0");
    } else {
      const initialTargetStat = await fs.lstat(source.resolvedLinkTarget, {
        bigint: true,
      });
      if (initialTargetStat.isSymbolicLink() || !initialTargetStat.isFile()) {
        throw new Error(
          `Fingerprint symlink target is not a file: ${source.filePath}`,
        );
      }
      const bytes = await readVerifiedRegularFile({
        absolutePath: source.resolvedLinkTarget,
        allowedRoot: source.allowedRoot,
        filePath: source.filePath,
        initialStat: initialTargetStat,
        resolvedFilePath: source.resolvedLinkTarget,
      });
      const [finalTarget, finalLinkTarget] = await Promise.all([
        fs.realpath(source.absolutePath),
        fs.readlink(source.absolutePath),
      ]);
      if (
        finalTarget !== source.resolvedLinkTarget ||
        finalLinkTarget !== linkTarget ||
        !isWithinRoot(source.allowedRoot, finalTarget)
      ) {
        throw new Error(`Fingerprint source changed: ${source.filePath}`);
      }
      byteSize += bytes.byteLength;
      digest.update(createHash("sha256").update(bytes).digest());
      digest.update("\0");
    }
  }

  return { byteSize, hash: digest.digest("hex") };
};

const hashRegularFile = async (source: FingerprintSourcePath) => {
  const initialStat =
    source.initialFileStat ??
    (await fs.lstat(source.absolutePath, { bigint: true }));
  const resolvedFilePath =
    source.resolvedFilePath ?? (await fs.realpath(source.absolutePath));
  const bytes = await readVerifiedRegularFile({
    absolutePath: source.absolutePath,
    allowedRoot: source.allowedRoot,
    filePath: source.filePath,
    initialStat,
    resolvedFilePath,
  });
  return {
    byteSize: bytes.byteLength,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
};

interface FingerprintDirectoryIdentity {
  absolutePath: string;
  ctimeNs: bigint;
  dev: bigint;
  entries: readonly string[];
  ino: bigint;
  mtimeNs: bigint;
  resolvedPath: string;
}

const snapshotFingerprintDirectories = async (
  root: string,
  allowedRoot: string,
): Promise<Map<string, FingerprintDirectoryIdentity>> => {
  const directories = new Map<string, FingerprintDirectoryIdentity>();
  const visit = async (absolutePath: string, relativePath: string) => {
    const [stat, resolvedPath] = await Promise.all([
      fs.lstat(absolutePath, { bigint: true }),
      fs.realpath(absolutePath),
    ]);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !isWithinRoot(allowedRoot, resolvedPath)
    ) {
      throw new Error(`Fingerprint source changed: ${relativePath || "."}`);
    }
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) =>
      compareStringsByCodeUnit(left.name, right.name),
    );
    const entryIdentities: string[] = [];
    for (const entry of entries) {
      const childPath = path.join(absolutePath, entry.name);
      const childStat = await fs.lstat(childPath, { bigint: true });
      entryIdentities.push(
        `${childStat.isSymbolicLink() ? "link" : childStat.isDirectory() ? "dir" : childStat.isFile() ? "file" : "other"}:${entry.name}`,
      );
      if (!childStat.isSymbolicLink() && childStat.isDirectory()) {
        await visit(
          childPath,
          relativePath ? `${relativePath}/${entry.name}` : entry.name,
        );
      }
    }
    const [finalStat, finalResolvedPath] = await Promise.all([
      fs.lstat(absolutePath, { bigint: true }),
      fs.realpath(absolutePath),
    ]);
    if (
      finalStat.isSymbolicLink() ||
      !finalStat.isDirectory() ||
      stat.dev !== finalStat.dev ||
      stat.ino !== finalStat.ino ||
      stat.ctimeNs !== finalStat.ctimeNs ||
      stat.mtimeNs !== finalStat.mtimeNs ||
      resolvedPath !== finalResolvedPath ||
      !isWithinRoot(allowedRoot, finalResolvedPath)
    ) {
      throw new Error(`Fingerprint source changed: ${relativePath || "."}`);
    }
    directories.set(relativePath, {
      absolutePath,
      ctimeNs: stat.ctimeNs,
      dev: stat.dev,
      entries: entryIdentities,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      resolvedPath,
    });
  };
  await visit(root, "");
  return directories;
};

const assertSameFingerprintDirectories = (
  before: ReadonlyMap<string, FingerprintDirectoryIdentity>,
  after: ReadonlyMap<string, FingerprintDirectoryIdentity>,
  filePath: string,
) => {
  if (before.size !== after.size) {
    throw new Error(`Fingerprint source changed: ${filePath}`);
  }
  for (const [relativePath, initial] of before) {
    const final = after.get(relativePath);
    if (
      !final ||
      initial.absolutePath !== final.absolutePath ||
      initial.resolvedPath !== final.resolvedPath ||
      initial.entries.length !== final.entries.length ||
      initial.entries.some((entry, index) => entry !== final.entries[index]) ||
      initial.dev !== final.dev ||
      initial.ino !== final.ino ||
      initial.ctimeNs !== final.ctimeNs ||
      initial.mtimeNs !== final.mtimeNs
    ) {
      throw new Error(`Fingerprint source changed: ${filePath}`);
    }
  }
};

const hashFingerprintSourcePathInternal = async (
  source: FingerprintSourcePath,
  visitedDirectories: ReadonlySet<string>,
): Promise<{ byteSize: number; hash: string }> => {
  if (source.symbolicLinkTarget !== undefined) {
    return hashSymbolicLink(source, visitedDirectories);
  }
  if (source.type === "file") {
    return hashRegularFile(source);
  }

  const canonicalDirectory = await fs.realpath(source.absolutePath);
  if (visitedDirectories.has(canonicalDirectory)) {
    return {
      byteSize: 0,
      hash: createHash("sha256").update("cycle").digest("hex"),
    };
  }
  const nextVisitedDirectories = new Set(visitedDirectories).add(
    canonicalDirectory,
  );
  const allowedRoot = await fs.realpath(
    source.allowedRoot ?? canonicalDirectory,
  );
  if (!isWithinRoot(allowedRoot, canonicalDirectory)) {
    throw new Error(`Fingerprint source changed: ${source.filePath}`);
  }
  const initialDirectories = await snapshotFingerprintDirectories(
    canonicalDirectory,
    allowedRoot,
  );
  const files = (
    await resolveFingerprintSourcePaths({
      allowedRoot,
      cwd: source.absolutePath,
      followSymbolicLinks: source.followSymbolicLinks,
      includeDirectories: source.includeDirectories,
      patterns: ["**/*"],
    })
  ).filter(
    (file) => file.type === "file" || file.symbolicLinkTarget !== undefined,
  );
  const digest = createHash("sha256");
  let byteSize = 0;
  for (const file of files) {
    const hashed = await hashFingerprintSourcePathInternal(
      file,
      nextVisitedDirectories,
    );
    byteSize += hashed.byteSize;
    digest.update(file.filePath);
    digest.update("\0");
    digest.update(hashed.hash);
    digest.update("\0");
  }
  const finalDirectories = await snapshotFingerprintDirectories(
    canonicalDirectory,
    allowedRoot,
  );
  assertSameFingerprintDirectories(
    initialDirectories,
    finalDirectories,
    source.filePath,
  );
  return { byteSize, hash: digest.digest("hex") };
};

export const hashFingerprintSourcePath = (source: FingerprintSourcePath) =>
  hashFingerprintSourcePathInternal(source, new Set());
