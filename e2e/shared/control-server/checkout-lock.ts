import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { acquireFairFileLock, type FairFileLock } from "./fair-file-lock.ts";

type CheckoutLockOptions = Parameters<typeof acquireFairFileLock>[0] & {
  readonly key: string;
};

// The lock a task of this process holds, so a nested acquire fails at once
// instead of waiting for itself: an exclusive key never shares, and a
// waiter never passes the holder it waits behind.
const heldCheckoutLock = new AsyncLocalStorage<FairFileLock>();

/**
 * A key no other holder has: the task runs alone on the shared checkout,
 * after every holder ahead of it has released.
 */
export function exclusiveCheckoutLockKey(): string {
  return `exclusive:${randomUUID()}`;
}

/**
 * Runs `task` while holding the shared checkout's lock under `key` (see
 * FairFileLockOptions.key) and releases it afterwards, failed or not.
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
  const lock = await acquireFairFileLock(options);
  try {
    return await heldCheckoutLock.run(lock, () => task(lock));
  } finally {
    await lock.release();
  }
}
