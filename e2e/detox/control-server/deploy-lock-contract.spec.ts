import fs from "fs/promises";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import { acquireFairFileLock } from "./fair-file-lock.ts";

const repoDir = path.resolve(__dirname, "../../..");
const controllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);

describe("Detox control-server deploy lock", () => {
  it("routes deploy mutations through the fair file lock", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).toContain(
      'import { acquireFairFileLock } from "./fair-file-lock.ts";',
    );
    expect(controllerSource).toContain(
      "const deployProcessLock = await acquireFairFileLock({",
    );
    expect(controllerSource).not.toContain(
      "async function acquireDeployProcessLock",
    );
  });

  it("grants a contended file lock in FIFO order", async () => {
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
