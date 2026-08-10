import fs from "node:fs/promises";
import path from "node:path";

import { copyDirToTmp } from "@hot-updater/cli-tools";
import type { UniversalComponentArtifact } from "@hot-updater/plugin-core";

import { mergeFirebaseComponentIndexArtifacts } from "../src/firebaseComponentIndexArtifacts";

const ensureExists = async (targetPath: string, description: string) => {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`Missing Firebase ${description} at ${targetPath}`);
  }
};

const normalizeFunctionsPackage = async (functionsDir: string) => {
  const templatePackagePath = path.join(functionsDir, "_package.json");
  const packageJsonPath = path.join(functionsDir, "package.json");

  try {
    await fs.rename(templatePackagePath, packageJsonPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await ensureExists(packageJsonPath, "functions package.json");
  }
};

export const materializeFirebaseComponentIndexArtifacts = async (
  templateDir: string,
  componentArtifacts: readonly UniversalComponentArtifact[],
): Promise<void> => {
  if (componentArtifacts.length === 0) return;
  const indexPath = path.join(templateDir, "firestore.indexes.json");
  const existingIndexes = await fs.readFile(indexPath, "utf8");
  await fs.writeFile(
    indexPath,
    mergeFirebaseComponentIndexArtifacts(existingIndexes, componentArtifacts),
  );
};

export const prepareFirebaseTemplate = async (firebaseRootDir: string) => {
  const publicDir = path.join(firebaseRootDir, "public");
  const builtFunctionsDir = path.join(firebaseRootDir, "functions");

  await ensureExists(publicDir, "public template directory");
  await ensureExists(builtFunctionsDir, "functions build directory");

  const { tmpDir, removeTmpDir } = await copyDirToTmp(publicDir);
  const functionsDir = path.join(tmpDir, "functions");

  await fs.cp(builtFunctionsDir, functionsDir, { recursive: true });
  await normalizeFunctionsPackage(functionsDir);

  return {
    tmpDir,
    removeTmpDir,
    functionsDir,
  };
};
