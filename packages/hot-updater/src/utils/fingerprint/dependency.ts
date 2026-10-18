import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getPackageManager } from "../getPackageManager";

export type ExpoFingerprint = typeof import("@expo/fingerprint");

const require = createRequire(import.meta.url);

const PACKAGE_NAME = "@expo/fingerprint";
const MISSING_DEPENDENCY_ERROR_NAME = "MissingFingerprintDependencyError";

/** The command that installs `@expo/fingerprint` with the project's package manager. */
/**
 * Installs the engine at an exact version: a range lets a later install pick
 * another version, which can change every fingerprint.
 */
export const getFingerprintDependencyInstallCommand = () => {
  switch (getPackageManager()) {
    case "pnpm":
      return `pnpm add -D --save-exact ${PACKAGE_NAME}`;
    case "yarn":
      return `yarn add -D --exact ${PACKAGE_NAME}`;
    case "bun":
      return `bun add -d --exact ${PACKAGE_NAME}`;
    default:
      return `npm install -D --save-exact ${PACKAGE_NAME}`;
  }
};

export class MissingFingerprintDependencyError extends Error {
  constructor() {
    super(
      [
        `${PACKAGE_NAME} is required for fingerprint commands but is not installed.`,
        "",
        `Install it in your app project, then re-run this command:`,
        `  ${getFingerprintDependencyInstallCommand()}`,
      ].join("\n"),
    );
    this.name = MISSING_DEPENDENCY_ERROR_NAME;
  }
}

export const createMissingFingerprintDependencyError = () =>
  new MissingFingerprintDependencyError();

export const isMissingFingerprintDependencyError = (
  error: unknown,
): error is MissingFingerprintDependencyError =>
  error instanceof Error && error.name === MISSING_DEPENDENCY_ERROR_NAME;

export const isMissingExpoFingerprintError = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;

  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    (error instanceof Error &&
      (error.message.includes("Cannot find package '@expo/fingerprint'") ||
        error.message.includes("Cannot find module '@expo/fingerprint'")))
  );
};

/**
 * The `@expo/fingerprint` an Expo SDK pins (SDK 52 and later depend on it),
 * so its hashes change only with an SDK upgrade, which needs a new build
 * anyway. Null when the project has no `expo`.
 */
const resolveSdkExpoFingerprint = (projectRoot: string): string | null => {
  let expo: string;
  try {
    expo = path.dirname(
      require.resolve("expo/package.json", {
        paths: [path.resolve(projectRoot)],
      }),
    );
  } catch {
    return null;
  }
  try {
    return require.resolve(PACKAGE_NAME, { paths: [expo] });
  } catch {
    return null;
  }
};

const resolveExpoFingerprint = (projectRoot: string): string => {
  const sdkCopy = resolveSdkExpoFingerprint(projectRoot);
  if (sdkCopy) return sdkCopy;
  try {
    return require.resolve(PACKAGE_NAME, {
      paths: [path.resolve(projectRoot)],
    });
  } catch (error) {
    if (isMissingExpoFingerprintError(error)) {
      throw createMissingFingerprintDependencyError();
    }

    throw error;
  }
};

export const loadExpoFingerprint = async (
  projectRoot: string,
): Promise<ExpoFingerprint> =>
  import(
    pathToFileURL(resolveExpoFingerprint(projectRoot)).href
  ) as Promise<ExpoFingerprint>;

/**
 * The engine fingerprint.json records for the hashes `@expo/fingerprint`
 * computes: its name and the version the project resolves, since another
 * version can hash the same project differently.
 */
export const getExpoFingerprintEngine = async (
  projectRoot: string,
): Promise<string> => {
  let dir = path.dirname(resolveExpoFingerprint(projectRoot));
  while (true) {
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(dir, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (manifest.name === PACKAGE_NAME) {
        return typeof manifest.version === "string"
          ? `${PACKAGE_NAME}@${manifest.version}`
          : PACKAGE_NAME;
      }
    } catch {
      // No readable package.json here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return PACKAGE_NAME;
    dir = parent;
  }
};
