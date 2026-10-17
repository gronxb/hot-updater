import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { exclusiveCheckoutLockKey, withCheckoutLock } from "./checkout-lock.ts";
import {
  acquireFairFileLock,
  CHECKOUT_INPUTS_LOCK_CAPACITY,
  DEPLOY_LOCK_CAPACITY,
} from "./fair-file-lock.ts";

const withLockRoot = async (run: (lockRoot: string) => Promise<void>) => {
  const lockRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-checkout-lock-"),
  );
  try {
    await run(lockRoot);
  } finally {
    await fs.rm(lockRoot, { force: true, recursive: true });
  }
};

describe("E2E checkout lock", () => {
  it("runs an exclusive task alone, after the deploys ahead of it", async () => {
    await withLockRoot(async (lockRoot) => {
      const events: string[] = [];
      const options = (key: string) => ({
        capacity: DEPLOY_LOCK_CAPACITY,
        key,
        lockRoot,
        waitIntervalMs: 1,
      });
      const deployHeld = Promise.withResolvers<void>();
      const finishDeploy = Promise.withResolvers<void>();
      const deploy = withCheckoutLock(options("main"), async () => {
        events.push("deploy start");
        deployHeld.resolve();
        await finishDeploy.promise;
        events.push("deploy end");
      });
      await deployHeld.promise;

      const bootstrapWaiting = Promise.withResolvers<void>();
      const bootstrap = withCheckoutLock(
        {
          ...options(exclusiveCheckoutLockKey()),
          onWait: () => bootstrapWaiting.resolve(),
        },
        async () => {
          events.push("bootstrap start");
          await sleep(20);
          events.push("bootstrap end");
        },
      );
      await bootstrapWaiting.promise;
      // A deploy queued behind the bootstrap, even with the holder's key.
      const lateDeployWaiting = Promise.withResolvers<void>();
      const lateDeploy = withCheckoutLock(
        { ...options("main"), onWait: () => lateDeployWaiting.resolve() },
        async () => {
          events.push("late deploy");
        },
      );
      await lateDeployWaiting.promise;

      finishDeploy.resolve();
      await Promise.all([deploy, bootstrap, lateDeploy]);
      expect(events).toEqual([
        "deploy start",
        "deploy end",
        "bootstrap start",
        "bootstrap end",
        "late deploy",
      ]);
    });
  });

  it("never makes one checkout's cleanup wait on another checkout's deploy", async () => {
    await withLockRoot(async (sharedRoot) => {
      await withLockRoot(async (iosCheckoutRoot) => {
        await withLockRoot(async (androidCheckoutRoot) => {
          // The Android shard's deploy holds its checkout's inputs and its
          // turn in the shards' shared build limit.
          const deployHeld = Promise.withResolvers<void>();
          const finishDeploy = Promise.withResolvers<void>();
          const androidDeploy = withCheckoutLock(
            {
              capacity: CHECKOUT_INPUTS_LOCK_CAPACITY,
              key: "android-main",
              lockRoot: androidCheckoutRoot,
              waitIntervalMs: 1,
            },
            async () => {
              const build = await acquireFairFileLock({
                capacity: DEPLOY_LOCK_CAPACITY,
                lockRoot: sharedRoot,
                waitIntervalMs: 1,
              });
              deployHeld.resolve();
              await finishDeploy.promise;
              await build.release();
            },
          );
          await deployHeld.promise;

          // The iOS shard's cleanup takes only its own checkout's lock.
          let iosCleanupWaited = false;
          await withCheckoutLock(
            {
              capacity: CHECKOUT_INPUTS_LOCK_CAPACITY,
              key: exclusiveCheckoutLockKey(),
              lockRoot: iosCheckoutRoot,
              onWait: () => {
                iosCleanupWaited = true;
              },
              waitIntervalMs: 1,
            },
            async () => "cleaned",
          );
          expect(iosCleanupWaited).toBe(false);

          // An exclusive task in the Android checkout does wait for it.
          let androidCleanupDone = false;
          const androidCleanup = withCheckoutLock(
            {
              capacity: CHECKOUT_INPUTS_LOCK_CAPACITY,
              key: exclusiveCheckoutLockKey(),
              lockRoot: androidCheckoutRoot,
              waitIntervalMs: 1,
            },
            async () => {
              androidCleanupDone = true;
            },
          );
          await sleep(20);
          expect(androidCleanupDone).toBe(false);
          finishDeploy.resolve();
          await Promise.all([androidDeploy, androidCleanup]);
          expect(androidCleanupDone).toBe(true);
        });
      });
    });
  });

  it("refuses a nested acquire instead of waiting for itself, and releases on failure", async () => {
    await withLockRoot(async (lockRoot) => {
      const options = {
        capacity: DEPLOY_LOCK_CAPACITY,
        key: exclusiveCheckoutLockKey(),
        lockRoot,
        waitIntervalMs: 1,
      };
      await expect(
        withCheckoutLock(options, () =>
          withCheckoutLock(
            { ...options, key: exclusiveCheckoutLockKey() },
            async () => "nested",
          ),
        ),
      ).rejects.toThrow("a nested acquire would wait for itself");
      // The failed task released its lock: the next one gets it at once.
      await expect(
        withCheckoutLock(
          { ...options, key: exclusiveCheckoutLockKey() },
          async () => "next",
        ),
      ).resolves.toBe("next");
    });
  });
});
