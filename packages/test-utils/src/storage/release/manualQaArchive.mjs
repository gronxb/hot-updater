import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
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
