import {
  assertInitInputs,
  assertInitProviderInputs,
  getHotUpdaterEnvValue,
  isSupabaseFunctionName,
  p,
  resolveInitProviderInput,
  SUPABASE_INIT_PROVIDER,
} from "@hot-updater/cli-tools";

export type SupabaseInitInputs = {
  readonly accessToken?: string;
  readonly bucketName?: string;
  readonly databasePassword?: string;
  readonly functionName?: string;
  readonly projectId?: string;
};

export const resolveSupabaseInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
): SupabaseInitInputs => {
  const { inputs } = SUPABASE_INIT_PROVIDER;
  return {
    accessToken: resolveInitProviderInput(existingEnv, inputs.accessToken),
    bucketName: resolveInitProviderInput(existingEnv, inputs.bucketName),
    databasePassword: resolveInitProviderInput(
      existingEnv,
      inputs.databasePassword,
    ),
    functionName: resolveInitProviderInput(existingEnv, inputs.functionName),
    projectId:
      resolveInitProviderInput(existingEnv, inputs.projectId) ??
      getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_SUPABASE_URL")?.match(
        /^https:\/\/([^.]+)\.supabase\.co/,
      )?.[1],
  };
};

export const assertSupabaseNonInteractiveInputs = (
  inputs: SupabaseInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitProviderInputs({
    inputs,
    provider: SUPABASE_INIT_PROVIDER,
    strict: nonInteractive,
  });
};

export const inputSupabaseDeploymentInputs = async ({
  accessToken,
  functionName,
  nonInteractive,
}: SupabaseInitInputs & {
  readonly nonInteractive: boolean;
}): Promise<{
  readonly accessToken: string;
  readonly functionName: string;
}> => {
  const { inputs } = SUPABASE_INIT_PROVIDER;
  assertInitInputs({
    inputs: {
      [inputs.accessToken.envKey]: accessToken,
      [inputs.functionName.envKey]: functionName,
    },
    strict: nonInteractive,
  });

  if (nonInteractive && accessToken && functionName) {
    return {
      accessToken,
      functionName,
    };
  }

  const savedFunctionName = isSupabaseFunctionName(functionName)
    ? functionName
    : undefined;

  return p.group(
    {
      accessToken: () =>
        accessToken
          ? Promise.resolve(accessToken)
          : p.password({
              message: inputs.accessToken.prompt.message,
              validate: (value) =>
                value ? undefined : "Supabase access token is required",
            }),
      functionName: () =>
        savedFunctionName
          ? Promise.resolve(savedFunctionName)
          : p.text({
              message: inputs.functionName.prompt.message,
              initialValue: inputs.functionName.prompt.defaultValue,
              placeholder: inputs.functionName.prompt.placeholder,
              validate: (value) =>
                isSupabaseFunctionName(value)
                  ? undefined
                  : "Start with a letter and use only letters, numbers, underscores, or hyphens",
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );
};

export const inputSupabaseDatabasePassword = async ({
  databasePassword,
  forcePrompt = false,
  nonInteractive,
}: {
  readonly databasePassword?: string;
  readonly forcePrompt?: boolean;
  readonly nonInteractive: boolean;
}): Promise<string> => {
  if (nonInteractive || (!forcePrompt && databasePassword !== undefined)) {
    return databasePassword ?? "";
  }

  const password = await p.password({
    message: SUPABASE_INIT_PROVIDER.inputs.databasePassword.prompt.message,
  });
  if (p.isCancel(password)) {
    process.exit(0);
  }
  return password;
};
