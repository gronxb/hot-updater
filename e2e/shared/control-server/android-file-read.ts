/** What one `adb` read returns, as `spawnSync` gives it. */
export interface AdbReadResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

/** One way to read a file: its `adb` arguments, and how often to retry it. */
export interface AdbReadAttempt {
  readonly args: readonly string[];
  /** Reruns after a non-zero exit, before the next way is tried. */
  readonly retries?: number;
}

/** How long a failed read waits before it runs again. */
export const ADB_READ_RETRY_DELAY_MS = 500;

/**
 * Reads a file with the first of `attempts` that exits 0. An attempt with
 * `retries` runs again after `wait(ADB_READ_RETRY_DELAY_MS)` when it fails,
 * such as a large `exec-out run-as cat` the device drops; what each failed
 * run said is kept, in order, for the evidence.
 */
export function readWithRetries(
  attempts: readonly AdbReadAttempt[],
  run: (args: readonly string[]) => AdbReadResult,
  wait: (milliseconds: number) => void,
): { fileBuffer: Buffer | null; readError: string | null } {
  const readErrors: string[] = [];
  for (const { args, retries = 0 } of attempts) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) wait(ADB_READ_RETRY_DELAY_MS);
      const result = run(args);
      if (result.status === 0) {
        return { fileBuffer: result.stdout, readError: null };
      }
      readErrors.push(
        result.stderr.toString().trim() ||
          result.error?.message ||
          `adb exited ${String(result.status)}`,
      );
    }
  }
  return { fileBuffer: null, readError: readErrors.join(" | ") };
}

/** Blocks the thread for `milliseconds`: the controller's reads are synchronous. */
export function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
