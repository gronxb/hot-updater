import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const driver = path.join(workspace, "scripts/verify-storage-v2.mjs");

it("keeps manual-QA tarballs available for independent hashing after cleanup", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-manual-qa-"));
  const output = path.join(directory, "manual-qa.json");
  const result = spawnSync(
    process.execPath,
    [driver, "--mode", "manual-qa", "--output", output],
    {
      cwd: workspace,
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt).toMatchObject({ mode: "manual-qa", verdict: "passed" });
  const tarballs = Object.values(
    receipt.details.tarballs as Record<
      string,
      { readonly path: string; readonly sha256: string }
    >,
  );
  expect(tarballs).toHaveLength(10);
  expect(new Set(tarballs.map((tarball) => tarball.path)).size).toBe(10);
  for (const tarball of tarballs) {
    expect(tarball.path.startsWith(`${output}.tarballs${path.sep}`)).toBe(true);
    const hash = createHash("sha256")
      .update(readFileSync(tarball.path))
      .digest("hex");
    expect(hash).toBe(tarball.sha256);
  }
  expect(receipt.details.cleanup).toBe(true);
  expect(receipt.details.openHandles).toBe(false);
  expect(
    (receipt.details.consumers as readonly string[]).every(
      (consumer) => !existsSync(consumer),
    ),
  ).toBe(true);
}, 180_000);
