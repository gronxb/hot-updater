import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

// A build's DerivedData alone takes 10 GB or more: xcodebuild may still be
// writing to it when it is stopped, so a removal retries.
const REMOVE_OPTIONS = { force: true, recursive: true, maxRetries: 3 };

const liveDirectories = new Set<string>();

// Node exits on a termination signal without emitting `exit`, so both are
// listened to while temporary directories exist.
const onSignal = (signal: NodeJS.Signals) => {
  removeLiveDirectories();
  // Re-raise so the process still ends with the signal, unless another
  // listener (such as a running xcodebuild's) handles it.
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
};

// An `exit` listener must be synchronous. A removal that fails, such as
// one racing an xcodebuild that is still stopping, must not keep the others
// from running, nor the signal from being re-raised: a build's own
// `removeTmpDir` removes what is left as it unwinds.
const removeLiveDirectories = () => {
  for (const directory of liveDirectories) {
    try {
      rmSync(directory, REMOVE_OPTIONS);
    } catch {
      // Best effort.
    }
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

/**
 * Creates a directory in the system's temporary directory, which
 * `removeTmpDir` removes, and which is otherwise removed when the process
 * exits or is stopped by a signal.
 */
export const createRandomTmpDir = async (prefix = "apple-helper-") => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  if (liveDirectories.size === 0) {
    startListening();
  }
  liveDirectories.add(directory);
  return directory;
};

/**
 * Removes a directory `createRandomTmpDir` created. It stays tracked until
 * it is gone, so a signal during a removal that takes seconds, such as
 * DerivedData's, still finishes it.
 */
export const removeTmpDir = async (directory: string) => {
  await rm(directory, REMOVE_OPTIONS);
  if (liveDirectories.delete(directory) && liveDirectories.size === 0) {
    stopListening();
  }
};
