import type { DatabasePlugin } from "@hot-updater/plugin-core";

import type { BuildType } from "./ConfigBuilder";

export type RunInitOptions = {
  readonly build: BuildType;
  readonly createDeploymentTarget?: (
    database: DatabasePlugin,
  ) => InitDeploymentTarget;
  readonly envFile?: string;
  readonly prepareDeployment?: (
    target: InitDeploymentTarget,
    options: { readonly envFile?: string },
  ) => Promise<readonly InitDeploymentNotice[]>;
};

export type InitDeploymentTarget = {
  readonly adapterName: string;
};

export type InitDeploymentNotice = {
  readonly message: string;
  readonly title: string;
};

export class InitError extends Error {
  readonly name: string = "InitError";
}

export class MissingInitInputsError extends InitError {
  readonly name = "MissingInitInputsError";

  constructor(readonly missingInputs: readonly string[]) {
    super(
      [
        "Init is missing required inputs:",
        ...missingInputs.map((input) => `- ${input}`),
      ].join("\n"),
    );
  }
}

export class InitEnvFileError extends InitError {
  readonly name = "InitEnvFileError";
}

export const assertInitInputs = ({
  inputs,
  strict,
}: {
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly strict?: boolean;
}): void => {
  if (!strict) {
    return;
  }

  const missingInputs = getMissingInitInputs(inputs);

  if (missingInputs.length > 0) {
    throw new MissingInitInputsError(missingInputs);
  }
};

export const getMissingInitInputs = (
  inputs: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  Object.entries(inputs)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key);
