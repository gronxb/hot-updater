import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerSecretValue } from "./secretMasking";

/**
 * Temporary files holding credential values a tool reads from disk, such as
 * an App Store Connect `.p8` key or an Android keystore.
 */
export interface CredentialFiles {
  /**
   * Writes `contents` to a new file named `fileName`, readable only by the
   * current user (0600), and returns its path. String contents are masked in
   * logs.
   */
  write(fileName: string, contents: string | Uint8Array): Promise<string>;
  /** Deletes every file written so far. */
  dispose(): Promise<void>;
}

const liveDirectories = new Set<string>();
let exitListenerRegistered = false;

// An `exit` listener must be synchronous.
const removeLiveDirectories = () => {
  for (const directory of liveDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  liveDirectories.clear();
};

const trackDirectory = (directory: string) => {
  liveDirectories.add(directory);
  if (!exitListenerRegistered) {
    exitListenerRegistered = true;
    process.on("exit", removeLiveDirectories);
  }
};

/**
 * Creates the temporary files of one credential resolver: a `mkdtemp`
 * directory, created on the first write and removed by `dispose` or, if the
 * process exits first, on `exit`.
 */
export const createCredentialFiles = (): CredentialFiles => {
  let directory: Promise<string> | undefined;

  const ensureDirectory = () => {
    directory ??= fs
      .mkdtemp(path.join(os.tmpdir(), "hot-updater-credentials-"))
      .then((created) => {
        trackDirectory(created);
        return created;
      });
    return directory;
  };

  return {
    write: async (fileName, contents) => {
      if (typeof contents === "string") {
        registerSecretValue(contents);
      }
      // One directory per file keeps the name a tool may require, such as
      // AuthKey_<keyId>.p8, even when two items share it.
      const fileDirectory = await fs.mkdtemp(
        path.join(await ensureDirectory(), "item-"),
      );
      const filePath = path.join(fileDirectory, path.basename(fileName));
      await fs.writeFile(filePath, contents, { flag: "wx", mode: 0o600 });
      return filePath;
    },
    dispose: async () => {
      const pending = directory;
      directory = undefined;
      if (!pending) {
        return;
      }
      const created = await pending.catch(() => undefined);
      if (!created) {
        return;
      }
      await fs.rm(created, { force: true, recursive: true });
      liveDirectories.delete(created);
    },
  };
};
