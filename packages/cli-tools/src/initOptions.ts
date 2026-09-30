import type { BuildType } from "./ConfigBuilder";

export type RunInitOptions = {
  readonly build: BuildType;
  readonly envFile?: string;
  /**
   * The server definitions the other providers' inits write: one found
   * unedited is replaced, since the project is switching providers.
   */
  readonly otherServerDefinitions?: readonly string[];
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

export class LegacyInfrastructureError extends InitError {
  readonly name = "LegacyInfrastructureError";

  constructor(provider: string, resource: string) {
    super(
      `${provider} v0 infrastructure was detected at ${resource}. Hot Updater v1 cannot upgrade it in place. Run init with new provider resources and ship the new endpoint in a new native build. The existing infrastructure was not changed.`,
    );
  }
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
