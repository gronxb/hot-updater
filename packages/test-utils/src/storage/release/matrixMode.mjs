import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { invariant, readJson, runCommand, sha256 } from "./driverSupport.mjs";

const CANONICAL_CELL_COUNT = 12;
const MATRIX_SPECS = [
  "packages/test-utils/src/storage/capabilityMatrix.spec.ts",
  "e2e/storage-v2-certification/contextMatrix.spec.ts",
  "e2e/storage-v2-certification/providerBackedMatrix.spec.ts",
];

const PROVIDERS = [
  "mock",
  "aws",
  "cloudflare",
  "firebase",
  "supabase",
  "standalone",
];

const isStorageSpec = (entry) => /storage.*\.spec\.ts$/i.test(entry);

const discoverSourceSpecs = (sourceRoot) => {
  const specs = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") {
          continue;
        }
        visit(entryPath);
      } else if (entry.isFile() && isStorageSpec(entry.name)) {
        specs.push(entryPath);
      }
    }
  };
  visit(sourceRoot);
  return specs;
};

export const discoverProviderSpecs = (workspace) =>
  PROVIDERS.flatMap((provider) =>
    discoverSourceSpecs(path.join(workspace, "plugins", provider, "src")),
  )
    .map((spec) => path.relative(workspace, spec))
    .sort((left, right) => left.localeCompare(right));

const readTestFixture = (workspace, fixture) => {
  const fixtureDirectory = path.join(
    workspace,
    "packages/test-utils/src/storage/release/fixtures",
  );
  const fixturePath = path.resolve(workspace, fixture);
  invariant(
    fixturePath.startsWith(`${fixtureDirectory}${path.sep}`),
    "Matrix fixtures are test-only and must live in the release fixture directory.",
  );
  const fixtureInput = readJson(fixturePath);
  invariant(
    fixtureInput.schema === "hot-updater.storage-v2-matrix-fixture/v1",
    "Matrix fixture schema is invalid.",
  );
  invariant(
    ["none", "flip-create-only", "wrong-target"].includes(
      fixtureInput.mutation,
    ),
    "Matrix fixture mutation is invalid.",
  );
  return { fixtureInput, fixturePath };
};

const readCanonicalMatrix = (workspace) => {
  const matrixPath = path.join(
    workspace,
    "packages/test-utils/src/storage/release/fixtures/provider-matrix.json",
  );
  const serializedMatrix = readFileSync(matrixPath, "utf8");
  return {
    matrixPath,
    matrix: JSON.parse(serializedMatrix),
    canonicalMatrixSha256: sha256(serializedMatrix),
  };
};

const validateMatrixCells = (cells) => {
  invariant(Array.isArray(cells), "Matrix cells must be an array.");
  invariant(
    cells.length === CANONICAL_CELL_COUNT,
    "Matrix entry count is invalid.",
  );
  for (const [index, cell] of cells.entries()) {
    invariant(
      cell !== null && typeof cell === "object",
      `Matrix cell ${index} is invalid.`,
    );
    invariant(typeof cell.id === "string", `Matrix cell ${index} has no id.`);
    invariant(
      typeof cell.entry === "string",
      `Matrix cell ${index} has no entry.`,
    );
    invariant(
      Array.isArray(cell.acceptedTargets),
      `Matrix target ${index} is invalid.`,
    );
    invariant(
      cell.acceptedTargets.includes(cell.target),
      `Matrix target ${index} changed.`,
    );
    invariant(
      cell.contractVersion === 2,
      `${cell.entry} contract version changed.`,
    );
    invariant(
      cell.createOnly === true,
      `${cell.entry} lost create-only support.`,
    );
    invariant(cell.range === true, `${cell.entry} lost range support.`);
    invariant(
      ["supported", "unsupported"].includes(cell.delivery),
      `${cell.entry} delivery claim is invalid.`,
    );
    invariant(
      ["supported", "unsupported"].includes(cell.list),
      `${cell.entry} list claim is invalid.`,
    );
  }
};

export const runMatrixMode = ({ workspace, fixture }) => {
  const { canonicalMatrixSha256, matrix, matrixPath } =
    readCanonicalMatrix(workspace);
  const testFixture =
    fixture === undefined ? undefined : readTestFixture(workspace, fixture);
  invariant(
    matrix.schema === "hot-updater.storage-v2-provider-matrix/v1",
    "Matrix schema is invalid.",
  );
  validateMatrixCells(matrix.cells);
  const fixtureInput = testFixture?.fixtureInput ?? { mutation: "none" };
  const cells = matrix.cells.map((cell, index) =>
    fixtureInput.mutation === "flip-create-only" && index === 0
      ? { ...cell, createOnly: false }
      : fixtureInput.mutation === "wrong-target" && index === 1
        ? { ...cell, acceptedTargets: ["worker"] }
        : cell,
  );
  validateMatrixCells(cells);

  const command =
    testFixture === undefined
      ? runCommand(
          [
            "pnpm",
            "--dir",
            "packages/test-utils",
            "exec",
            "vitest",
            "run",
            "--no-file-parallelism",
            "--root",
            "../..",
            ...MATRIX_SPECS,
            ...discoverProviderSpecs(workspace),
          ],
          workspace,
        )
      : {
          argv: ["test-fixture", testFixture.fixturePath],
          exitCode: 0,
          stdoutSha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          stderrSha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          stdout: "",
          stderr: "",
        };
  invariant(command.exitCode === 0, "The Storage v2 matrix command failed.");
  return {
    commands: [command],
    details: {
      matrixPath: path.relative(workspace, matrixPath),
      cellCount: cells.length,
      canonicalMatrixSha256,
    },
  };
};
