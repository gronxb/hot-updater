import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { storageConformanceAssertions } from "../conformanceAssertions";
import {
  createMemoryStoragePlugin,
  storageTestContext,
} from "../memoryStorage";
import { registerIntentionalCompletionCases } from "./intentionalCompletionCases";
import { registerIntentionalEvidenceCases } from "./intentionalEvidenceCases";

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

describe("Storage v2 release intentional failures", () => {
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
    const root = mkdtempSync(path.join(tmpdir(), "storage-v2-matrix-fail-"));
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
    const root = mkdtempSync(path.join(tmpdir(), "storage-v2-scope-fail-"));
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

  registerIntentionalEvidenceCases({ driver, finalSha, workspace });
  registerIntentionalCompletionCases({ driver, finalSha, workspace });
});
