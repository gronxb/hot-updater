import { AsyncLocalStorage } from "node:async_hooks";

import { acquireFairFileLock, type FairFileLock } from "./fair-file-lock.ts";

type CheckoutLockOptions = Omit<
  Parameters<typeof acquireFairFileLock>[0],
  "capacity"
>;

// The lock a task of this process holds, so a nested acquire fails at once
// instead of waiting for itself.
const heldCheckoutLock = new AsyncLocalStorage<FairFileLock>();

/**
 * Runs `task` alone on one checkout's deploy inputs (config, patch surfaces,
 * fixture assets): one holder at a time, in arrival order, released
 * afterwards whether `task` failed or not. Every writer of those inputs, and
 * every build that reads them, runs inside it.
 */
export async function withCheckoutLock<T>(
  options: CheckoutLockOptions,
  task: (lock: FairFileLock) => Promise<T>,
): Promise<T> {
  const held = heldCheckoutLock.getStore();
  if (held) {
    throw new Error(
      `The checkout lock is already held by this task (${held.lockPath}); a nested acquire would wait for itself`,
    );
  }
  const lock = await acquireFairFileLock({ ...options, capacity: 1 });
  try {
    return await heldCheckoutLock.run(lock, () => task(lock));
  } finally {
    await lock.release();
  }
}
