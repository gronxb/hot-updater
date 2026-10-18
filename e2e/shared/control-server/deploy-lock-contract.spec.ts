import fs from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

import { describe, expect, it } from "vitest";

import { acquireFairFileLock, DEPLOY_LOCK_CAPACITY } from "./fair-file-lock.ts";

const repoDir = path.resolve(__dirname, "../../..");
const controllerPath = path.join(
  repoDir,
  "e2e/shared/control-server/controller.ts",
);

describe("E2E control-server deploy lock", () => {
  it("bounds builds across shards with the keyless shared lock, and guards each checkout's inputs with its own", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");
    const between = (from: string, to: string) =>
      controllerSource.slice(
        controllerSource.indexOf(from),
        controllerSource.indexOf(to, controllerSource.indexOf(from)),
      );

    // The shards' shared lock limits builds only: it guards no files.
    const shared = between(
      "async function withDeployProcessLock<T>(",
      "async function exportNativePublicKeyFromSigningKey(",
    );
    expect(shared).toContain("await acquireFairFileLock({");
    expect(shared).toContain("capacity: DEPLOY_LOCK_CAPACITY,");
    expect(shared).toContain("lockRoot: deployProcessLockRoot(),");
    // The inputs lock lives under this checkout's own root.
    const inputs = between(
      "async function withCheckoutInputsLock<T>(",
      "async function withDeployProcessLock<T>(",
    );
    expect(inputs).toContain("return withCheckoutLock(");
    // One holder at a time: withCheckoutLock fixes the capacity at 1.
    expect(inputs).not.toContain("capacity");
    expect(inputs).toContain("lockRoot: checkoutInputsLockRoot(),");
    expect(inputs).not.toContain("deployProcessLockRoot");
    expect(
      between(
        "function checkoutInputsLockRoot(",
        "async function withCheckoutInputsLock<T>(",
      ),
    ).toContain(".update(REPO_DIR)");
    expect(controllerSource).not.toContain(
      "async function acquireDeployProcessLock",
    );
  });

  it("writes a deploy's inputs and builds only while holding its checkout's exclusive lock", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");
    const deploy = controllerSource.slice(
      controllerSource.indexOf("async function deployFixtureBundle("),
      controllerSource.indexOf("async function updateFixtureRelease("),
    );
    const lockIndex = deploy.indexOf("await withCheckoutInputsLock(");

    expect(deploy).toMatch(
      /await withCheckoutInputsLock\(\s*"deploy",\s*signal,\s*async/,
    );
    expect(lockIndex).toBeGreaterThan(0);
    for (const write of [
      "await applyDeployConfig(",
      "await applyAppScenario(",
      "await ensureMultiAssetFixtures(",
      "await ensureSizeAwareLargeAsset(",
      "await ensureAssetHeavyFixtures(",
    ]) {
      expect(deploy.indexOf(write)).toBeGreaterThan(lockIndex);
    }
    // The build runs inside the locked task, in its turn among every
    // shard's builds, after the inputs are written.
    const sharedIndex = deploy.indexOf("return withDeployProcessLock(signal,");
    expect(sharedIndex).toBeGreaterThan(
      deploy.indexOf("await applyAppScenario("),
    );
    expect(deploy.indexOf('runLoggedCommand("node", args')).toBeGreaterThan(
      sharedIndex,
    );
    expect(
      deploy.indexOf("const releaseId = extractDeployReleaseId("),
    ).toBeGreaterThan(deploy.indexOf('runLoggedCommand("node", args'));
    // Each write happens exactly once, inside the lock.
    expect(deploy.split("await applyDeployConfig(")).toHaveLength(2);
    expect(deploy.split("await applyAppScenario(")).toHaveLength(2);
  });

  it("backs up and resets the checkout alone in bootstrap and cleanup", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");
    const between = (from: string, to: string) =>
      controllerSource.slice(
        controllerSource.indexOf(from),
        controllerSource.indexOf(to, controllerSource.indexOf(from)),
      );
    const bootstrap = between(
      "async function bootstrap(",
      "async function captureBuiltInBundleId(",
    );
    const reset = between(
      "async function resetCheckoutInputs(",
      "async function bootstrap(",
    );
    const cleanup = between("async function cleanup(", "function createJob(");

    // Bootstrap reaches the inputs only through the exclusive lock.
    expect(bootstrap).toMatch(
      /await withCheckoutInputsLock\(\s*"bootstrap",\s*signal,\s*resetCheckoutInputs,?\s*\);/,
    );
    for (const write of [
      "backupFile(",
      "restoreFile(",
      "applyAppScenario(",
      "patchEnvRuntimeConfigUrl(",
      "exportNativePublicKeyFromSigningKey(",
      "restoreMultiAssetFixtures(",
      "removeAssetHeavyFixtures(",
    ]) {
      expect(bootstrap).not.toContain(write);
      expect(reset).toContain(write);
    }
    // No checkout write takes the lock again inside the locked task.
    expect(reset).not.toContain("withCheckoutInputsLock(");
    expect(reset).not.toContain("withCheckoutLock(");
    // Neither waits for other shards' builds.
    for (const source of [bootstrap, reset, cleanup]) {
      expect(source).not.toContain("withDeployProcessLock(");
      expect(source).not.toContain("deployProcessLockRoot(");
    }

    const cleanupLock = cleanup.indexOf(
      'await withCheckoutInputsLock("cleanup", undefined,',
    );
    expect(cleanupLock).toBeGreaterThan(0);
    for (const write of [
      "restoreFile(",
      "restoreMultiAssetFixtures(",
      "removeAssetHeavyFixtures(",
    ]) {
      expect(cleanup.indexOf(write)).toBeGreaterThan(cleanupLock);
    }
    // Bootstrap is its own job, never a step of a deploy.
    expect(
      between(
        "async function deployFixtureBundle(",
        "async function updateFixtureRelease(",
      ),
    ).not.toContain("bootstrap(");
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
        capacity: DEPLOY_LOCK_CAPACITY,
        lockRoot,
        waitIntervalMs: 1,
      });
      secondPromise = acquireFairFileLock({
        capacity: DEPLOY_LOCK_CAPACITY,
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
        capacity: DEPLOY_LOCK_CAPACITY,
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
