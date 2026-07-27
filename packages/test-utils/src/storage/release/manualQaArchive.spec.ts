import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  archiveManualQaTarballs,
  handoffManualQaArchiveRoot,
} from "./manualQaArchive.mjs";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const driver = path.join(workspace, "scripts/verify-storage-v2.mjs");

const makeSealedFixtureWritable = (root: string): void => {
  const archiveDirectory = path.join(root, "manual-qa.json.tarballs");
  if (!existsSync(archiveDirectory)) {
    return;
  }
  chmodSync(archiveDirectory, 0o755);
  for (const archive of readdirSync(archiveDirectory)) {
    chmodSync(path.join(archiveDirectory, archive), 0o644);
  }
};

it("atomically hands off a sealed manual-QA root and refuses collisions", () => {
  const owner = mkdtempSync(path.join(tmpdir(), "storage-v2-handoff-test-"));
  const source = path.join(owner, "source");
  const input = path.join(owner, "input.tgz");
  const destination = path.join(owner, "durable");
  const archiveDirectory = path.join(source, "manual-qa.json.tarballs");
  mkdirSync(source);
  chmodSync(source, 0o700);
  writeFileSync(input, "sealed archive");
  archiveManualQaTarballs({
    archiveDirectory,
    tarballs: new Map([["fixture", input]]),
  });
  const archived = path.join(archiveDirectory, "input.tgz");
  const beforeHash = createHash("sha256")
    .update(readFileSync(archived))
    .digest("hex");
  const beforeModes = {
    root: statSync(source).mode & 0o777,
    archive: statSync(archiveDirectory).mode & 0o777,
    file: statSync(archived).mode & 0o777,
  };

  try {
    handoffManualQaArchiveRoot({
      sourceRoot: source,
      destinationRoot: destination,
    });

    expect(existsSync(source)).toBe(false);
    expect(existsSync(destination)).toBe(true);
    const handedOffArchive = path.join(
      destination,
      "manual-qa.json.tarballs",
      "input.tgz",
    );
    expect(
      createHash("sha256").update(readFileSync(handedOffArchive)).digest("hex"),
    ).toBe(beforeHash);
    expect({
      root: statSync(destination).mode & 0o777,
      archive:
        statSync(path.join(destination, "manual-qa.json.tarballs")).mode &
        0o777,
      file: statSync(handedOffArchive).mode & 0o777,
    }).toEqual(beforeModes);

    const collisionSource = path.join(owner, "collision-source");
    mkdirSync(collisionSource);
    expect(() =>
      handoffManualQaArchiveRoot({
        sourceRoot: collisionSource,
        destinationRoot: destination,
      }),
    ).toThrow("already exists");
    expect(existsSync(collisionSource)).toBe(true);
  } finally {
    makeSealedFixtureWritable(source);
    makeSealedFixtureWritable(destination);
    rmSync(owner, { force: true, recursive: true });
  }
});

it("keeps manual-QA tarballs available for independent hashing after cleanup", () => {
  const owner = mkdtempSync(path.join(tmpdir(), "storage-v2-manual-qa-"));
  const source = path.join(owner, "source");
  mkdirSync(source);
  const output = path.join(source, "manual-qa.json");
  const requestedDestination =
    process.env.STORAGE_V2_MANUAL_QA_ARCHIVE_DESTINATION;
  const destination =
    requestedDestination === undefined
      ? path.join(owner, "durable")
      : path.resolve(requestedDestination);
  const receiptOutput = path.join(destination, "manual-qa.json");

  try {
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--mode",
        "manual-qa",
        "--output",
        output,
        "--archive-destination",
        destination,
      ],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(source)).toBe(false);
    const receipt = JSON.parse(readFileSync(receiptOutput, "utf8"));
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
      expect(
        tarball.path.startsWith(
          `${path.join(destination, "manual-qa.json.tarballs")}${path.sep}`,
        ),
      ).toBe(true);
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
  } finally {
    makeSealedFixtureWritable(source);
    if (requestedDestination === undefined) {
      makeSealedFixtureWritable(destination);
    }
    rmSync(owner, { force: true, recursive: true });
  }
}, 180_000);
