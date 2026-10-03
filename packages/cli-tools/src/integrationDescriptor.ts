import type { BuildConfig } from "./ConfigBuilder";

export type IntegrationPrepareOptions = {
  readonly cwd: string;
  readonly envFile?: string;
};

export type InitIntegrationDescriptor = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly build: BuildConfig;
  readonly prepare?: (
    options: IntegrationPrepareOptions,
  ) => Promise<void> | void;
};

export function assertInitIntegrationDescriptor(
  value: unknown,
): asserts value is InitIntegrationDescriptor {
  const descriptor = value as Partial<InitIntegrationDescriptor> | null;
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    descriptor.schemaVersion !== 1 ||
    typeof descriptor.id !== "string" ||
    !descriptor.id ||
    typeof descriptor.label !== "string" ||
    !descriptor.label ||
    !Array.isArray(descriptor.dependencies) ||
    !descriptor.dependencies.every((item) => typeof item === "string") ||
    !Array.isArray(descriptor.devDependencies) ||
    !descriptor.devDependencies.every((item) => typeof item === "string") ||
    descriptor.build === undefined ||
    !Array.isArray(descriptor.build.imports) ||
    typeof descriptor.build.configString !== "string" ||
    (descriptor.prepare !== undefined &&
      typeof descriptor.prepare !== "function")
  ) {
    throw new Error(
      "The selected package does not export a valid Hot Updater integration descriptor.",
    );
  }
}
