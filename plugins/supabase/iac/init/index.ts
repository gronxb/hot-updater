import type { InitProviderDefinition } from "@hot-updater/cli-tools";

export const SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY =
  "HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID";

export const SUPABASE_REGION_VALUES = [
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

export type SupabaseRegion = (typeof SUPABASE_REGION_VALUES)[number];

export const isSupabaseRegion = (
  value: string | undefined,
): value is SupabaseRegion =>
  value !== undefined &&
  SUPABASE_REGION_VALUES.some((region) => region === value);

export const isSupabaseFunctionName = (
  value: string | undefined,
): value is string =>
  value !== undefined && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

export const initProvider = {
  label: "Supabase",
  inputs: {
    projectId: {
      envKey: "HOT_UPDATER_SUPABASE_PROJECT_ID",
      help: "Supabase project reference",
    },
    projectName: {
      envKey: "HOT_UPDATER_SUPABASE_PROJECT_NAME",
      help: "Project name used when creating a Supabase project",
      optional: true,
      prompt: {
        defaultValue: "hot-updater",
        message: "Enter a name for the new Supabase project",
        placeholder: "hot-updater",
        type: "text",
      },
    },
    organizationSlug: {
      envKey: "HOT_UPDATER_SUPABASE_ORGANIZATION_SLUG",
      help: "Organization slug used when creating a Supabase project",
      optional: true,
      prompt: {
        message: "Select a Supabase organization",
        type: "select",
      },
    },
    region: {
      envKey: "HOT_UPDATER_SUPABASE_REGION",
      help: "Region used when creating a Supabase project",
      optional: true,
      prompt: {
        defaultValue: "us-east-1",
        message: "Select a region for the new Supabase project",
        type: "select",
      },
      validate: isSupabaseRegion,
    },
    accessToken: {
      envKey: "SUPABASE_ACCESS_TOKEN",
      help: "Supabase personal access token",
      persistence: "with-consent",
      prompt: {
        message: "Enter your Supabase personal access token",
        type: "password",
      },
    },
    bucketName: {
      envKey: "HOT_UPDATER_SUPABASE_BUCKET_NAME",
      help: "Storage bucket name",
      prompt: {
        defaultValue: "hot-updater-storage",
        message: "Enter a name for the new storage bucket",
        placeholder: "hot-updater-storage",
        type: "text",
      },
    },
    functionName: {
      envKey: "HOT_UPDATER_SUPABASE_FUNCTION_NAME",
      help: "Edge Function name",
      prompt: {
        defaultValue: "update-server",
        message: "Enter a name for the edge function",
        placeholder: "update-server",
        type: "text",
      },
      validate: isSupabaseFunctionName,
    },
    databasePassword: {
      envKey: "HOT_UPDATER_SUPABASE_DB_PASSWORD",
      help: "Database password, when required by the linked project",
      optional: true,
      persistence: "with-consent",
      prompt: {
        message:
          "Enter your Supabase database password (press Enter to skip if none)",
        type: "password",
      },
    },
  },
} as const satisfies InitProviderDefinition;
