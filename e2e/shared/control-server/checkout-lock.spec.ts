import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { withCheckoutLock } from "./checkout-lock.ts";
import { acquireFairFileLock, DEPLOY_LOCK_CAPACITY } from "./fair-file-lock.ts";

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
  it("runs one checkout's deploys and resets one at a time, in arrival order", async () => {
    await withLockRoot(async (lockRoot) => {
      const events: string[] = [];
      const firstHeld = Promise.withResolvers<void>();
      const finishFirst = Promise.withResolvers<void>();
      // Two identical deploys: the second must not write while the first's
      // build reads.
      const first = withCheckoutLock(
        { lockRoot, waitIntervalMs: 1 },
        async () => {
          events.push("deploy 1 writes and builds");
          firstHeld.resolve();
          await finishFirst.promise;
          events.push("deploy 1 done");
        },
      );
      await firstHeld.promise;

      const waiting = (label: string) => {
        const queued = Promise.withResolvers<void>();
        const done = withCheckoutLock(
          { lockRoot, onWait: () => queued.resolve(), waitIntervalMs: 1 },
          async () => {
            events.push(`${label} starts`);
            await sleep(5);
            events.push(`${label} done`);
          },
        );
        return { done, queued: queued.promise };
      };
      const second = waiting("deploy 2");
      await second.queued;
      const cleanup = waiting("cleanup");
      await cleanup.queued;
      await sleep(20);
      expect(events).toEqual(["deploy 1 writes and builds"]);

      finishFirst.resolve();
      await Promise.all([first, second.done, cleanup.done]);
      expect(events).toEqual([
        "deploy 1 writes and builds",
        "deploy 1 done",
        "deploy 2 starts",
        "deploy 2 done",
        "cleanup starts",
        "cleanup done",
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
            { lockRoot: androidCheckoutRoot, waitIntervalMs: 1 },
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
              lockRoot: iosCheckoutRoot,
              onWait: () => {
                iosCleanupWaited = true;
              },
              waitIntervalMs: 1,
            },
            async () => "cleaned",
          );
          expect(iosCleanupWaited).toBe(false);

          // A cleanup in the Android checkout does wait for its deploy.
          let androidCleanupDone = false;
          const androidCleanup = withCheckoutLock(
            { lockRoot: androidCheckoutRoot, waitIntervalMs: 1 },
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
      const options = { lockRoot, waitIntervalMs: 1 };
      await expect(
        withCheckoutLock(options, () =>
          withCheckoutLock(options, async () => "nested"),
        ),
      ).rejects.toThrow("a nested acquire would wait for itself");
      // The failed task released its lock: the next one gets it at once.
      await expect(withCheckoutLock(options, async () => "next")).resolves.toBe(
        "next",
      );
    });
  });
});
