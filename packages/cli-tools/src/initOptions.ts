import type { BuildType } from "./ConfigBuilder";

export type RunInitOptions = {
  readonly build: BuildType;
  readonly envFile?: string;
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

  const missingInputs = Object.entries(inputs)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key);

  if (missingInputs.length > 0) {
    throw new MissingInitInputsError(missingInputs);
  }
};
