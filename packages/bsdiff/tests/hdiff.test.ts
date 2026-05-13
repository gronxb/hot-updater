import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { type HdiffError, hdiff } from "../src/index.js";
import {
  applyBspatch,
  equalsBytes,
  readFixtureHbc,
  readLargeFixtureHbc,
  toDeltaMagic,
  withFileLength,
  withVersion,
} from "./test-helpers.js";

describe("hdiff", () => {
  it("generates a BSPATCH-compatible ENDSLEY BSDIFF43 patch for fixture one -> two", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");

    const patch = await hdiff(base, next);
    const restored = await applyBspatch(base, patch);

    expect(patch.byteLength).toBeGreaterThan(0);
    expect(equalsBytes(restored, next)).toBe(true);
  });

  it("rejects invalid hbc input", async () => {
    const invalid = new Uint8Array([1, 2, 3, 4, 5]);
    const next = await readFixtureHbc("two");

    await expect(hdiff(invalid, next)).rejects.toMatchObject({
      name: "HdiffError",
      code: "INVALID_HBC",
    } satisfies Partial<HdiffError>);
  });

  it("rejects delta-form hbc input", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");
    const deltaBase = toDeltaMagic(base);

    await expect(hdiff(deltaBase, next)).rejects.toMatchObject({
      name: "HdiffError",
      code: "NON_EXECUTION_FORM",
    } satisfies Partial<HdiffError>);
  });

  it("rejects mismatched bytecode versions", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");
    const mismatched = withVersion(next, 0x7fff_fffe);

    await expect(hdiff(base, mismatched)).rejects.toMatchObject({
      name: "HdiffError",
      code: "BYTECODE_VERSION_MISMATCH",
    } satisfies Partial<HdiffError>);
  });

  it("rejects header fileLength mismatch", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");
    const invalidLength = withFileLength(base, base.byteLength + 1);

    await expect(hdiff(invalidLength, next)).rejects.toMatchObject({
      name: "HdiffError",
      code: "INVALID_HBC",
    } satisfies Partial<HdiffError>);
  });

  it("accepts Buffer and ArrayBuffer inputs", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");

    const baseBuffer = Buffer.from(base);
    const nextArrayBuffer = next.buffer.slice(
      next.byteOffset,
      next.byteOffset + next.byteLength,
    );

    const patch = await hdiff(baseBuffer, nextArrayBuffer);
    const restored = await applyBspatch(base, patch);

    expect(patch.byteLength).toBeGreaterThan(0);
    expect(equalsBytes(restored, next)).toBe(true);
  });

  it("restores the target bytes from base plus patch with fileHash integrity", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");

    const patch = await hdiff(base, next);
    const restored = await applyBspatch(base, patch);

    const baseFileHash = sha256(base);
    const targetFileHash = sha256(next);
    const restoredFileHash = sha256(restored);
    const patchFileHash = sha256(patch);

    expect(baseFileHash).not.toBe(targetFileHash);
    expect(patchFileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(restoredFileHash).toBe(targetFileHash);
  });

  it.each(["android", "ios"] as const)(
    "applies a large %s patch from the v0.85.0 fixture and preserves target fileHash integrity",
    async (platform) => {
      const base = await readLargeFixtureHbc(platform, "base");
      const next = await readLargeFixtureHbc(platform, "target");

      const patch = await hdiff(base, next);
      const restored = await applyBspatch(base, patch);

      expect(next.byteLength).toBeGreaterThan(base.byteLength);
      expect(patch.byteLength).toBeGreaterThan(1024 * 1024);
      expect(sha256(restored)).toBe(sha256(next));
    },
  );

  it("produces deterministic patch bytes for the same input pair", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");

    const patchA = await hdiff(base, next);
    const patchB = await hdiff(base, next);

    expect(equalsBytes(patchA, patchB)).toBe(true);
  });
});

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
