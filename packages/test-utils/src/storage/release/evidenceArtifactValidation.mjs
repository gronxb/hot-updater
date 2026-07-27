import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./driverSupport.mjs";
import { evidenceInvariant } from "./evidenceInvariant.mjs";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const validateArtifacts = (
  receipt,
  evidenceDirectory,
  forbiddenPath,
) => {
  evidenceInvariant(
    Array.isArray(receipt.artifacts),
    "receipt-artifacts",
    "Receipt artifacts are invalid.",
  );
  const artifactPaths = receipt.artifacts.map((artifact) => artifact.path);
  evidenceInvariant(
    artifactPaths.join("\u0000") === [...artifactPaths].sort().join("\u0000"),
    "artifact-order",
    "Receipt artifacts are not path-sorted.",
  );
  for (const artifact of receipt.artifacts) {
    evidenceInvariant(
      typeof artifact.path === "string" && HASH_PATTERN.test(artifact.sha256),
      "artifact-schema",
      "Receipt artifact schema is invalid.",
    );
    evidenceInvariant(
      !path.posix.isAbsolute(artifact.path) &&
        path.posix.normalize(artifact.path) === artifact.path &&
        !artifact.path.startsWith("../"),
      `artifact-path:${artifact.path}`,
      `Receipt artifact path is not lexical: ${artifact.path}`,
    );
    const artifactPath = path.resolve(evidenceDirectory, artifact.path);
    evidenceInvariant(
      forbiddenPath === undefined ||
        artifactPath !== path.resolve(forbiddenPath),
      "completion-self-reference",
      "Completion input is self-referential.",
    );
    const expectedPrefix = `artifacts/${String(receipt.task)}/${receipt.phase}/run-${receipt.runOrdinal}/`;
    evidenceInvariant(
      artifact.path.startsWith(expectedPrefix),
      `artifact-location:${artifact.path}`,
      `Receipt artifact is outside its immutable run: ${artifact.path}`,
    );
    evidenceInvariant(
      existsSync(artifactPath) && statSync(artifactPath).isFile(),
      `artifact-missing:${artifact.path}`,
      `Receipt artifact is missing: ${artifact.path}`,
    );
    evidenceInvariant(
      sha256(readFileSync(artifactPath)) === artifact.sha256,
      `artifact-hash:${artifact.path}`,
      `Receipt artifact hash changed: ${artifact.path}`,
    );
  }
};
