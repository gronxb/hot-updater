import {
  getInitProviderTextPromptValues,
  getHotUpdaterEnvValue,
  MissingInitInputsError,
  p,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";

import {
  initProvider as SUPABASE_INIT_PROVIDER,
  isSupabaseRegion,
  SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY,
  SUPABASE_REGION_VALUES,
  type SupabaseRegion,
} from "./init/index";

export {
  assertSupabaseNonInteractiveInputs,
  inputSupabaseDeploymentInputs,
} from "./supabaseDeploymentInputs";

export type SupabaseInitInputs = {
  readonly accessToken?: string;
  readonly bucketName?: string;
  readonly catalogCdnUrl?: string;
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
    catalogCdnUrl: resolveInitProviderInput(existingEnv, inputs.catalogCdnUrl),
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

export const inputSupabaseDatabasePassword = async ({
  cliHandlesPrompt = false,
  databasePassword,
  nonInteractive,
  required = false,
}: {
  readonly cliHandlesPrompt?: boolean;
  readonly databasePassword?: string;
  readonly nonInteractive: boolean;
  readonly required?: boolean;
}): Promise<string> => {
  if (cliHandlesPrompt) {
    return "";
  }
  if (nonInteractive) {
    if (required && !databasePassword) {
      throw new MissingInitInputsError([
        SUPABASE_INIT_PROVIDER.inputs.databasePassword.envKey,
      ]);
    }
    return databasePassword ?? "";
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
  const defaultRegion =
    SUPABASE_INIT_PROVIDER.inputs.region.prompt.defaultValue;

  const selectedProjectName = await p.text({
    ...getInitProviderTextPromptValues(
      SUPABASE_INIT_PROVIDER.inputs.projectName.prompt,
      projectName,
    ),
    message: SUPABASE_INIT_PROVIDER.inputs.projectName.prompt.message,
    validate: (value) =>
      value ? undefined : "Supabase project name is required",
  });
  if (p.isCancel(selectedProjectName)) {
    process.exit(0);
  }

  const selectedOrganizationSlug = await p.select<string>({
    initialValue: savedOrganization?.slug ?? organizations[0]?.slug,
    message: SUPABASE_INIT_PROVIDER.inputs.organizationSlug.prompt.message,
    options: organizations.map((organization) => ({
      label: organization.name,
      value: organization.slug,
    })),
  });
  if (p.isCancel(selectedOrganizationSlug)) {
    process.exit(0);
  }

  const selectedRegion = await p.select<SupabaseRegion>({
    message: SUPABASE_INIT_PROVIDER.inputs.region.prompt.message,
    initialValue:
      region ?? (isSupabaseRegion(defaultRegion) ? defaultRegion : undefined),
    options: SUPABASE_REGION_VALUES.map((value) => ({
      label: value,
      value,
    })),
  });
  if (p.isCancel(selectedRegion)) {
    process.exit(0);
  }

  const selectedBucketName = await p.text({
    ...getInitProviderTextPromptValues(
      SUPABASE_INIT_PROVIDER.inputs.bucketName.prompt,
      bucketName,
    ),
    message: SUPABASE_INIT_PROVIDER.inputs.bucketName.prompt.message,
    validate: (value) =>
      value ? undefined : "Storage bucket name is required",
  });
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
