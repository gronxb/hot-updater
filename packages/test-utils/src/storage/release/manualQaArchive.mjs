import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

const archiveDirectoryFor = (output) => `${output}.tarballs`;

export const assertManualQaArchiveAvailable = (output) => {
  const archiveDirectory = archiveDirectoryFor(output);
  if (existsSync(output)) {
    throw new TypeError(`Release-driver output already exists: ${output}`);
  }
  if (existsSync(archiveDirectory)) {
    throw new TypeError(
      `Manual-QA tarball archive already exists: ${archiveDirectory}`,
    );
  }
  return archiveDirectory;
};

export const archiveManualQaTarballs = ({ archiveDirectory, tarballs }) => {
  mkdirSync(archiveDirectory, { recursive: true });
  const archivedTarballs = new Map();
  try {
    for (const [name, tarball] of tarballs) {
      const archivedTarball = path.join(
        archiveDirectory,
        path.basename(tarball),
      );
      copyFileSync(tarball, archivedTarball, constants.COPYFILE_EXCL);
      chmodSync(archivedTarball, 0o444);
      archivedTarballs.set(name, archivedTarball);
    }
    chmodSync(archiveDirectory, 0o555);
    return archivedTarballs;
  } catch (error) {
    rmSync(archiveDirectory, { force: true, recursive: true });
    throw error;
  }
};

export const discardManualQaTarballArchive = (archiveDirectory) => {
  rmSync(archiveDirectory, { force: true, recursive: true });
};

export const assertManualQaArchiveHandoffAvailable = ({
  sourceRoot,
  destinationRoot,
}) => {
  const source = lstatSync(sourceRoot);
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new TypeError(
      `Manual-QA archive source is not an exact directory: ${sourceRoot}`,
    );
  }
  if (existsSync(destinationRoot)) {
    throw new TypeError(
      `Manual-QA archive destination already exists: ${destinationRoot}`,
    );
  }
  const destinationParent = path.dirname(destinationRoot);
  const parent = lstatSync(destinationParent);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new TypeError(
      `Manual-QA archive destination parent is invalid: ${destinationParent}`,
    );
  }
  if (
    statSync(path.dirname(sourceRoot)).dev !== statSync(destinationParent).dev
  ) {
    throw new TypeError(
      "Manual-QA archive handoff requires a same-device destination.",
    );
  }
  return Object.freeze({ sourceRoot, destinationRoot });
};

export const handoffManualQaArchiveRoot = (input) => {
  const handoff = assertManualQaArchiveHandoffAvailable(input);
  renameSync(handoff.sourceRoot, handoff.destinationRoot);
  if (existsSync(handoff.sourceRoot) || !existsSync(handoff.destinationRoot)) {
    throw new TypeError("Manual-QA archive handoff did not complete.");
  }
};
