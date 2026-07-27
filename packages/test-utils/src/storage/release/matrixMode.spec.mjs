import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverProviderSpecs, runMatrixMode } from "./matrixMode.mjs";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const driver = path.join(workspace, "scripts/verify-storage-v2.mjs");

const providerNames = [
  "mock",
  "aws",
  "cloudflare",
  "firebase",
  "supabase",
  "standalone",
];

const createWorkspace = () => {
  const root = mkdtempSync(path.join(tmpdir(), "storage-v2-matrix-discovery-"));
  for (const provider of providerNames) {
    mkdirSync(path.join(root, "plugins", provider, "src"), {
      recursive: true,
    });
  }
  return root;
};

const writeSourceFile = (root, relativePath) => {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "export {};\n");
};

describe("Storage v2 matrix spec discovery", () => {
  it("writes a 12-cell default receipt bound to the canonical matrix", () => {
    const root = mkdtempSync(path.join(tmpdir(), "storage-v2-matrix-receipt-"));
    const output = path.join(root, "matrix.json");
    const canonicalHash = path.join(root, "canonical-matrix.sha256");
    try {
      const command = spawnSync(
        process.execPath,
        [driver, "--mode", "matrix", "--output", output],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, STORAGE_MATRIX_HASH_PATH: canonicalHash },
        },
      );

      expect(command.status).toBe(0);
      const receipt = JSON.parse(readFileSync(output, "utf8"));
      expect(receipt.details).toMatchObject({
        cellCount: 12,
        canonicalMatrixSha256: readFileSync(canonicalHash, "utf8").trim(),
      });
      expect(receipt.commands[0].argv).not.toContain("--fixture");
      expect(receipt.commands[0].argv).toContain("--no-file-parallelism");
      expect(receipt.commands[0].argv.join(" ")).not.toContain(
        "matrix-happy.json",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 180_000);

  it("is bounded to provider source trees", () => {
    const specs = discoverProviderSpecs(workspace);

    expect(specs.length).toBeGreaterThan(10);
    expect(specs.every((spec) => spec.includes("/src/"))).toBe(true);
    expect(specs.every((spec) => !spec.includes("node_modules"))).toBe(true);
  });

  it("recursively finds case-insensitive storage specs without dependencies", () => {
    const root = createWorkspace();
    try {
      const expected = [
        "plugins/aws/src/MixedStorageV2.spec.ts",
        "plugins/cloudflare/src/storage/node/storage.spec.ts",
        "plugins/cloudflare/src/storage/worker/storage.spec.ts",
        "plugins/mock/src/storage/storage.spec.ts",
      ];
      for (const spec of expected) {
        writeSourceFile(root, spec);
      }
      writeSourceFile(
        root,
        "plugins/cloudflare/src/node_modules/ignoredStorage.spec.ts",
      );
      writeSourceFile(
        root,
        "plugins/cloudflare/src/dist/ignoredStorage.spec.ts",
      );
      const external = path.join(root, "external-dependency");
      writeSourceFile(root, "external-dependency/linkedStorage.spec.ts");
      symlinkSync(
        external,
        path.join(root, "plugins/mock/src/storage/dependency-link"),
        "dir",
      );

      expect(discoverProviderSpecs(root)).toEqual(expected);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("parses and rejects malformed test-only fixture input", () => {
    const root = createWorkspace();
    try {
      const fixtureDirectory = path.join(
        root,
        "packages/test-utils/src/storage/release/fixtures",
      );
      mkdirSync(fixtureDirectory, { recursive: true });
      writeFileSync(
        path.join(fixtureDirectory, "provider-matrix.json"),
        readFileSync(
          path.join(
            workspace,
            "packages/test-utils/src/storage/release/fixtures/provider-matrix.json",
          ),
        ),
      );
      writeFileSync(path.join(fixtureDirectory, "malformed.json"), "{");

      expect(() =>
        runMatrixMode({
          workspace: root,
          fixture:
            "packages/test-utils/src/storage/release/fixtures/malformed.json",
        }),
      ).toThrow(SyntaxError);
      writeFileSync(path.join(root, "outside-fixture.json"), "{}");
      expect(() =>
        runMatrixMode({
          workspace: root,
          fixture: "outside-fixture.json",
        }),
      ).toThrow("Matrix fixtures are test-only");
      writeFileSync(
        path.join(fixtureDirectory, "provider-matrix.json"),
        JSON.stringify({ schema: "wrong-schema", cells: [] }),
      );
      expect(() => runMatrixMode({ workspace: root })).toThrow(
        "Matrix schema is invalid.",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
