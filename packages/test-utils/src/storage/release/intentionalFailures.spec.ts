import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { storageConformanceAssertions } from "../conformanceAssertions";
import {
  createMemoryStoragePlugin,
  storageTestContext,
} from "../memoryStorage";
import { registerIntentionalCompletionCases } from "./intentionalCompletionCases";
import { registerIntentionalEvidenceCases } from "./intentionalEvidenceCases";
import {
  cleanupReleaseTestRoots,
  createReleaseTestRoot,
} from "./releaseTestRoot";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const driver = path.join(workspace, "scripts/verify-storage-v2.mjs");
const finalSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: workspace,
  encoding: "utf8",
}).trim();

const run = (root: string, arguments_: readonly string[], label: string) =>
  spawnSync(
    process.execPath,
    [driver, ...arguments_, "--output", path.join(root, `${label}.json`)],
    { cwd: workspace, encoding: "utf8" },
  );

const expectFailure = (
  root: string,
  arguments_: readonly string[],
  label: string,
): void => {
  expect(run(root, arguments_, label).status).not.toBe(0);
};

const expectScopeFixtureFailure = (
  fixtureName: string,
  label: string,
  expectedError: string,
): void => {
  const root = createReleaseTestRoot("storage-v2-scope-fail-");
  const result = run(
    root,
    [
      "--mode",
      "scope",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--fixture",
      path.join(
        workspace,
        "packages/test-utils/src/storage/release/fixtures",
        fixtureName,
      ),
    ],
    label,
  );
  const receipt = JSON.parse(
    readFileSync(path.join(root, `${label}.json`), "utf8"),
  );
  expect(result.status).not.toBe(0);
  expect(receipt.verdict).toBe("failed");
  expect(receipt.details.error).toBe(expectedError);
};

describe("Storage v2 release intentional failures", () => {
  afterEach(cleanupReleaseTestRoots);

  it("detects a first-request context cache", async () => {
    const observed: string[] = [];
    const contexts = ["A1", "B", "A2"].map((requestId) =>
      Object.freeze({
        target: "node" as const,
        environment: Object.freeze({ REQUEST_ID: requestId }),
        bindings: Object.freeze({}),
      }),
    );
    const plugin = createMemoryStoragePlugin();
    const cached = contexts[0];
    if (cached === undefined) {
      throw new TypeError("Context fixture is empty.");
    }
    for (const [index, context] of contexts.entries()) {
      const result = await plugin.put({
        context: cached,
        key: `cache/${index}`,
        body: new Uint8Array([index]),
        contentLength: 1,
      });
      observed.push(cached.environment.REQUEST_ID ?? "");
      expect(result.kind).toBe("stored");
      expect(context.environment.REQUEST_ID).toBeDefined();
    }
    expect(observed).not.toEqual(["A1", "B", "A2"]);
  });

  it("detects double close", async () => {
    const plugin = createMemoryStoragePlugin();
    const broken = {
      ...plugin,
      async onUnmount() {
        await plugin.onUnmount?.();
      },
    };
    await expect(
      storageConformanceAssertions.unmountIsIdempotent(
        broken,
        storageTestContext,
      ),
    ).rejects.toMatchObject({
      name: "StorageConformanceError",
      assertion: "unmount-is-idempotent",
    });
  });

  it.each([
    ["flip-create-only", "matrix-flipped.json"],
    ["wrong-target", "matrix-wrong-target.json"],
  ])("rejects the %s matrix mutation", (label, fixtureName) => {
    const root = createReleaseTestRoot("storage-v2-matrix-fail-");
    expectFailure(
      root,
      [
        "--mode",
        "matrix",
        "--fixture",
        path.join(
          workspace,
          "packages/test-utils/src/storage/release/fixtures",
          fixtureName,
        ),
      ],
      label,
    );
  });

  it("rejects a forbidden simulated path", () => {
    const root = createReleaseTestRoot("storage-v2-scope-fail-");
    expectFailure(
      root,
      [
        "--mode",
        "scope",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--simulate-path",
        "packages/console/src/index.ts",
      ],
      "forbidden-path",
    );
  });

  it("rejects non-ancestor remote branch", () => {
    expectScopeFixtureFailure(
      "scope-non-ancestor-remote.json",
      "non-ancestor-remote",
      "Remote storage branch is not an ancestor of local HEAD.",
    );
  });

  it("rejects mismatched PR base", () => {
    expectScopeFixtureFailure(
      "scope-mismatched-pr-base.json",
      "mismatched-pr-base",
      "PR base branch does not match.",
    );
  });

  it("rejects duplicate open PRs", () => {
    expectScopeFixtureFailure(
      "scope-duplicate-open-prs.json",
      "duplicate-open-prs",
      "More than one open PR exists for the storage branch.",
    );
  });

  it("rejects local and remote head divergence", () => {
    expectScopeFixtureFailure(
      "scope-diverged-head.json",
      "diverged-head",
      "PR head SHA does not match.",
    );
  });

  it("rejects failed required checks", () => {
    expectScopeFixtureFailure(
      "scope-failed-required-checks.json",
      "failed-required-checks",
      "PR checks are incomplete or failed.",
    );
  });

  registerIntentionalEvidenceCases({ driver, finalSha, workspace });
  registerIntentionalCompletionCases({ driver, finalSha, workspace });
});
