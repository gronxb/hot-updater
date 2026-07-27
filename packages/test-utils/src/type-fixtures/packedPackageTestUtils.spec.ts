import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createPackedConsumer } from "./packedPackageTestUtils";

const findConsumerRootsForSource = async (
  sourceDirectory: string,
): Promise<readonly string[]> => {
  const sourceName = path.basename(sourceDirectory);
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("hot-updater-server-plugins-pack-"),
    )
    .map((entry) => path.join(os.tmpdir(), entry.name));
  const matches = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(path.join(candidate, "packs", sourceName));
        return candidate;
      } catch {
        return undefined;
      }
    }),
  );
  return matches.filter((candidate) => candidate !== undefined);
};

it("removes its exact temporary root when packing fails", async () => {
  const sourceDirectory = await mkdtemp(
    path.join(os.tmpdir(), "packed-consumer-failure-source-"),
  );
  await writeFile(path.join(sourceDirectory, "package.json"), "{");

  try {
    let observed: Error | undefined;
    try {
      await createPackedConsumer([sourceDirectory]);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      observed = error;
    }
    if (!(observed instanceof Error)) {
      throw new TypeError("Expected the original pnpm pack error.");
    }
    expect(observed.message).toContain("pnpm pack");
    expect(await findConsumerRootsForSource(sourceDirectory)).toEqual([]);
  } finally {
    await Promise.all(
      (await findConsumerRootsForSource(sourceDirectory)).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
    await rm(sourceDirectory, { force: true, recursive: true });
  }
});
