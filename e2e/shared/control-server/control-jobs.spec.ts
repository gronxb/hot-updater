import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createControlJobs } from "./control-jobs.ts";
import { acquireFairFileLock } from "./fair-file-lock.ts";

async function flushJob() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("control job cancellation", () => {
  it("keeps cancelled remote work running until its delayed mutation settles", async () => {
    const registry = createControlJobs();
    const mutation = Promise.withResolvers<Record<string, unknown>>();
    let remoteMutationFinished = false;
    const jobId = registry.start(async () => {
      const result = await mutation.promise;
      remoteMutationFinished = true;
      return result;
    });
    await flushJob();

    expect(registry.cancel(jobId)).toEqual({ status: "running" });
    expect(registry.get(jobId)).toEqual({ status: "running" });
    expect(remoteMutationFinished).toBe(false);

    mutation.resolve({ releaseId: "late-release" });
    await flushJob();
    expect(remoteMutationFinished).toBe(true);
    expect(registry.get(jobId)).toEqual({
      status: "cancelled",
      quiescent: true,
    });
  });

  it("does not start a queued task cancelled before dispatch", async () => {
    const registry = createControlJobs();
    let mutations = 0;
    const jobId = registry.start(async () => {
      mutations += 1;
      return {};
    });
    registry.cancel(jobId);
    await flushJob();
    expect(mutations).toBe(0);
    expect(registry.get(jobId)).toMatchObject({
      status: "cancelled",
      quiescent: true,
    });
  });

  it("preserves uncertainty when killing a deploy cannot disprove a remote mutation", async () => {
    const registry = createControlJobs();
    const stopped = Promise.withResolvers<Record<string, unknown>>();
    const jobId = registry.start(
      async ({ signal, markQuiescenceUncertain }) => {
        signal.addEventListener(
          "abort",
          () => {
            markQuiescenceUncertain();
            stopped.reject(new Error("deploy process killed"));
          },
          { once: true },
        );
        return stopped.promise;
      },
    );
    await flushJob();
    registry.cancel(jobId);
    await flushJob();
    expect(registry.get(jobId)).toMatchObject({
      status: "cancelled",
      quiescent: false,
    });
  });
  it("removes a cancelled deployment waiting for the shared deploy lock", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "control-job-cancel-"),
    );
    const owner = await acquireFairFileLock({ lockRoot });
    const queued = Promise.withResolvers<void>();
    const registry = createControlJobs();
    let mutations = 0;
    const jobId = registry.start(async ({ signal }) => {
      const lock = await acquireFairFileLock({
        lockRoot,
        signal,
        waitIntervalMs: 1,
        onWait: () => queued.resolve(),
      });
      try {
        mutations += 1;
        return {};
      } finally {
        await lock.release();
      }
    });
    try {
      await queued.promise;
      registry.cancel(jobId);
      await expect
        .poll(() => registry.get(jobId))
        .toMatchObject({
          status: "cancelled",
          quiescent: true,
        });
      await owner.release();
      const next = await acquireFairFileLock({ lockRoot, waitIntervalMs: 1 });
      await next.release();
      expect(mutations).toBe(0);
    } finally {
      await owner.release();
      await fs.rm(lockRoot, { force: true, recursive: true });
    }
  });

  it("does not certify a rejected remote mutation whose response may have been lost", async () => {
    const registry = createControlJobs();
    const response = Promise.withResolvers<Record<string, unknown>>();
    const jobId = registry.start(() => response.promise);
    await flushJob();
    registry.cancel(jobId);
    response.reject(new Error("connection lost after remote acceptance"));
    await flushJob();
    expect(registry.get(jobId)).toMatchObject({
      status: "cancelled",
      quiescent: false,
    });
  });
});
