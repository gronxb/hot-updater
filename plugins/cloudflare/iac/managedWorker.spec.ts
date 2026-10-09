import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareWorkerDeployment } from "./managedWorker";

const packageWorker = path.resolve(import.meta.dirname, "..", "worker");

let workerRoot: string;

beforeEach(async () => {
  // The prebuilt Worker as init stages it, from the package's worker directory.
  workerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-worker-"));
  await fs.cp(
    path.join(packageWorker, "wrangler.json"),
    path.join(workerRoot, "wrangler.json"),
  );
  await fs.cp(
    path.join(packageWorker, "migrations"),
    path.join(workerRoot, "migrations"),
    { recursive: true },
  );
});

afterEach(async () => {
  await fs.rm(workerRoot, { recursive: true, force: true });
});

describe("the managed Worker init deploys", () => {
  it("binds the prebuilt Worker to the D1 database and R2 bucket init chose", async () => {
    const packaged = JSON.parse(
      await fs.readFile(path.join(packageWorker, "wrangler.json"), "utf-8"),
    );

    await prepareWorkerDeployment(workerRoot, {
      accountId: "account-id",
      d1DatabaseId: "database-id",
      d1DatabaseName: "ota",
      r2BucketName: "bundles",
    });

    // The bindings the Worker reads, on the package's entry and settings.
    expect(
      JSON.parse(
        await fs.readFile(path.join(workerRoot, "wrangler.json"), "utf-8"),
      ),
    ).toEqual({
      ...packaged,
      d1_databases: [
        { binding: "DB", database_id: "database-id", database_name: "ota" },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "bundles" }],
      vars: { ACCOUNT_ID: "account-id", BUCKET_NAME: "bundles" },
    });
  });
});
