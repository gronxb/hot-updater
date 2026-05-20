import { getPackageManager } from "../getPackageManager";

export type ExpoFingerprint = typeof import("@expo/fingerprint");

const PACKAGE_NAME = "@expo/fingerprint";
const MISSING_DEPENDENCY_ERROR_NAME = "MissingFingerprintDependencyError";

const getInstallCommand = () => {
  switch (getPackageManager()) {
    case "pnpm":
      return `pnpm add -D ${PACKAGE_NAME}`;
    case "yarn":
      return `yarn add -D ${PACKAGE_NAME}`;
    case "bun":
      return `bun add -d ${PACKAGE_NAME}`;
    default:
      return `npm install -D ${PACKAGE_NAME}`;
  }
};

export class MissingFingerprintDependencyError extends Error {
  constructor() {
    super(
      [
        `${PACKAGE_NAME} is required for fingerprint commands but is not installed.`,
        "",
        `Install it in your app project, then re-run this command:`,
        `  ${getInstallCommand()}`,
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

export const loadExpoFingerprint = async (): Promise<ExpoFingerprint> => {
  try {
    return await import("@expo/fingerprint");
  } catch (error) {
    if (isMissingExpoFingerprintError(error)) {
      throw createMissingFingerprintDependencyError();
    }

    throw error;
  }
};
