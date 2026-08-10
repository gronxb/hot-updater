import fs from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

import { describe, expect, it } from "vitest";

import {
  acquireFairFileLock,
  resolveDeployLockCapacity,
} from "./fair-file-lock.ts";

const repoDir = path.resolve(__dirname, "../../..");
const controllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);

describe("Detox control-server deploy lock", () => {
  it("routes deploy mutations through the provider-aware fair file lock", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).toContain("acquireFairFileLock,");
    expect(controllerSource).toContain('from "./fair-file-lock.ts";');
    expect(controllerSource).toContain(
      "const deployProcessLock = await acquireFairFileLock({",
    );
    expect(controllerSource).toContain(
      "capacity: resolveDeployLockCapacity(),",
    );
    expect(controllerSource).not.toContain(
      "async function acquireDeployProcessLock",
    );
  });

  it("keeps legacy databases serialized and allows two DynamoDB deploys", () => {
    expect(resolveDeployLockCapacity({})).toBe(1);
    expect(
      resolveDeployLockCapacity({ HOT_UPDATER_DYNAMODB_TABLE_NAME: "" }),
    ).toBe(1);
    expect(
      resolveDeployLockCapacity({
        HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater",
      }),
    ).toBe(2);
  });

  it("allows two deploys while keeping the next waiter queued", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-bounded-lock-"),
    );
    const thirdWaiting = Promise.withResolvers<void>();
    let first: Awaited<ReturnType<typeof acquireFairFileLock>> | null = null;
    let second: Awaited<ReturnType<typeof acquireFairFileLock>> | null = null;
    let third: Awaited<ReturnType<typeof acquireFairFileLock>> | null = null;
    let secondPromise: ReturnType<typeof acquireFairFileLock> | null = null;

    try {
      first = await acquireFairFileLock({
        capacity: 2,
        lockRoot,
        waitIntervalMs: 1,
      });
      secondPromise = acquireFairFileLock({
        capacity: 2,
        lockRoot,
        waitIntervalMs: 1,
      });
      const acquisitionTimeout = new AbortController();
      const secondAcquired = await Promise.race([
        secondPromise.then(() => true),
        sleep(1000, undefined, { signal: acquisitionTimeout.signal }).then(
          () => false,
        ),
      ]);
      acquisitionTimeout.abort();
      expect(secondAcquired).toBe(true);
      second = await secondPromise;

      let thirdAcquired = false;
      const thirdPromise = acquireFairFileLock({
        capacity: 2,
        lockRoot,
        onWait: () => thirdWaiting.resolve(),
        waitIntervalMs: 1,
      }).then((lock) => {
        thirdAcquired = true;
        return lock;
      });
      await thirdWaiting.promise;
      expect(thirdAcquired).toBe(false);

      await first.release();
      first = null;
      third = await thirdPromise;
    } finally {
      await first?.release();
      if (!second && secondPromise) {
        second = await secondPromise;
      }
      await second?.release();
      await third?.release();
      await fs.rm(lockRoot, { force: true, recursive: true });
    }
  });

  it("grants a contended single-capacity file lock in FIFO order", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-fair-lock-"),
    );
    const acquisitionOrder: string[] = [];
    const secondWaiting = Promise.withResolvers<void>();
    const thirdWaiting = Promise.withResolvers<void>();

    try {
      const first = await acquireFairFileLock({ lockRoot, waitIntervalMs: 1 });
      acquisitionOrder.push("first");

      const secondPromise = acquireFairFileLock({
        lockRoot,
        onWait: () => secondWaiting.resolve(),
        waitIntervalMs: 1,
      }).then((lock) => {
        acquisitionOrder.push("second");
        return lock;
      });
      await secondWaiting.promise;

      const thirdPromise = acquireFairFileLock({
        lockRoot,
        onWait: () => thirdWaiting.resolve(),
        waitIntervalMs: 1,
      }).then((lock) => {
        acquisitionOrder.push("third");
        return lock;
      });
      await thirdWaiting.promise;

      await first.release();
      const second = await secondPromise;
      expect(acquisitionOrder).toEqual(["first", "second"]);

      await second.release();
      const third = await thirdPromise;
      expect(acquisitionOrder).toEqual(["first", "second", "third"]);
      await third.release();
    } finally {
      await fs.rm(lockRoot, { force: true, recursive: true });
    }
  });

  it("removes an orphaned waiter before granting the next lock", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-orphaned-lock-"),
    );
    const orphanPath = path.join(
      lockRoot,
      "deploy.lock.queue",
      "0000000000000000-orphaned",
    );
    await fs.mkdir(orphanPath, { recursive: true });
    await fs.writeFile(
      path.join(orphanPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
      }),
    );
    const abortController = new AbortController();

    try {
      const lock = await acquireFairFileLock({
        lockRoot,
        onWait: () => abortController.abort(),
        signal: abortController.signal,
        waitIntervalMs: 1,
      });
      await lock.release();
    } finally {
      await fs.rm(lockRoot, { force: true, recursive: true });
    }
  });
});
