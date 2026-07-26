import {
  assertInitInputs,
  assertInitProviderInputs,
  getHotUpdaterEnvValue,
  isSupabaseFunctionName,
  isSupabaseRegion,
  MissingInitInputsError,
  p,
  resolveInitProviderInput,
  shouldAutoSelectOnlyInitResource,
  SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY,
  SUPABASE_INIT_PROVIDER,
  SUPABASE_REGION_VALUES,
  type SupabaseRegion,
} from "@hot-updater/cli-tools";

export type SupabaseInitInputs = {
  readonly accessToken?: string;
  readonly bucketName?: string;
  readonly databasePassword?: string;
  readonly functionName?: string;
  readonly organizationSlug?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly region?: SupabaseRegion;
};

export const resolveSupabaseInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
  sources: {
    readonly inputEnv?: Readonly<Record<string, string>>;
    readonly managedEnv?: Readonly<Record<string, string>>;
  } = {},
): SupabaseInitInputs => {
  const { inputs } = SUPABASE_INIT_PROVIDER;
  const managedEnv = sources.managedEnv ?? existingEnv;
  const projectId =
    resolveInitProviderInput(existingEnv, inputs.projectId) ??
    getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_SUPABASE_URL")?.match(
      /^https:\/\/([^.]+)\.supabase\.co/,
    )?.[1];
  const databasePasswordKey = inputs.databasePassword.envKey;
  const hasProcessDatabasePassword =
    process.env[databasePasswordKey] !== undefined;
  const hasInputDatabasePassword =
    sources.inputEnv !== undefined &&
    Object.hasOwn(sources.inputEnv, databasePasswordKey);
  const managedDatabasePasswordProjectId =
    managedEnv[SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY]?.trim();
  const region = resolveInitProviderInput(existingEnv, inputs.region);
  const databasePassword = hasProcessDatabasePassword
    ? process.env[databasePasswordKey]?.trim() || undefined
    : hasInputDatabasePassword
      ? sources.inputEnv?.[databasePasswordKey]?.trim() || undefined
      : managedDatabasePasswordProjectId === projectId
        ? managedEnv[databasePasswordKey]?.trim() || undefined
        : undefined;

  return {
    accessToken: resolveInitProviderInput(existingEnv, inputs.accessToken),
    bucketName: resolveInitProviderInput(existingEnv, inputs.bucketName),
    databasePassword,
    functionName: resolveInitProviderInput(existingEnv, inputs.functionName),
    organizationSlug: resolveInitProviderInput(
      existingEnv,
      inputs.organizationSlug,
    ),
    projectId,
    projectName: resolveInitProviderInput(existingEnv, inputs.projectName),
    region: isSupabaseRegion(region) ? region : undefined,
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
  required = false,
}: {
  readonly databasePassword?: string;
  readonly forcePrompt?: boolean;
  readonly nonInteractive: boolean;
  readonly required?: boolean;
}): Promise<string> => {
  if (nonInteractive) {
    if (required && !databasePassword) {
      throw new MissingInitInputsError([
        SUPABASE_INIT_PROVIDER.inputs.databasePassword.envKey,
      ]);
    }
    return databasePassword ?? "";
  }
  if (!forcePrompt && databasePassword !== undefined) {
    return databasePassword;
  }

  const password = await p.password({
    message: SUPABASE_INIT_PROVIDER.inputs.databasePassword.prompt.message,
    validate: (value) =>
      required && !value
        ? "A database password is required to create a Supabase project"
        : undefined,
  });
  if (p.isCancel(password)) {
    process.exit(0);
  }
  return password;
};

export const inputSupabaseProjectCreationInputs = async ({
  bucketName,
  organizationSlug,
  organizations,
  projectName,
  region,
}: {
  readonly bucketName?: string;
  readonly organizationSlug?: string;
  readonly organizations: readonly {
    readonly name: string;
    readonly slug: string;
  }[];
  readonly projectName?: string;
  readonly region?: SupabaseRegion;
}): Promise<{
  readonly bucketName: string;
  readonly organizationSlug: string;
  readonly projectName: string;
  readonly region: SupabaseRegion;
}> => {
  if (organizations.length === 0) {
    throw new Error(
      "No Supabase organization is available for project creation.",
    );
  }

  const savedOrganization = organizations.find(
    (organization) => organization.slug === organizationSlug,
  );
  if (organizationSlug && !savedOrganization) {
    p.log.warn(
      "Saved Supabase organization was not found. Select an organization again.",
    );
  }
  const onlyOrganization = shouldAutoSelectOnlyInitResource({
    availableResourceCount: organizations.length,
    savedIdentifier: organizationSlug,
  })
    ? organizations[0]
    : undefined;
  const defaultRegion =
    SUPABASE_INIT_PROVIDER.inputs.region.prompt.defaultValue;

  const selectedProjectName =
    projectName ??
    (await p.text({
      message: SUPABASE_INIT_PROVIDER.inputs.projectName.prompt.message,
      defaultValue:
        SUPABASE_INIT_PROVIDER.inputs.projectName.prompt.defaultValue,
      placeholder: SUPABASE_INIT_PROVIDER.inputs.projectName.prompt.placeholder,
      validate: (value) =>
        value ? undefined : "Supabase project name is required",
    }));
  if (p.isCancel(selectedProjectName)) {
    process.exit(0);
  }

  const selectedOrganizationSlug =
    savedOrganization?.slug ??
    onlyOrganization?.slug ??
    (await p.select<string>({
      message: SUPABASE_INIT_PROVIDER.inputs.organizationSlug.prompt.message,
      options: organizations.map((organization) => ({
        label: organization.name,
        value: organization.slug,
      })),
    }));
  if (p.isCancel(selectedOrganizationSlug)) {
    process.exit(0);
  }

  const selectedRegion =
    region ??
    (await p.select<SupabaseRegion>({
      message: SUPABASE_INIT_PROVIDER.inputs.region.prompt.message,
      initialValue: isSupabaseRegion(defaultRegion) ? defaultRegion : undefined,
      options: SUPABASE_REGION_VALUES.map((value) => ({
        label: value,
        value,
      })),
    }));
  if (p.isCancel(selectedRegion)) {
    process.exit(0);
  }

  const selectedBucketName =
    bucketName ??
    (await p.text({
      message: SUPABASE_INIT_PROVIDER.inputs.bucketName.prompt.message,
      validate: (value) =>
        value ? undefined : "Storage bucket name is required",
    }));
  if (p.isCancel(selectedBucketName)) {
    process.exit(0);
  }

  return {
    bucketName: selectedBucketName,
    organizationSlug: selectedOrganizationSlug,
    projectName: selectedProjectName,
    region: selectedRegion,
  };
};
