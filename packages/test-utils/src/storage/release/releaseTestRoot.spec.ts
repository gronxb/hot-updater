import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  cleanupReleaseTestRoots,
  createReleaseTestRoot,
} from "./releaseTestRoot";

afterEach(cleanupReleaseTestRoots);

it("cleans only temporary roots created by the release test registry", () => {
  // Given an owned release root and a separately owned control root.
  const releaseRoot = createReleaseTestRoot("storage-v2-release-owned-");
  const controlRoot = mkdtempSync(
    path.join(tmpdir(), "storage-v2-release-control-"),
  );

  try {
    // When the release test registry is cleaned.
    cleanupReleaseTestRoots();

    // Then only the registered root is removed.
    expect(existsSync(releaseRoot)).toBe(false);
    expect(existsSync(controlRoot)).toBe(true);
  } finally {
    rmSync(controlRoot, { force: true, recursive: true });
  }
});
