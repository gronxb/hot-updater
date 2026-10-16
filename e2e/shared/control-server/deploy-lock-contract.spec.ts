import fs from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

import { describe, expect, it } from "vitest";

import {
  acquireFairFileLock,
  canEnterFairFileLock,
  DEPLOY_LOCK_CAPACITY,
} from "./fair-file-lock.ts";

const repoDir = path.resolve(__dirname, "../../..");
const controllerPath = path.join(
  repoDir,
  "e2e/shared/control-server/controller.ts",
);

describe("E2E control-server deploy lock", () => {
  it("routes deploys through the bounded fair file lock", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).toContain('from "./checkout-lock.ts";');
    expect(controllerSource).toContain("return withCheckoutLock(");
    expect(controllerSource).toContain("capacity: DEPLOY_LOCK_CAPACITY,");
    // Every checkout holder goes through the one helper, with its key; the
    // Remote Config lock is a separate lock root.
    expect(controllerSource).not.toContain("const deployProcessLock =");
    expect(controllerSource).not.toContain(
      "async function acquireDeployProcessLock",
    );
  });

  it("writes a deploy's inputs only while holding the lock keyed by them", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");
    const deploy = controllerSource.slice(
      controllerSource.indexOf("async function deployFixtureBundle("),
      controllerSource.indexOf("async function updateFixtureRelease("),
    );
    const lockIndex = deploy.indexOf("await withDeployProcessLock(");

    expect(deploy).toContain('"deploy",\n    deployInputs.key,');
    expect(lockIndex).toBeGreaterThan(0);
    for (const write of [
      "await writeDeployConfig(",
      "await writeAppScenario(",
      "await ensureMultiAssetFixtures(",
      "await ensureSizeAwareLargeAsset(",
      "await ensureAssetHeavyFixtures(",
    ]) {
      expect(deploy.indexOf(write)).toBeGreaterThan(lockIndex);
    }
    // The build runs inside the locked task.
    expect(deploy.indexOf('runLoggedCommand("node", args')).toBeGreaterThan(
      lockIndex,
    );
    expect(
      deploy.indexOf("const releaseId = extractDeployReleaseId("),
    ).toBeGreaterThan(deploy.indexOf('runLoggedCommand("node", args'));
    expect(deploy).not.toContain("applyDeployConfig(");
    expect(deploy).not.toContain("applyAppScenario(");
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
      /await withDeployProcessLock\(\s*"bootstrap",\s*exclusiveCheckoutLockKey\(\),\s*signal,\s*resetCheckoutInputs,\s*\);/,
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
    expect(reset).not.toContain("withDeployProcessLock(");
    expect(reset).not.toContain("withCheckoutLock(");

    const cleanupLock = cleanup.indexOf(
      'await withDeployProcessLock(\n    "cleanup",\n    exclusiveCheckoutLockKey(),',
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

  it("admits a waiter only behind and beside holders with its key", () => {
    const enter = (
      overrides: Partial<Parameters<typeof canEnterFairFileLock>[0]>,
    ) =>
      canEnterFairFileLock({
        aheadKeys: [],
        capacity: 2,
        heldKeys: [],
        key: "main",
        position: 0,
        ...overrides,
      });

    expect(enter({})).toBe(true);
    // The same inputs share the checkout up to capacity.
    expect(enter({ heldKeys: ["main"] })).toBe(true);
    expect(enter({ aheadKeys: ["main"], position: 1 })).toBe(true);
    expect(enter({ aheadKeys: ["main", "main"], position: 2 })).toBe(false);
    // Other inputs wait for every holder to release.
    expect(enter({ heldKeys: ["widget"] })).toBe(false);
    expect(enter({ heldKeys: ["main", "widget"] })).toBe(false);
    // Nobody passes a waiter with other inputs.
    expect(enter({ aheadKeys: ["widget"], position: 1 })).toBe(false);
    // An owner not written yet, or unreadable, counts as other inputs.
    expect(enter({ heldKeys: [undefined] })).toBe(false);
    expect(enter({ aheadKeys: [undefined], position: 1 })).toBe(false);
    // Keyless holders still share with each other, as before keys.
    expect(enter({ heldKeys: [null], key: null })).toBe(true);
    expect(enter({ heldKeys: [null] })).toBe(false);
  });

  it("builds equal deploys at once and makes a different one take its turn", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-keyed-lock-"),
    );
    const order: string[] = [];
    const widgetWaiting = Promise.withResolvers<void>();
    const lateMainWaiting = Promise.withResolvers<void>();
    const acquire = (key: string, onWait?: () => void) =>
      acquireFairFileLock({
        capacity: DEPLOY_LOCK_CAPACITY,
        key,
        lockRoot,
        onWait,
        waitIntervalMs: 1,
      }).then((lock) => {
        order.push(key);
        return lock;
      });

    try {
      // iOS and Android shards building the same bundle hold it together.
      const [mainIos, mainAndroid] = await Promise.all([
        acquire("main"),
        acquire("main"),
      ]);
      const widgetPromise = acquire("widget", () => widgetWaiting.resolve());
      await widgetWaiting.promise;
      // A main deploy queued behind the widget does not pass it.
      const lateMainPromise = acquire("main", () => lateMainWaiting.resolve());
      await lateMainWaiting.promise;

      await mainIos.release();
      await sleep(20);
      expect(order).toEqual(["main", "main"]);

      await mainAndroid.release();
      const widget = await widgetPromise;
      await sleep(20);
      expect(order).toEqual(["main", "main", "widget"]);

      await widget.release();
      const lateMain = await lateMainPromise;
      expect(order).toEqual(["main", "main", "widget", "main"]);
      await lateMain.release();
    } finally {
      await fs.rm(lockRoot, { force: true, recursive: true });
    }
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
