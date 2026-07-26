import {
  assertInitInputs,
  getHotUpdaterEnvValue,
  p,
} from "@hot-updater/cli-tools";

export const SUPABASE_DATABASE_PASSWORD_ENV_KEY =
  "HOT_UPDATER_SUPABASE_DB_PASSWORD";

export type SupabaseInitInputs = {
  readonly bucketName?: string;
  readonly databasePassword?: string;
  readonly functionName?: string;
  readonly projectId?: string;
};

export const resolveSupabaseInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
  inputEnv: Readonly<Record<string, string>> = {},
): SupabaseInitInputs => ({
  bucketName: getHotUpdaterEnvValue(
    existingEnv,
    "HOT_UPDATER_SUPABASE_BUCKET_NAME",
  ),
  databasePassword:
    process.env[SUPABASE_DATABASE_PASSWORD_ENV_KEY] ??
    inputEnv[SUPABASE_DATABASE_PASSWORD_ENV_KEY],
  functionName: getHotUpdaterEnvValue(
    existingEnv,
    "HOT_UPDATER_SUPABASE_FUNCTION_NAME",
  ),
  projectId:
    getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_SUPABASE_PROJECT_ID") ??
    getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_SUPABASE_URL")?.match(
      /^https:\/\/([^.]+)\.supabase\.co/,
    )?.[1],
});

export const assertSupabaseNonInteractiveInputs = (
  inputs: SupabaseInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitInputs({
    inputs: {
      HOT_UPDATER_SUPABASE_PROJECT_ID: inputs.projectId,
      HOT_UPDATER_SUPABASE_BUCKET_NAME: inputs.bucketName,
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: inputs.functionName,
    },
    strict: nonInteractive,
  });
};

export const inputSupabaseDeploymentInputs = async ({
  databasePassword,
  functionName,
  nonInteractive,
}: SupabaseInitInputs & {
  readonly nonInteractive: boolean;
}): Promise<{
  readonly dbPassword: string;
  readonly functionName: string;
}> => {
  assertInitInputs({
    inputs: {
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: functionName,
    },
    strict: nonInteractive,
  });

  if (nonInteractive && functionName) {
    return {
      dbPassword: databasePassword ?? "",
      functionName,
    };
  }

  return p.group(
    {
      dbPassword: () =>
        databasePassword !== undefined
          ? Promise.resolve(databasePassword)
          : p.password({
              message:
                "Enter your Supabase database password (press Enter to skip if none)",
            }),
      functionName: () =>
        functionName
          ? Promise.resolve(functionName)
          : p.text({
              message: "Enter a name for the edge function",
              initialValue: "update-server",
              placeholder: "update-server",
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );
};
