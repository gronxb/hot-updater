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
  /** Deletes every file written so far; nothing can be written after it. */
  dispose(): Promise<void>;
}

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

const liveDirectories = new Set<string>();

// Node exits on a termination signal without emitting `exit`, so both are
// listened to while credential files exist.
const onSignal = (signal: NodeJS.Signals) => {
  removeLiveDirectories();
  // Re-raise so the process still ends with the signal, unless another
  // listener (such as a native build's) handles it.
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
};

// An `exit` listener must be synchronous.
const removeLiveDirectories = () => {
  for (const directory of liveDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  liveDirectories.clear();
  stopListening();
};

const startListening = () => {
  process.on("exit", removeLiveDirectories);
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, onSignal);
  }
};

const stopListening = () => {
  process.off("exit", removeLiveDirectories);
  for (const signal of TERMINATION_SIGNALS) {
    process.off(signal, onSignal);
  }
};

const trackDirectory = (directory: string) => {
  if (liveDirectories.size === 0) {
    startListening();
  }
  liveDirectories.add(directory);
};

const untrackDirectory = (directory: string) => {
  if (liveDirectories.delete(directory) && liveDirectories.size === 0) {
    stopListening();
  }
};

/**
 * Creates the temporary files of one credential resolver: a `mkdtemp`
 * directory, created on the first write and removed by `dispose` or, if the
 * process exits first, on `exit` or a termination signal.
 */
export const createCredentialFiles = (): CredentialFiles => {
  let directory: Promise<string> | undefined;
  let disposal: Promise<void> | undefined;

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
      if (disposal) {
        throw new Error("The credential files have been disposed.");
      }
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
    // Every caller waits for the same deletion.
    dispose: () => {
      disposal ??= (async () => {
        const created = await directory?.catch(() => undefined);
        if (!created) {
          return;
        }
        await fs.rm(created, { force: true, recursive: true });
        untrackDirectory(created);
      })();
      return disposal;
    },
  };
};
